// 삼전 창(누적 순전진 1.0) 진입 시점에 하닉 피셔 판정(본→M→F 우선)을 게이트로 (사용자 제안 2026-08-02 밤):
//   npx tsx scripts/ss-cw-hanik-gate.ts
// 삼전 창 첫판정 시각 t에 하닉의 상태를 본피셔→M→F 순으로 조회(먼저 판정 있는 계층 채택):
//   동의(같은 방향)/반대/무판정 분포와 케이스별 삼전 창 성적 → 게이트 규칙 실측:
//   A) 하닉 반대면 진입 스킵  B) 하닉 동의일만 진입  C) v2(F역진입)에 A 게이트 결합
// 하닉 계층은 라이브 cfg 그대로 (본: 09창·sb0.1·트레일 0.35×5 전일 / M: 08창·0.10·8봉·×1.25 / F: 0.05·4봉·sb0.1·×3).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
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

  type G = { n: number; cw: number; v2: number };
  const groups: Record<string, G> = { 동의: { n: 0, cw: 0, v2: 0 }, 반대: { n: 0, cw: 0, v2: 0 }, 무판정: { n: 0, cw: 0, v2: 0 }, 창없음: { n: 0, cw: 0, v2: 0 } };
  let days = 0;

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
    const r10hx = avgRange(hxHist, 10);
    if (!ssReg || ssReg.length < 240 || !hxReg || hxReg.length < 240 || r10ss === null || r10hx === null) continue;
    days++;
    const ssBars = [...(ssPre ?? []), ...ssReg];
    const hxBars = [...(hxPre ?? []), ...hxReg];
    const close = ssDaily[i].close;

    const trs = streamCum(ssBars, unitArr(ssBars, r10ss), 1.0);
    const cw = trs.length ? { i: trs[0].i, t: tMin(ssBars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, to: trs[0].to, px: trs[0].px } : null;
    if (!cw) { groups["창없음"].n++; continue; }

    // 하닉 계층 전이 (라이브 cfg)
    const mk = (bars: MinuteBar[], hist: PredictDailyBar[], cfg: FisherCfg) =>
      (runFisher({ date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, cfg).transitions ?? []);
    const hxB = hxReg.length >= 20 ? mk(hxReg, hxHist, { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes }) : [];
    const hxM = mk(hxBars, hxHist, M_HX);
    const hxF = mk(hxBars, hxHist, F_HX);
    // 본 → M → F 우선 (사용자 지정)
    let hxSt: "none" | "up" | "down" = stateAt(hxB, cw.t);
    if (hxSt === "none") hxSt = stateAt(hxM, cw.t);
    if (hxSt === "none") hxSt = stateAt(hxF, cw.t);
    const g = hxSt === "none" ? "무판정" : hxSt === cw.to ? "동의" : "반대";
    groups[g].n++;

    const cwPnl = tranche(ssBars, close, cw.i, cw.dir, cw.px, 1);
    groups[g].cw += cwPnl;

    // v2 (삼전 F 역진입 — 기존 규칙)
    const fOut = runFisher({ date, dailyHistory: ssHist, openPx: ssBars[0].open, morning: ssBars, prevDayMinutes: null }, F_SS);
    const fTrs = fOut.transitions ?? [];
    const idx = new Map<string, number>();
    ssBars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });
    const fJ = fTrs.length && idx.has(fTrs[0].time) ? { i: idx.get(fTrs[0].time)!, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    let v2 = 0;
    if (fJ && fJ.t < cw.t) {
      const opp = cw.dir !== fJ.dir;
      v2 += tranche(ssBars, close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw.i : undefined, opp ? cw.px : undefined);
      if (!opp) v2 += tranche(ssBars, close, cw.i, fJ.dir, cw.px, 0.7);
      else v2 += tranche(ssBars, close, cw.i, cw.dir, cw.px, 1.0);
    } else {
      const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
      v2 += tranche(ssBars, close, cw.i, cw.dir, cw.px, 1.0, fOpp?.i, fOpp?.px);
      if (fOpp) v2 += tranche(ssBars, close, fOpp.i, fOpp.dir, fOpp.px, 1.0);
    }
    groups[g].v2 += v2;
  }

  console.log(`════ 삼전 창(1.0) 진입 시점의 하닉 피셔 게이트 (본→M→F) — 공통 ${days}일 ════`);
  for (const [name, g] of Object.entries(groups)) {
    if (name === "창없음") { if (g.n) console.log(`창없음: ${g.n}일`); continue; }
    console.log(`하닉 ${name}: ${g.n}일 · 삼전 창 단독 ${s1(g.cw)}%p · v2 ${s1(g.v2)}%p`);
  }
  const all = groups["동의"], opp = groups["반대"], none = groups["무판정"];
  console.log(`\n[게이트 규칙 실측 — 창 단독 기준]`);
  console.log(`기준(게이트 없음):        ${s1(all.cw + opp.cw + none.cw)}%p`);
  console.log(`A 하닉 반대면 스킵:       ${s1(all.cw + none.cw)}%p (반대 ${opp.n}일 제외)`);
  console.log(`B 하닉 동의일만 진입:     ${s1(all.cw)}%p (${all.n}일만)`);
  console.log(`[v2 기준]`);
  console.log(`기준(게이트 없음):        ${s1(all.v2 + opp.v2 + none.v2)}%p`);
  console.log(`C 하닉 반대면 그날 스킵:  ${s1(all.v2 + none.v2)}%p`);
}
main().catch((e) => { console.error(e); process.exit(1); });
