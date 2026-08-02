// 하닉 피셔를 삼전 창의 '나중 심판'으로 (사용자 지시 2026-08-02 밤 "실측해줘"):
//   npx tsx scripts/ss-cw-hanik-verifier.ts
// 공통: 삼전 창(누적 순전진 1.0) 첫판정 100% 진입·스탑 -1.5%·종가청산.
// 심판 = 보유 중 반대 방향 확인 시 잔여 청산 + 그 방향 100% 역진입 (v2와 동일 골격):
//   v2) 삼전 F 단독 심판 (기준 +101.2)
//   D1) 하닉 통합(매분 본→M→F 우선 상태) 단독 심판
//   D2) 두 심판 중 먼저 반대 확인한 쪽
//   D3) 합의제 — 둘 다 반대일 때만 (늦은 쪽 시각)
// + 발생일수·시차(하닉 vs 삼전 F 반대 확인) 통계.

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
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Tr = { time: string; to: "up" | "down"; px: number };
const STOP = 1.5;
const C = PREDICT_CONFIG;

function streamCum(bars: MinuteBar[], unit: number[], tanA: number): { i: number; to: "up" | "down"; px: number }[] {
  const out: { i: number; to: "up" | "down"; px: number }[] = [];
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
const stateAt = (trs: Tr[], tmin: number): "none" | "up" | "down" => {
  let st: "none" | "up" | "down" = "none";
  for (const t of trs) { if (tMin(t.time) <= tmin) st = t.to; else break; }
  return st;
};
function tranche(bars: MinuteBar[], close: number, i0: number, dir: 1 | -1, px: number, size: number, forceI?: number, forcePx?: number): number {
  if (size <= 0) return 0;
  const s = STOP / 100;
  const lim = forceI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return -STOP * size;
  }
  const px2 = forceI !== undefined ? (forcePx ?? close) : close;
  return ((px2 - px) / px) * 100 * dir * size;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const ssDaily = (await fetchDailyPredict("005930", 500)).filter((b) => b.date < today);
  const hxDaily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  const hxIdx = new Map(hxDaily.map((b, i) => [b.date, i]));
  const F_SS: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const F_HX: FisherCfg = { ...F_SS, strongBreakRatio: C.earlyStrongBreakRatio };
  const M_HX: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };

  let days = 0, v2T = 0, d1T = 0, d2T = 0, d3T = 0, cwT = 0;
  let fOppN = 0, hxOppN = 0, bothN = 0;
  const leadHxF: number[] = []; // 하닉 반대시각 - 삼전F 반대시각 (분, 음수 = 하닉이 빠름)

  for (let i = 130; i < ssDaily.length; i++) {
    const date = ssDaily[i].date;
    const hi = hxIdx.get(date);
    if (hi === undefined || hi < 130) continue;
    const ssReg = rc(`005930-${date}.json`);
    const ssPre = rc(`005930NX-${date}.json`);
    const hxReg = rc(`000660-${date}.json`);
    const hxPre = rc(`000660NX-${date}.json`);
    const ssHist: PredictDailyBar[] = ssDaily.slice(Math.max(0, i - 120), i);
    const hxHist: PredictDailyBar[] = hxDaily.slice(Math.max(0, hi - 120), hi);
    const r10ss = avgRange(ssHist, 10);
    if (!ssReg || ssReg.length < 240 || !hxReg || hxReg.length < 240 || r10ss === null || avgRange(hxHist, 10) === null) continue;
    days++;
    const ssBars = [...(ssPre ?? []), ...ssReg];
    const hxBars = [...(hxPre ?? []), ...hxReg];
    const close = ssDaily[i].close;

    const trs = streamCum(ssBars, unitArr(ssBars, r10ss), 1.0);
    const cw = trs.length ? { i: trs[0].i, t: tMin(ssBars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, to: trs[0].to, px: trs[0].px } : null;
    if (!cw) continue;
    cwT += tranche(ssBars, close, cw.i, cw.dir, cw.px, 1);

    const idx = new Map<string, number>();
    ssBars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });

    // 심판 1: 삼전 F 첫확인이 반대인 경우 (v2 규칙 그대로 — 첫판정 기준)
    const fOut = runFisher({ date, dailyHistory: ssHist, openPx: ssBars[0].open, morning: ssBars, prevDayMinutes: null }, F_SS);
    const fTrs = fOut.transitions ?? [];
    const fJ = fTrs.length && idx.has(fTrs[0].time) ? { i: idx.get(fTrs[0].time)!, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    const fOpp = fJ && fJ.dir !== cw.dir && fJ.t > cw.t ? fJ : null;

    // 심판 2: 하닉 통합 상태(매분 본→M→F) — 창 진입 후 첫 반대 시각
    const mk = (bars: MinuteBar[], hist: PredictDailyBar[], cfg: FisherCfg) =>
      (runFisher({ date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, cfg).transitions ?? []);
    const hxB = mk(hxReg, hxHist, { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes });
    const hxM = mk(hxBars, hxHist, M_HX);
    const hxF = mk(hxBars, hxHist, F_HX);
    let hxOpp: { i: number; t: number; dir: 1 | -1; px: number } | null = null;
    for (let k = cw.i + 1; k < ssBars.length; k++) {
      const tm = tMin(ssBars[k].time);
      let st = stateAt(hxB, tm);
      if (st === "none") st = stateAt(hxM, tm);
      if (st === "none") st = stateAt(hxF, tm);
      if (st !== "none" && st !== cw.to) { hxOpp = { i: k, t: tm, dir: st === "up" ? 1 : -1, px: ssBars[k].close }; break; }
    }

    if (fOpp) fOppN++;
    if (hxOpp) hxOppN++;
    if (fOpp && hxOpp) { bothN++; leadHxF.push(hxOpp.t - fOpp.t); }

    const run = (opp: { i: number; t: number; dir: 1 | -1; px: number } | null): number => {
      let p = tranche(ssBars, close, cw.i, cw.dir, cw.px, 1.0, opp?.i, opp?.px);
      if (opp) p += tranche(ssBars, close, opp.i, opp.dir, opp.px, 1.0);
      return p;
    };
    v2T += run(fOpp);
    d1T += run(hxOpp);
    const first = fOpp && hxOpp ? (fOpp.t <= hxOpp.t ? fOpp : hxOpp) : fOpp ?? hxOpp;
    d2T += run(first);
    const both = fOpp && hxOpp ? (fOpp.t >= hxOpp.t ? fOpp : hxOpp) : null; // 합의 완성 = 늦은 쪽
    d3T += run(both);
  }

  console.log(`════ 하닉 피셔 = 삼전 창의 나중 심판 — 공통 ${days}일 (창 1.0·역진입 골격 동일) ════`);
  console.log(`창 단독(심판 없음):            ${s1(cwT)}%p`);
  console.log(`v2  삼전 F 단독 심판:          ${s1(v2T)}%p · 반대 확인 ${fOppN}일`);
  console.log(`D1  하닉 통합 단독 심판:        ${s1(d1T)}%p · 반대 확인 ${hxOppN}일`);
  console.log(`D2  둘 중 먼저 반대한 쪽:       ${s1(d2T)}%p`);
  console.log(`D3  합의제(둘 다 반대 시):      ${s1(d3T)}%p · 양쪽 모두 반대 ${bothN}일`);
  console.log(`시차(양쪽 반대 ${bothN}일): 하닉-삼전F 중앙 ${Number.isNaN(med(leadHxF)) ? "—" : `${med(leadHxF) >= 0 ? "+" : ""}${med(leadHxF)}분`} (음수 = 하닉이 빠름)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
