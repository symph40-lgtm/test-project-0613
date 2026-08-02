// 삼전 창 크기 민감도 — 누적 순전진 창 3·4·5·6봉 (사용자 제안 2026-08-02 밤 "5개로 하면 어떨까"):
//   npx tsx scripts/ss-cw-winsize-sweep.ts
// 창 n봉 = (n-1)쌍, 판정 = 첫→끝 몸통중간 전진 ≥ tan × 눈금 × (n-1). 쌍당 요구 속도는 동일(45°) —
// 창이 클수록 더 길게 지속돼야 판정 = 정확도↑·지연↑. 단독·v2(F 역진입) 결합 모두 실측.

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
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Dir = 1 | -1;
const STOP = 1.5;
const C = PREDICT_CONFIG;

function cumStreamN(bars: MinuteBar[], unit: number[], tanA: number, n: number): { i: number; to: "up" | "down"; px: number }[] {
  const out: { i: number; to: "up" | "down"; px: number }[] = [];
  const w = n - 1;
  let st: "none" | "up" | "down" = "none";
  for (let t = w; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - w])) * dir >= tanA * unit[t - w] * w) { judged = dir === 1 ? "up" : "down"; break; }
    }
    if (!judged) continue;
    if (st === "none" || judged !== st) { st = judged; out.push({ i: t, to: st, px: bars[t].close }); }
  }
  return out;
}
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
  const fCfg: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  type D = { bars: MinuteBar[]; r10: number; close: number; fJ: { i: number; t: number; dir: Dir; px: number } | null };
  const days: D[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist: PredictDailyBar[] = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const fTrs = runFisher({ date: daily[i].date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, fCfg).transitions ?? [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    days.push({ bars, r10, close: daily[i].close, fJ: fTrs.length && fIdx >= 0 ? { i: fIdx, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as Dir, px: fTrs[0].px } : null });
  }
  console.log(`════ 삼전 창 크기 스윕 — 누적 순전진·쌍당 45°(tan 1.0) · ${days.length}일 ════`);
  for (const n of [3, 4, 5, 6]) {
    let entries = 0, wins = 0, cuts = 0, solo = 0, v2 = 0, v2Worst = 0, v2Cut = 0;
    const firsts: number[] = [];
    for (const d of days) {
      const unit = unitArr(d.bars, d.r10);
      const trs = cumStreamN(d.bars, unit, 1.0, n);
      const cw = trs.length ? { i: trs[0].i, t: tMin(d.bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px } : null;
      if (cw) {
        entries++;
        firsts.push(cw.t);
        const r = tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1);
        solo += r.pnl;
        if (r.cut) cuts++;
        if (r.pnl > 0) wins++;
      }
      // v2
      let p = 0, c = false;
      const add = (r: { pnl: number; cut: boolean }) => { p += r.pnl; c = c || r.cut; };
      const fJ = d.fJ;
      const fFirst = fJ && (!cw || fJ.t < cw.t);
      if (fFirst && fJ) {
        const opp = cw && cw.dir !== fJ.dir;
        add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw!.i : undefined, opp ? cw!.px : undefined));
        if (cw && cw.dir === fJ.dir) add(tranche(d.bars, d.close, cw.i, fJ.dir, cw.px, 0.7));
        if (opp && cw) add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0));
      } else if (cw) {
        const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
        add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0, fOpp?.i, fOpp?.px));
        if (fOpp) add(tranche(d.bars, d.close, fOpp.i, fOpp.dir, fOpp.px, 1.0));
      }
      v2 += p; v2Worst = Math.min(v2Worst, p); if (c) v2Cut++;
    }
    console.log(`${n}봉(${n - 1}쌍): 단독 ${s1(solo)}%p·승률 ${entries ? Math.round((100 * wins) / entries) : 0}%·컷 ${cuts}·판정 ${entries}일·첫판정 ${fmtT(med(firsts))} │ v2 ${s1(v2)}%p·최악 ${v2Worst.toFixed(2)}%·컷일 ${v2Cut}${n === 4 ? "  ← 현행" : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
