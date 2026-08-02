// 삼전 피셔F rebox 단독 실측 (사용자 제안 2026-08-02 밤 — "10시 이후엔 그때 축적되는 OR, 그 전엔 08시 것"):
//   npx tsx scripts/ss-f-rebox-sweep.ts
// 지난 피셔 변경 실험(ss-fisher-mod-cw)은 박스+확인봉+완충 동시 변경이라 원인 미분리 —
// 이번엔 rebox만 단독으로: 현행(08 OR 고정) vs 09:30~45박스@09:45(하닉식) vs 09:45~10:00박스@10:00(사용자안).
// 상태 승계·카운터 리셋(라이브 runFisher rebox 옵션 그대로). 다른 파라미터 전부 현행.
// 측정: F 단독(첫판정·스탑 -1.5·종가보유) + v2 결합(6봉 주기준·F 첫확인 심판) + F 첫확인 시각.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { runFisher, type FisherCfg } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { unitArr } from "../lib/predict/candleWindow";
import { cumStream } from "../lib/predict/ssV2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const fmtT = (m: number) => Number.isNaN(m) ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Dir = 1 | -1;
const STOP = 1.5;
const C = PREDICT_CONFIG;

function tranche(bars: MinuteBar[], close: number, i0: number, dir: Dir, px: number, size: number, forceI?: number, forcePx?: number): { pnl: number; cut: boolean } {
  if (size <= 0) return { pnl: 0, cut: false };
  const s = STOP / 100;
  const lim = forceI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return { pnl: -STOP * size, cut: true };
  }
  const px2 = forceI !== undefined ? (forcePx ?? close) : close;
  return { pnl: ((px2 - px) / px) * 100 * dir * size, cut: false };
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("005930", 500)).filter((b) => b.date < today);
  type D = { bars: MinuteBar[]; r10: number; close: number; hist: PredictDailyBar[]; date: string; cw: { i: number; t: number; dir: Dir; px: number } | null };
  const days: D[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trs = cumStream(bars, unitArr(bars, r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    days.push({
      bars, r10, close: daily[i].close, hist, date: daily[i].date,
      cw: trs.length ? { i: trs[0].i, t: tMin(bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px } : null,
    });
  }

  const F_BASE: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const variants: [string, FisherCfg][] = [
    ["현행 (08 OR 고정)              ", F_BASE],
    ["09:30~45 박스, 09:45부터(하닉식)", { ...F_BASE, reboxHHMM: "09:30", reboxMinutes: 15 }],
    ["09:45~10:00 박스, 10:00부터     ", { ...F_BASE, reboxHHMM: "09:45", reboxMinutes: 15 }],
  ];

  console.log(`════ 삼전 피셔F rebox 단독 스윕 — ${days.length}일 (v2 = 6봉·1.0 주기준) ════`);
  for (const [label, cfg] of variants) {
    let fN = 0, fWins = 0, fCuts = 0, fSum = 0, v2 = 0, v2Worst = 0, v2Cut = 0, oppN = 0;
    const firsts: number[] = [];
    for (const d of days) {
      const fTrs = runFisher({ date: d.date, dailyHistory: d.hist, openPx: d.bars[0].open, morning: d.bars, prevDayMinutes: null }, cfg).transitions ?? [];
      const fIdx = fTrs.length ? d.bars.findIndex((b) => b.time === fTrs[0].time) : -1;
      const fJ = fTrs.length && fIdx >= 0 ? { i: fIdx, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as Dir, px: fTrs[0].px } : null;
      if (fJ) {
        fN++;
        firsts.push(fJ.t);
        const r = tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 1);
        fSum += r.pnl;
        if (r.cut) fCuts++;
        if (r.pnl > 0) fWins++;
      }
      // v2 (6봉 창 + F 심판)
      const cw = d.cw;
      let p = 0, c = false;
      const add = (r: { pnl: number; cut: boolean }) => { p += r.pnl; c = c || r.cut; };
      const fFirst = fJ && (!cw || fJ.t < cw.t);
      if (fFirst && fJ) {
        const opp = cw && cw.dir !== fJ.dir;
        add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw!.i : undefined, opp ? cw!.px : undefined));
        if (cw && cw.dir === fJ.dir) add(tranche(d.bars, d.close, cw.i, fJ.dir, cw.px, 0.7));
        if (opp && cw) add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0));
      } else if (cw) {
        const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
        if (fOpp) oppN++;
        add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0, fOpp?.i, fOpp?.px));
        if (fOpp) add(tranche(d.bars, d.close, fOpp.i, fOpp.dir, fOpp.px, 1.0));
      }
      v2 += p; v2Worst = Math.min(v2Worst, p); if (c) v2Cut++;
    }
    console.log(`${label}: F단독 ${s1(fSum)}%p·승률 ${fN ? Math.round((100 * fWins) / fN) : 0}%·컷 ${fCuts}·판정 ${fN}일·첫확인 ${fmtT(med(firsts))} │ v2 ${s1(v2)}%p·최악 ${v2Worst.toFixed(2)}%·컷일 ${v2Cut}·역진입 ${oppN}일`);
  }
  console.log(`\n주: rebox = 라이브 runFisher 옵션(상태 승계·카운터 리셋) — F가 박스 완성 전에 이미 확인한 날은 변화 없음.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
