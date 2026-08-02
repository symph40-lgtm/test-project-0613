// 삼전 6봉 시가·종가 계단 창모델 × 피셔 결합 (사용자 설계 2026-08-02 밤):
//   npx tsx scripts/ss-cw6-oc-strict.ts
// 창 스펙 (사용자 지정): 6봉 창(인접 5쌍) — 뒷봉의 시가와 종가 모두 앞봉 몸통(시가~종가)의
//   위쪽 2/3 지점 이상(하락 대칭 1/3 이하) · skip 1개 허용(우측 7번봉 보충) · 양봉 ≥5/6(역색 ≤1, 원창 기준).
//   각도·순전진·되돌림·두께 조건 없음.
// 결합: 현행 피셔F(라이브 미러)와 케이스 분해 + v2(창선행 100% → F반대 청산+역진입)·v3b(50%→100%).
// 대조: 누적 순전진 1.0 창 기준 — 창 단독 +82.0·v2 +101.2·v3b +81.7 (232일).

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
type Tr = { i: number; to: "up" | "down"; px: number };
const STOP = 1.5;
const C = PREDICT_CONFIG;

function linkOk(base: MinuteBar, cand: MinuteBar, dir: Dir): boolean {
  const bLo = Math.min(base.open, base.close), bHi = Math.max(base.open, base.close);
  const thr = dir === 1 ? bLo + (2 / 3) * (bHi - bLo) : bLo + (1 / 3) * (bHi - bLo);
  return dir === 1 ? cand.open >= thr && cand.close >= thr : cand.open <= thr && cand.close <= thr;
}

// 6봉 체인 · skip ≤1 (우측 보충 — 하닉 buildChain 규약에서 skip 한도만 1로)
function judge6oc(bars: MinuteBar[], i: number, dir: Dir): number | null {
  let poolLen = 6;
  if (i + poolLen > bars.length) return null;
  const chain = [i];
  let skips = 0;
  let j = i + 1;
  while (chain.length < 6) {
    if (j >= i + poolLen) return null;
    if (linkOk(bars[chain[chain.length - 1]], bars[j], dir)) chain.push(j);
    else {
      skips++;
      if (skips > 1) return null;
      if (poolLen < 7 && i + poolLen < bars.length) poolLen++;
    }
    j++;
  }
  // 양봉 ≥5 (역색 ≤1) — 원창 6봉 기준 (하닉 원창 규약 동일)
  let wrong = 0;
  for (let k = i; k < i + 6; k++) {
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrong++;
  }
  if (wrong > 1) return null;
  return chain[5];
}

function stream6oc(bars: MinuteBar[]): Tr[] {
  const out: Tr[] = [];
  let st: "none" | "up" | "down" = "none";
  for (let t = 5; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      for (const start of [t - 6, t - 5]) {
        if (start < 0) continue;
        if (judge6oc(bars, start, dir) === t) { judged = dir === 1 ? "up" : "down"; break; }
      }
      if (judged) break;
    }
    if (!judged) continue;
    if (st === "none" || judged !== st) { st = judged; out.push({ i: t, to: st, px: bars[t].close }); }
  }
  return out;
}

