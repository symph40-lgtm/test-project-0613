// v2(창+F역진입)의 손익을 찐레그일(스윙≥5%)/비해당일로 분해 (사용자 질문 2026-08-02 밤):
//   npx tsx scripts/ss-v2-swing-split.ts
// 질문: 창 단독 1.0의 비해당일 -23.8을 피셔(F 반대 역진입)가 축소해 주는가? 1.0 vs 1.2 비교.

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
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Tr = { i: number; to: "up" | "down"; px: number };
const STOP = 1.5;
const C = PREDICT_CONFIG;

function streamCum(bars: MinuteBar[], unit: number[], tanA: number): Tr[] {
  const out: Tr[] = [];
  let st: "none" | "up" | "down" = "none";
  for (let t = 3; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - 3])) * dir >= tanA * unit[t - 3] * 3) { judged = dir === 1 ? "up" : "down"; break; }
    }
    if (!judged) continue;
    if (st === "none" || judged !== st) { st = judged; out.push({ i: t, to: st, px: bars[t].close }); }
  }
  return out;
}
function daySwing(bars: MinuteBar[]): number {
  let minLow = Infinity, maxHigh = -Infinity, up = 0, dn = 0;
  for (const b of bars) {
    minLow = Math.min(minLow, b.low);
    maxHigh = Math.max(maxHigh, b.high);
    up = Math.max(up, ((b.high - minLow) / minLow) * 100);
    dn = Math.max(dn, ((maxHigh - b.low) / maxHigh) * 100);
  }
  return Math.max(up, dn);
}
function tranche(bars: MinuteBar[], close: number, i0: number, dir: 1 | -1, px: number, size: number, forceI?: number, forcePx?: number): { pnl: number; cut: boolean } {
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
  const F_SS: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  type Row = { cwBig: number; cwSmall: number; v2Big: number; v2Small: number; reBig: number; reSmall: number; nBig: number; nSmall: number };
  const rows = new Map<number, Row>([[1.0, { cwBig: 0, cwSmall: 0, v2Big: 0, v2Small: 0, reBig: 0, reSmall: 0, nBig: 0, nSmall: 0 }], [1.2, { cwBig: 0, cwSmall: 0, v2Big: 0, v2Small: 0, reBig: 0, reSmall: 0, nBig: 0, nSmall: 0 }]]);
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist: PredictDailyBar[] = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const close = daily[i].close;
    const big = daySwing(bars) >= 5;
    const unit = unitArr(bars, r10);
    const fOut = runFisher({ date: daily[i].date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, F_SS);
    const fTrs = fOut.transitions ?? [];
    const idx = new Map<string, number>();
    bars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });
    const fJ = fTrs.length && idx.has(fTrs[0].time) ? { i: idx.get(fTrs[0].time)!, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    for (const tanA of [1.0, 1.2]) {
      const r = rows.get(tanA)!;
      const trs = streamCum(bars, unit, tanA);
      const cw = trs.length ? { i: trs[0].i, t: tMin(bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
      // 창 단독
      const cwPnl = cw ? tranche(bars, close, cw.i, cw.dir, cw.px, 1).pnl : 0;
      // v2 (창선행 100% → F반대 청산+역진입 / F선행 희귀 케이스는 hier-cases와 동일)
      let v2Pnl = 0, rePnl = 0; // rePnl = 그중 역진입 트랜치 기여
      const fFirst = fJ && (!cw || fJ.t < cw.t);
      if (fFirst && fJ) {
        const opp = cw && cw.dir !== fJ.dir;
        v2Pnl += tranche(bars, close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw!.i : undefined, opp ? cw!.px : undefined).pnl;
        if (cw && cw.dir === fJ.dir) v2Pnl += tranche(bars, close, cw.i, fJ.dir, cw.px, 0.7).pnl;
        if (opp && cw) v2Pnl += tranche(bars, close, cw.i, cw.dir, cw.px, 1.0).pnl;
      } else if (cw) {
        const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
        v2Pnl += tranche(bars, close, cw.i, cw.dir, cw.px, 1.0, fOpp?.i, fOpp?.px).pnl;
        if (fOpp) { const re = tranche(bars, close, fOpp.i, fOpp.dir, fOpp.px, 1.0).pnl; v2Pnl += re; rePnl = re; }
      }
      if (big) { r.cwBig += cwPnl; r.v2Big += v2Pnl; r.reBig += rePnl; r.nBig++; }
      else { r.cwSmall += cwPnl; r.v2Small += v2Pnl; r.reSmall += rePnl; r.nSmall++; }
    }
  }
  for (const [tanA, r] of rows) {
    console.log(`\n════ 문턱 ${tanA.toFixed(1)} — 찐레그(스윙≥5%) ${r.nBig}일 / 비해당 ${r.nSmall}일 ════`);
    console.log(`창 단독: 찐레그 ${s1(r.cwBig)} · 비해당 ${s1(r.cwSmall)} · 전체 ${s1(r.cwBig + r.cwSmall)}%p`);
    console.log(`v2     : 찐레그 ${s1(r.v2Big)} · 비해당 ${s1(r.v2Small)} · 전체 ${s1(r.v2Big + r.v2Small)}%p`);
    console.log(`  └ 역진입 트랜치 기여: 찐레그 ${s1(r.reBig)} · 비해당 ${s1(r.reSmall)}`);
    console.log(`  └ 피셔 결합의 비해당일 개선: ${s1(r.v2Small - r.cwSmall)}%p`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
