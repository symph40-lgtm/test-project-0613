// 삼전 피셔 변경판 × 창모델 결합 실측 (사용자 지시 2026-08-02 밤):
//   npx tsx scripts/ss-fisher-mod-cw.ts
// 변경 스펙 (사용자 지정): F·M·본 모두 0930 박스(09:30~45) — F·M은 rebox(08 OR→09:45부터 전환·상태 승계,
//   하닉 시범과 동일 메커니즘)·본은 박스 이동(정규장 09:30부터). 확인봉 F 4→2·M 8→4.
//   장초반 완충 F ×3→×1.25(M과 동일). 나머지(오프셋·강돌파 0.075·C3·09:00 게이트·고변동일 트레일)는 현행.
// ① 계층 단독 성적 현행 vs 변경 (첫판정 진입·스탑 본주 -1.5%·종가보유 — §6.2 잣대)
// ② 변경 F를 검증자로 창(4봉 누적 순전진 1.0/1.2) 케이스 분해 + v2/v3b 재실측

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
const fmtT = (m: number) => Number.isNaN(m) ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
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

type DayD = { date: string; bars: MinuteBar[]; reg: MinuteBar[]; r10: number; close: number; hist: PredictDailyBar[]; hv: boolean };

function firstJ(bars: MinuteBar[], hist: PredictDailyBar[], date: string, cfg: FisherCfg): { i: number; t: number; dir: 1 | -1; px: number } | null {
  if (bars.length < 20) return null;
  const out = runFisher({ date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, cfg);
  const trs = out.transitions ?? [];
  if (!trs.length) return null;
  const idx = bars.findIndex((b) => b.time === trs[0].time);
  if (idx < 0) return null;
  return { i: idx, t: tMin(trs[0].time), dir: trs[0].to === "up" ? 1 : -1, px: trs[0].px };
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

function layerScore(days: DayD[], label: string, get: (d: DayD) => ReturnType<typeof firstJ>, barsOf: (d: DayD) => MinuteBar[]): void {
  let n = 0, wins = 0, cuts = 0, sum = 0;
  const firsts: number[] = [];
  for (const d of days) {
    const j = get(d);
    if (!j) continue;
    n++;
    firsts.push(j.t);
    const r = tranche(barsOf(d), d.close, j.i, j.dir, j.px, 1);
    sum += r.pnl;
    if (r.cut) cuts++;
    if (r.pnl > 0) wins++;
  }
  console.log(`${label}: 판정 ${n}일 · 승률 ${n ? Math.round((100 * wins) / n) : 0}% · 컷 ${cuts} · 종가보유 ${s1(sum)}%p · 첫확인중앙 ${fmtT(med(firsts))}`);
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
    days.push({ date: daily[i].date, bars: [...(pre ?? []), ...reg], reg, r10, close: daily[i].close, hist, hv: isHighVolDay(hist) });
  }

  const REBOX = { reboxHHMM: "09:30", reboxMinutes: 15 };
  const F_CUR: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const F_MOD: FisherCfg = { ...F_CUR, confirmMinutes: 2, earlyVolMult: 1.25, ...REBOX };
  const M_CUR: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const M_MOD: FisherCfg = { ...M_CUR, confirmMinutes: 4, ...REBOX };
  const bCfg = (d: DayD): FisherCfg => ({ strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, ...(d.hv ? { trailRangeRatio: C.ssTrail.rangeRatio, trailConfirmMinutes: C.ssTrail.confirmMinutes } : {}) });
  const reg0930 = (d: DayD) => d.reg.filter((b) => b.time >= "09:30");

  console.log(`════ ① 삼전 계층 단독 — 현행 vs 변경 (${days.length}일 · 첫판정·스탑 -1.5%·종가보유) ════`);
  layerScore(days, "F 현행(4봉·완충×3·08OR)      ", (d) => firstJ(d.bars, d.hist, d.date, F_CUR), (d) => d.bars);
  layerScore(days, "F 변경(2봉·완충×1.25·0930박스)", (d) => firstJ(d.bars, d.hist, d.date, F_MOD), (d) => d.bars);
  layerScore(days, "M 현행(8봉·08OR)             ", (d) => firstJ(d.bars, d.hist, d.date, M_CUR), (d) => d.bars);
  layerScore(days, "M 변경(4봉·0930박스)         ", (d) => firstJ(d.bars, d.hist, d.date, M_MOD), (d) => d.bars);
  layerScore(days, "본 현행(09:00~15 OR)         ", (d) => firstJ(d.reg, d.hist, d.date, bCfg(d)), (d) => d.reg);
  layerScore(days, "본 변경(09:30~45 박스 이동)   ", (d) => firstJ(reg0930(d), d.hist, d.date, bCfg(d)), (d) => reg0930(d));

  for (const tanA of [1.0, 1.2]) {
    type Case = { n: number; leads: number[] };
    const cases: Record<string, Case> = { 공통: { n: 0, leads: [] }, 이견: { n: 0, leads: [] }, F만: { n: 0, leads: [] }, 창만: { n: 0, leads: [] }, 무: { n: 0, leads: [] } };
    let v2 = 0, v2Worst = 0, v2Cut = 0, v3b = 0, v3bWorst = 0, v3bCut = 0;
    const v2Case: Record<string, number> = { 공통: 0, 이견: 0, F만: 0, 창만: 0, 무: 0 };
    for (const d of days) {
      const unit = unitArr(d.bars, d.r10);
      const trs = streamCum(d.bars, unit, tanA);
      const cw = trs.length ? { i: trs[0].i, t: tMin(d.bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
      const fJ = firstJ(d.bars, d.hist, d.date, F_MOD);
      const cat = fJ && cw ? (fJ.dir === cw.dir ? "공통" : "이견") : fJ ? "F만" : cw ? "창만" : "무";
      cases[cat].n++;
      if (fJ && cw) cases[cat].leads.push(cw.t - fJ.t);
      const fFirst = fJ && (!cw || fJ.t < cw.t);
      // v2: 창선행 100% → F반대 청산+역진입 / F선행(희귀) 하닉식
      {
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
        }
        v2 += p; v2Worst = Math.min(v2Worst, p); if (c) v2Cut++;
        v2Case[cat] += p;
      }
      // v3b: 창 50% → F동의 100% / F반대 청산+역진입
      {
        let p = 0, c = false;
        const add = (r: { pnl: number; cut: boolean }) => { p += r.pnl; c = c || r.cut; };
        if (fFirst && fJ) {
          add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 1.0));
        } else if (cw) {
          const fSame = fJ && fJ.dir === cw.dir ? fJ : null;
          const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
          add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 0.5, fOpp?.i, fOpp?.px));
          if (fSame) add(tranche(d.bars, d.close, fSame.i, cw.dir, fSame.px, 0.5));
          if (fOpp) add(tranche(d.bars, d.close, fOpp.i, fOpp.dir, fOpp.px, 1.0));
        }
        v3b += p; v3bWorst = Math.min(v3bWorst, p); if (c) v3bCut++;
      }
    }
    console.log(`\n════ ② 변경 F × 창 ${tanA.toFixed(1)} 케이스 분해 (${days.length}일) ════`);
    for (const [name, cs] of Object.entries(cases)) {
      if (!cs.n) continue;
      const lead = cs.leads.length ? ` · 창-F 시차 중앙 ${med(cs.leads) >= 0 ? "+" : ""}${med(cs.leads)}분` : "";
      console.log(`${name}: ${cs.n}일${lead} · v2 기여 ${s1(v2Case[name])}%p`);
    }
    console.log(`v2: ${s1(v2)}%p · 최악일 ${v2Worst.toFixed(2)}% · 컷일 ${v2Cut}   (현행 F 기준: 1.0 +101.2 · 1.2 +100.8)`);
    console.log(`v3b: ${s1(v3b)}%p · 최악일 ${v3bWorst.toFixed(2)}% · 컷일 ${v3bCut}   (현행 F 기준: 1.0 +81.7 · 1.2 +83.0)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