type DayD = { date: string; bars: MinuteBar[]; r10: number; close: number; hist: PredictDailyBar[] };

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
  const days: DayD[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    days.push({ date: daily[i].date, bars: [...(pre ?? []), ...reg], r10, close: daily[i].close, hist });
  }
  const F_CUR: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };

  type Case = { n: number; leads: number[]; cwPnl: number; cwCut: number };
  const cases: Record<string, Case> = { 공통: { n: 0, leads: [], cwPnl: 0, cwCut: 0 }, 이견: { n: 0, leads: [], cwPnl: 0, cwCut: 0 }, F만: { n: 0, leads: [], cwPnl: 0, cwCut: 0 }, 창만: { n: 0, leads: [], cwPnl: 0, cwCut: 0 }, 무: { n: 0, leads: [], cwPnl: 0, cwCut: 0 } };
  let cwEntries = 0, cwWins = 0, cwCuts = 0, cwSum = 0, trTotal = 0;
  const firsts: number[] = [];
  let v2 = 0, v2Worst = 0, v2Cut = 0, v3b = 0, v3bWorst = 0, v3bCut = 0;
  const v2Case: Record<string, number> = { 공통: 0, 이견: 0, F만: 0, 창만: 0, 무: 0 };

  for (const d of days) {
    const trs = stream6oc(d.bars);
    trTotal += trs.length;
    const cw = trs.length ? { i: trs[0].i, t: tMin(d.bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px } : null;
    const fOut = runFisher({ date: d.date, dailyHistory: d.hist, openPx: d.bars[0].open, morning: d.bars, prevDayMinutes: null }, F_CUR);
    const fTrs = fOut.transitions ?? [];
    const idx = new Map<string, number>();
    d.bars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });
    const fJ = fTrs.length && idx.has(fTrs[0].time) ? { i: idx.get(fTrs[0].time)!, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as Dir, px: fTrs[0].px } : null;
    const cat = fJ && cw ? (fJ.dir === cw.dir ? "공통" : "이견") : fJ ? "F만" : cw ? "창만" : "무";
    cases[cat].n++;
    if (fJ && cw) cases[cat].leads.push(cw.t - fJ.t);
    if (cw) {
      cwEntries++;
      firsts.push(cw.t);
      const r = tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1);
      cwSum += r.pnl;
      cases[cat].cwPnl += r.pnl;
      if (r.cut) { cwCuts++; cases[cat].cwCut++; }
      if (r.pnl > 0) cwWins++;
    }
    const fFirst = fJ && (!cw || fJ.t < cw.t);
    { // v2
      let p = 0, c = false;
      const add = (r: { pnl: number; cut: boolean }) => { p += r.pnl; c = c || r.cut; };
      if (fFirst && fJ) {
        const opp = cw && cw.dir !== fJ.dir;
        add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw!.i : undefined, opp ? cw!.px : undefined));
        if (cw && cw.dir === fJ.dir) add(tranche(d.bars, d.close, cw.i, fJ.dir, cw.px, 0.7));
        if (opp && cw) add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0));
      } else if (cw) {
        const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
        add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0, fOpp?.i, fOpp?.px));
        if (fOpp) add(tranche(d.bars, d.close, fOpp.i, fOpp.dir, fOpp.px, 1.0));
      } else if (fJ) {
        add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 1.0)); // 창 무판정일 F 단독 (참고 규칙)
      }
      v2 += p; v2Worst = Math.min(v2Worst, p); if (c) v2Cut++;
      v2Case[cat] += p;
    }
    { // v3b
      let p = 0, c = false;
      const add = (r: { pnl: number; cut: boolean }) => { p += r.pnl; c = c || r.cut; };
      if (fFirst && fJ) add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 1.0));
      else if (cw) {
        const fSame = fJ && fJ.dir === cw.dir ? fJ : null;
        const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
        add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 0.5, fOpp?.i, fOpp?.px));
        if (fSame) add(tranche(d.bars, d.close, fSame.i, cw.dir, fSame.px, 0.5));
        if (fOpp) add(tranche(d.bars, d.close, fOpp.i, fOpp.dir, fOpp.px, 1.0));
      } else if (fJ) add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 1.0));
      v3b += p; v3bWorst = Math.min(v3bWorst, p); if (c) v3bCut++;
    }
  }

  console.log(`════ 삼전 6봉 시가·종가 계단 창 (skip1·양봉≥5) — ${days.length}일 ════`);
  console.log(`창 단독: 판정 ${cwEntries}일·전이 ${trTotal} · 승률 ${cwEntries ? Math.round((100 * cwWins) / cwEntries) : 0}%·컷 ${cwCuts} · 종가보유 ${s1(cwSum)}%p · 첫판정중앙 ${fmtT(med(firsts))}`);
  console.log(`(대조: 누적 순전진 1.0 창 — 판정 232일·+82.0·승률 43% / 무신호 편향 +51.6)`);
  console.log(`\n[케이스 분해 — 현행 F(라이브)와]`);
  for (const [name, cs] of Object.entries(cases)) {
    if (!cs.n) continue;
    const lead = cs.leads.length ? ` · 창-F 시차 중앙 ${med(cs.leads) >= 0 ? "+" : ""}${med(cs.leads)}분` : "";
    console.log(`${name}: ${cs.n}일${lead}${cs.n && (name === "공통" || name === "이견" || name === "창만") ? ` · 창단독 ${s1(cs.cwPnl)}%p(컷 ${cs.cwCut})` : ""} · v2 기여 ${s1(v2Case[name])}%p`);
  }
  console.log(`\nv2(창선행 100% → F반대 청산+역진입·창 무판정일 F 단독): ${s1(v2)}%p · 최악일 ${v2Worst.toFixed(2)}% · 컷일 ${v2Cut}   (누적 순전진 1.0 기준 +101.2)`);
  console.log(`v3b(창 50% → F동의 100%·F반대 역진입): ${s1(v3b)}%p · 최악일 ${v3bWorst.toFixed(2)}% · 컷일 ${v3bCut}   (기준 +81.7)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
