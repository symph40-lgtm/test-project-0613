// PG-1 증보안 A1 검증 (docs/pg1-spec-amendment-a1.md):
//   npx tsx scripts/pg1-a1.ts --calib     ← A1.1 MAE/MFE 캘리브레이션 + 분리력 곡선 + κ·h 산정 (측정만 — PG 성과 미계산)
//   npx tsx scripts/pg1-a1.ts --ablation  ← C 변형(캘리브 n·계단·SafeZone·ER)·PG-1D CUSUM·B 보강(VSA·확장도) 게이트 판정
//   npx tsx scripts/pg1-a1.ts --ovn       ← 신모델 결합 탐색: D·ER 상태별 1박(다음날 시가) 수익 분해 (탐색적)
// 실행 순서 엄수: --calib → 사전등록 기입(증보안 문서) → --ablation. 레그 미러는 pg1-replay.ts와 동일(parity assert).
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder, fisherFirstKr } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import {
  agg10m, atrSeries, pg1bStream, pg1cExit, cusumScan, erAt, vsaCounts,
  PG1B_DEFAULT, type Bar10, type Pg1bEvent, type Pg1cOpts,
} from "../lib/predict/profitGuard";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE = resolve(process.cwd(), ".predict-cache");
const MODE = process.argv.includes("--calib") ? "calib" : process.argv.includes("--ovn") ? "ovn" : "ablation";
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const quant = (a: number[], q: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };
function collect(code: string): { days: Day[]; allDates: string[]; regByDate: Map<string, MinuteBar[]> } {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  const allDates: string[] = []; const regByDate = new Map<string, MinuteBar[]>();
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    allDates.push(date); regByDate.set(date, reg);
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d });
    daily.push(d);
  }
  return { days: out, allDates, regByDate };
}

type Leg = { pos: number; i0: number; dir: 1 | -1; px: number; size: number; endI?: number; endPx?: number };
function ladderLegs(bars: MinuteBar[], r10: number, trs: { i: number; to: string; px: number }[], defense: boolean, highVol: boolean): Leg[] {
  const cw = trs.length ? { t: hm(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const cwFlip = trs.length ? trs.find((x) => x.i > trs[0].i && x.to !== trs[0].to) ?? null : null;
  const fJ = fisherFirstKr(bars, r10);
  const legs: Leg[] = [];
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    const oppI = opp ? cw!.i : undefined, oppPx = opp ? cw!.px : undefined;
    legs.push({ pos: 0, i0: fJ.i, dir: fJ.dir, px: fJ.px, size: 0.3 * (defense ? 0.5 : 1), endI: oppI, endPx: oppPx });
    let held = 0.3;
    const evs: { i: number; target: number; px: number }[] = [];
    if (fJ.i + 5 < bars.length && (bars[fJ.i + 5].close - fJ.px) * fJ.dir >= 0.1 * r10) evs.push({ i: fJ.i + 5, target: 0.7, px: bars[fJ.i + 5].close });
    for (let k = fJ.i + 1; k < bars.length; k++) {
      if ((bars[k].close - fJ.px) * fJ.dir >= 0.3 * r10) { evs.push({ i: k, target: 1.0, px: bars[k].close }); break; }
    }
    if (cw && cw.dir === fJ.dir) evs.push({ i: cw.i, target: 1.0, px: cw.px });
    evs.sort((a, b) => a.i - b.i);
    for (const ev of evs) {
      if (oppI !== undefined && ev.i >= oppI) break;
      const add = ev.target - held;
      if (add <= 0) continue;
      legs.push({ pos: 0, i0: ev.i, dir: fJ.dir, px: ev.px, size: add, endI: oppI, endPx: oppPx });
      held = ev.target;
    }
    if (opp && cw) {
      const rEnd = highVol ? cwFlip : null;
      legs.push({ pos: 1, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0, endI: rEnd?.i, endPx: rEnd?.px });
    }
  } else if (cw) {
    const fOppLate = fJ && fJ.dir !== cw.dir ? fJ : null;
    const flipEx = highVol ? cwFlip : null;
    let endI: number | undefined, endPx: number | undefined;
    if (flipEx && (!fOppLate || flipEx.i <= fOppLate.i)) { endI = flipEx.i; endPx = flipEx.px; }
    else if (fOppLate) { endI = fOppLate.i; endPx = fOppLate.px; }
    legs.push({ pos: 0, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0, endI, endPx });
  }
  return legs;
}
function v2Legs(bars: MinuteBar[], trs: { i: number; to: string; px: number }[], fJ: { i: number; t: number; dir: 1 | -1; px: number } | null): Leg[] {
  const cw = trs.length ? { i: trs[0].i, t: hm(bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const legs: Leg[] = [];
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    legs.push({ pos: 0, i0: fJ.i, dir: fJ.dir, px: fJ.px, size: 0.3, endI: opp ? cw!.i : undefined, endPx: opp ? cw!.px : undefined });
    if (cw && cw.dir === fJ.dir) legs.push({ pos: 0, i0: cw.i, dir: fJ.dir, px: cw.px, size: 0.7 });
    if (opp && cw) legs.push({ pos: 1, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0 });
  } else if (cw) {
    const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
    legs.push({ pos: 0, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0, endI: fOpp?.i, endPx: fOpp?.px });
    if (fOpp) legs.push({ pos: 1, i0: fOpp.i, dir: fOpp.dir, px: fOpp.px, size: 1.0 });
  }
  return legs;
}
function legOutcome(bars: MinuteBar[], close: number, leg: Leg, stopPct: number, pgExitI?: number, pgExitPx?: number): { pnl: number; cut: boolean; exitI: number; exitPx: number; pg: boolean } {
  const s = stopPct / 100;
  const baseLim = leg.endI ?? bars.length;
  const lim = pgExitI !== undefined ? Math.min(baseLim, pgExitI + 1) : baseLim;
  for (let k = leg.i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (leg.dir === 1 ? b.low <= leg.px * (1 - s) : b.high >= leg.px * (1 + s))
      return { pnl: -stopPct * leg.size, cut: true, exitI: k, exitPx: leg.px * (leg.dir === 1 ? 1 - s : 1 + s), pg: false };
  }
  if (pgExitI !== undefined && pgExitI < baseLim) {
    const px = pgExitPx ?? bars[pgExitI].close;
    return { pnl: ((px - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: false, exitI: pgExitI, exitPx: px, pg: true };
  }
  if (leg.endI !== undefined) {
    const px = leg.endPx ?? close;
    return { pnl: ((px - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: false, exitI: leg.endI, exitPx: px, pg: false };
  }
  return { pnl: ((close - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: false, exitI: bars.length - 1, exitPx: close, pg: false };
}
function evTo1m(dayBars: MinuteBar[], ev: { time: string; px: number }): number {
  const m0 = hm(ev.time), endM = ev.time === "15:20" ? 15 * 60 + 31 : m0 + 10;
  let idx = -1;
  for (let i = 0; i < dayBars.length; i++) {
    const t = hm(dayBars[i].time);
    if (t >= m0 && t < endM && dayBars[i].time >= "09:00") idx = i;
  }
  if (idx < 0) throw new Error(`evTo1m: 버킷 ${ev.time} 1분봉 없음`);
  if (Math.abs(dayBars[idx].close - ev.px) > 1e-9) throw new Error(`evTo1m: 종가 불일치 ${ev.time}`);
  return idx;
}

type PosCtx = { pos: number; legs: Leg[]; first: Leg; baseEnd: number; t0: number; t1: number; agree?: boolean };
type DayCtx = { D: Day; posCtxs: PosCtx[]; r0: number; r1: number; dayIdx: number };

function buildAll(name: string, code: string, isHx: boolean) {
  const { days, allDates, regByDate } = collect(code);
  const bars10: Bar10[] = []; const dayRange = new Map<string, [number, number]>();
  for (const date of allDates) {
    const s = bars10.length;
    bars10.push(...agg10m(regByDate.get(date)!, date));
    dayRange.set(date, [s, bars10.length]);
  }
  const atr = atrSeries(bars10, 14);
  const bEv = { 1: pg1bStream(bars10, 1, PG1B_DEFAULT), [-1]: pg1bStream(bars10, -1, PG1B_DEFAULT) } as Record<1 | -1, Pg1bEvent[]>;
  const stopPct = isHx ? 2.5 : 1.5;
  const cuts: boolean[] = [];
  const dayCtxs: DayCtx[] = [];
  let parityMax = 0;
  for (let di = 0; di < days.length; di++) {
    const D = days[di];
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const fT = !isHx && D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fT.length ? D.bars.findIndex(b => b.time === fT[0].time) : -1;
    const fJv2 = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
    const highVol = isHighVolDay(D.hist);
    const legs = isHx ? ladderLegs(D.bars, D.r10, trs, prevCut2 || gapBig, highVol) : v2Legs(D.bars, trs, fJv2);
    const sim = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs as never, prevCut2 || gapBig, highVol)
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, fJv2, C.newModel.ssV2.win);
    const basePnl = legs.reduce((a, l) => a + legOutcome(D.bars, D.d.close, l, stopPct).pnl, 0);
    parityMax = Math.max(parityMax, Math.abs(basePnl - sim.pnl));
    if (Math.abs(basePnl - sim.pnl) > 1e-6) throw new Error(`parity 실패 ${name} ${D.date}`);
    cuts.push(sim.pnl <= -2.4);
    const range = dayRange.get(D.date); if (!range) continue;
    const [r0, r1] = range;
    const byPos = new Map<number, Leg[]>();
    for (const l of legs) byPos.set(l.pos, [...(byPos.get(l.pos) ?? []), l]);
    const posCtxs: PosCtx[] = [];
    for (const [posId, posLegs] of byPos) {
      const first = posLegs[0];
      const baseEnd = Math.max(...posLegs.map(l => legOutcome(D.bars, D.d.close, l, stopPct).exitI));
      const entryClock = hm(D.bars[first.i0].time) + 1;
      let t0 = r1;
      for (let t = r0; t < r1; t++) if (hm(bars10[t].time) >= entryClock) { t0 = t; break; }
      posCtxs.push({ pos: posId, legs: posLegs, first, baseEnd, t0, t1: r1 - 1 });
    }
    // 1박 자격 (kr-overnight-sweep 정의): 창 첫판정 존재 & F 동의(무판정 포함) & 비컷일
    const firstTr = trs.length ? trs[0] : null;
    let agree = false, ovnDir = 0;
    if (firstTr) {
      ovnDir = firstTr.to === "up" ? 1 : -1;
      const fd = isHx ? (fisherFirstKr(D.bars, D.r10)?.dir ?? 0) : (fJv2?.dir ?? 0);
      const fT1 = isHx ? (fisherFirstKr(D.bars, D.r10)?.t ?? 0) : (fJv2?.t ?? 0);
      agree = fd === 0 || (fd === ovnDir && fT1 >= hm(D.bars[firstTr.i].time));
    }
    dayCtxs.push({ D, posCtxs, r0, r1, dayIdx: di });
    (dayCtxs[dayCtxs.length - 1] as DayCtx & { agree?: boolean; ovnDir?: number; basePnl?: number }).agree = agree;
    (dayCtxs[dayCtxs.length - 1] as DayCtx & { ovnDir?: number }).ovnDir = ovnDir;
    (dayCtxs[dayCtxs.length - 1] as DayCtx & { basePnl?: number }).basePnl = sim.pnl;
  }
  console.log(`\n════ ${name} — ${days.length}일 · parity 최대오차 ${parityMax.toExponential(1)} ════`);
  return { days, bars10, atr, bEv, stopPct, dayCtxs, isHx };
}
type All = ReturnType<typeof buildAll>;

// ── A1.1 캘리브레이션: 되돌림 에피소드 (지속=고점 재갱신 / 종결=미회복) ──
type Episode = { depthAtr: number; recovered: boolean };
function episodes(all: All, pc: PosCtx): { eps: Episode[]; drifts: number[]; alivePeakT: number } {
  const { bars10, atr } = all;
  const eps: Episode[] = []; const drifts: number[] = [];
  const dir = pc.first.dir;
  let peak = pc.first.px, adverse = pc.first.px, depthAtr = 0, alivePeakT = pc.t0;
  let prevClose: number | null = null;
  const endMin = hm(all.dayCtxs.find(dc => dc.posCtxs.includes(pc))!.D.bars[pc.baseEnd].time);
  for (let t = pc.t0; t <= pc.t1; t++) {
    const b = bars10[t];
    if (b.nMin === 0 || atr[t] === null) continue;
    if (hm(b.time) + 10 > endMin + 1 && b.time !== "15:20") break; // 청산 이후 봉 제외 (15:20 버킷은 종가 포함)
    if (hm(b.time) > endMin) break;
    if (prevClose !== null) drifts.push((b.close / prevClose - 1) * 100 * dir);
    prevClose = b.close;
    const fav = dir === 1 ? b.high : b.low;
    const adv = dir === 1 ? b.low : b.high;
    if ((fav - peak) * dir > 0) {
      if (depthAtr > 0) eps.push({ depthAtr, recovered: true });
      peak = fav; adverse = fav; depthAtr = 0; alivePeakT = t;
    }
    if ((adverse - adv) * dir > 0) {
      adverse = adv;
      depthAtr = Math.max(depthAtr, ((peak - adverse) * dir) / (atr[t] as number));
    }
  }
  if (depthAtr > 0) eps.push({ depthAtr, recovered: false });
  return { eps, drifts, alivePeakT };
}

function calib(all: All, print = true) {
  const rec: number[] = [], ended: number[] = [], drifts: number[] = [];
  const aliveSpans: { pc: PosCtx; endT: number }[] = [];
  for (const dc of all.dayCtxs) for (const pc of dc.posCtxs) {
    const r = episodes(all, pc);
    for (const e of r.eps) (e.recovered ? rec : ended).push(e.depthAtr);
    drifts.push(...r.drifts);
    aliveSpans.push({ pc, endT: r.alivePeakT });
  }
  const q90 = quant(rec, 0.9);
  const drift = mean(drifts);
  const kappa = Math.max(0.005, drift / 2);
  // h: 오경보 예산(살아있는 구간에서 평균 2거래일당 1회 이하)으로 역산
  let h = 0.2; const target = 0.5; // 알람/일
  for (; h <= 5; h += 0.1) {
    let alarms = 0, bars = 0;
    for (const sp of aliveSpans) {
      alarms += cusumScan(all.bars10, sp.pc.t0, sp.endT, sp.pc.first.dir, kappa, h, true).length;
      bars += Math.max(0, sp.endT - sp.pc.t0);
    }
    if (bars && alarms / (bars / 39) <= target) break;
  }
  if (print) {
    console.log(`  [A1.1] 지속 되돌림 n=${rec.length}: q50 ${quant(rec, 0.5).toFixed(2)} · q75 ${quant(rec, 0.75).toFixed(2)} · q90 ${q90.toFixed(2)} ATR / 종결 n=${ended.length}: q50 ${quant(ended, 0.5).toFixed(2)} ATR`);
    const grid = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];
    const curve = grid.map(x => {
      const sub = [...rec.map(d => ({ d, r: 1 })), ...ended.map(d => ({ d, r: 0 }))].filter(e => e.d >= x);
      return `≥${x}: ${sub.length ? Math.round(mean(sub.map(e => e.r)) * 100) : "-"}%(${sub.length})`;
    });
    console.log(`  [A1.1] 분리력(깊이 x 이상 에피소드의 회복률): ${curve.join(" · ")}`);
    console.log(`  [A1.5] 드리프트 ${drift.toFixed(4)}%/10분 → κ=${kappa.toFixed(4)}% · h=${h.toFixed(1)}% (오경보 ≤${target}/일 역산)`);
  }
  return { q90, kappa, h, recN: rec.length, endN: ended.length };
}

// ── ablation ──
function ablation(all: All, cal: { q90: number; kappa: number; h: number }) {
  const n0 = Math.max(2.0, cal.q90);
  const cCal: Pg1cOpts = { n: n0, p: 14, a: 1.5 };
  const cTier: Pg1cOpts = { ...cCal, tiers: [{ profitAtr: 3, n: Math.max(2.0, n0 - 0.5) }, { profitAtr: 5, n: Math.max(2.0, n0 - 1.0) }] };
  const cSz: Pg1cOpts = { ...cCal, dist: "safezone" };
  const cEr: Pg1cOpts = { ...cCal, erGate: { theta: 0.3, j: 3, m: 10, step: 0.5 } };
  type Pol = [string, { c?: Pg1cOpts; d?: boolean }];
  const pols: Pol[] = [["base", {}], ["C_cal", { c: cCal }], ["C_tier", { c: cTier }], ["C_sz", { c: cSz }], ["C_er", { c: cEr }], ["D", { d: true }], ["D∧C", { c: cCal, d: true }]];
  for (const [label, cfg] of pols) {
    const dayPnls: number[] = []; const gb: number[] = [];
    let cutDays = 0, nExit = 0;
    for (const dc of all.dayCtxs) {
      let pnl = 0, dayCut = false;
      for (const pc of dc.posCtxs) {
        let ev: { i1m: number; px: number } | null = null;
        if (cfg.c) {
          const hit = pg1cExit(all.bars10, all.atr, pc.t0, pc.t1, pc.first.dir, pc.first.px, cfg.c);
          if (hit) { const i1m = evTo1m(dc.D.bars, { time: all.bars10[hit.i].time, px: hit.px }); if (i1m > pc.first.i0 && i1m < pc.baseEnd) ev = { i1m, px: hit.px }; }
        }
        if (cfg.d) {
          const al = cusumScan(all.bars10, pc.t0, pc.t1, pc.first.dir, cal.kappa, cal.h, false);
          if (al.length) {
            const t = al[0]; const b = all.bars10[t];
            const i1m = evTo1m(dc.D.bars, { time: b.time, px: b.close });
            if (i1m > pc.first.i0 && i1m < pc.baseEnd && (!ev || i1m < ev.i1m)) ev = { i1m, px: b.close };
          }
        }
        let posPnl = 0, cut = false, exitI = -1, exitPx = NaN;
        for (const l of pc.legs) {
          if (ev && l.i0 >= ev.i1m) continue;
          const o = legOutcome(dc.D.bars, dc.D.d.close, l, all.stopPct, ev?.i1m, ev?.px);
          posPnl += o.pnl; cut = cut || o.cut; if (o.pg) nExit++;
          if (o.exitI > exitI) { exitI = o.exitI; exitPx = o.exitPx; }
        }
        if (exitI >= 0) {
          let fav = pc.first.px;
          for (let k = pc.first.i0 + 1; k <= Math.min(exitI, dc.D.bars.length - 1); k++) {
            const b = dc.D.bars[k];
            fav = pc.first.dir === 1 ? Math.max(fav, b.high) : Math.min(fav, b.low);
          }
          const mfe = ((fav - pc.first.px) / pc.first.px) * 100 * pc.first.dir;
          if (mfe >= 1) gb.push(((fav - exitPx) / pc.first.px) * 100 * pc.first.dir);
        }
        pnl += posPnl; dayCut = dayCut || cut;
      }
      dayPnls.push(pnl); if (dayCut) cutDays++;
    }
    console.log(`  [${label.padEnd(6)}] 합계 ${s1(dayPnls.reduce((a, b) => a + b, 0))}%p · 최악일 ${s2(Math.min(...dayPnls))} · 컷일 ${cutDays} · 반납중앙(MFE≥1%) ${s2(median(gb))}(n=${gb.length})` + (label === "base" ? "" : ` · PG청산레그 ${nExit}`));
  }

  // B 보강 게이트: 등급(거래량)/VSA 가점/확장도 별 적중률 + poor-high 비대칭
  const stat = new Map<string, { n: number; hit: number }>();
  const bump = (k: string, hit: boolean) => { const s = stat.get(k) ?? { n: 0, hit: 0 }; s.n++; if (hit) s.hit++; stat.set(k, s); };
  let phRev = 0, phPoor = 0;
  for (const dc of all.dayCtxs) {
    for (const pc of dc.posCtxs) {
      const dir = pc.first.dir;
      const warns = (dir === 1 ? all.bEv[1] : all.bEv[-1]).filter(e => e.kind === "warn" && e.i >= pc.t0 && e.i <= pc.t1);
      const inHold = warns.map(w => ({ w, i1m: evTo1m(dc.D.bars, w) })).filter(x => x.i1m > pc.first.i0 && x.i1m < pc.baseEnd);
      for (const { w } of inHold) {
        const endT = Math.min(w.i + 12, dc.r1 - 1);
        if (endT <= w.i) continue;
        let extB = -Infinity, ext = -Infinity;
        for (let t = dc.r0; t <= w.i; t++) extB = Math.max(extB, dir === 1 ? all.bars10[t].high : -all.bars10[t].low);
        for (let t = w.i + 1; t <= endT; t++) ext = Math.max(ext, dir === 1 ? all.bars10[t].high : -all.bars10[t].low);
        const hit = ext < extB && (all.bars10[endT].close - all.bars10[w.i].close) * dir < 0;
        const vsa = vsaCounts(all.bars10, w.i, dir);
        const uplift = !!vsa && (vsa.upthrust >= 1 || vsa.noDemand >= 2);
        bump(uplift ? "VSA가점" : "VSA무가점", hit);
        const A = all.atr[w.i];
        const anchor = all.bars10[dc.r0].open;
        const extension = A ? ((all.bars10[w.i].close - anchor) * dir) / A : null;
        if (extension !== null) bump(extension >= 2.0 ? "고확장(≥2ATR)" : "저확장", hit);
      }
      // poor-high: 반전(반납 ≥1%)인데 B 침묵 — 최종 고점 봉의 불리쪽 꼬리 ≤ 범위 25%?
      const baseExit = Math.max(...pc.legs.map(l => legOutcome(dc.D.bars, dc.D.d.close, l, all.stopPct).exitI));
      let fav = pc.first.px, favT = -1;
      for (let t = pc.t0; t <= pc.t1; t++) {
        const b = all.bars10[t];
        if (b.nMin === 0) continue;
        const f = dir === 1 ? b.high : b.low;
        if ((f - fav) * dir > 0) { fav = f; favT = t; }
      }
      const exitPxb = dc.D.bars[Math.min(baseExit, dc.D.bars.length - 1)].close;
      const gbPct = ((fav - exitPxb) / pc.first.px) * 100 * dir;
      if (gbPct >= 1 && !inHold.length && favT >= 0) {
        phRev++;
        const pb = all.bars10[favT];
        const rng = pb.high - pb.low;
        const advWick = dir === 1 ? pb.high - Math.max(pb.open, pb.close) : Math.min(pb.open, pb.close) - pb.low;
        if (rng > 0 && advWick / rng <= 0.25) phPoor++;
      }
    }
  }
  for (const [k, s] of stat) console.log(`  [B] ${k}: ${s.hit}/${s.n} 적중 (${s.n ? Math.round(s.hit / s.n * 100) : 0}%)`);
  console.log(`  [B] B 미발동 반전 ${phRev}건 중 poor-high(꼬리≤25%) ${phPoor}건 (${phRev ? Math.round(phPoor / phRev * 100) : 0}%) — 경매이론 비대칭(A2.2)`);
  // D 오경보 실측 (±30% 게이트): 살아있는 구간 재측정
  let alarms = 0, bars = 0;
  for (const dc of all.dayCtxs) for (const pc of dc.posCtxs) {
    const r = episodes(all, pc);
    alarms += cusumScan(all.bars10, pc.t0, r.alivePeakT, pc.first.dir, cal.kappa, cal.h, true).length;
    bars += Math.max(0, r.alivePeakT - pc.t0);
  }
  const rate = bars ? alarms / (bars / 39) : NaN;
  console.log(`  [D] 오경보 실측 ${rate.toFixed(2)}/일 (설계 0.5/일 · ±30% 게이트 = 0.35~0.65)`);
}

// ── 1박 결합 탐색 (탐색적 — 사전등록 밖 명기) ──
function ovnProbe(all: All, cal: { kappa: number; h: number }) {
  type Row = { alarmAny: boolean; alarmLate: boolean; erLow: boolean; ret: number };
  const rows: Row[] = [];
  for (let i = 0; i < all.dayCtxs.length; i++) {
    const dc = all.dayCtxs[i] as DayCtx & { agree?: boolean; ovnDir?: number; basePnl?: number };
    const next = all.dayCtxs[i + 1];
    if (!dc.agree || !dc.ovnDir || !next || (dc.basePnl ?? 0) <= -2.4) continue;
    const dir = dc.ovnDir as 1 | -1;
    const pc0 = dc.posCtxs[0];
    if (!pc0) continue;
    const al = cusumScan(all.bars10, pc0.t0, dc.r1 - 1, dir, cal.kappa, cal.h, true);
    const er = erAt(all.bars10, dc.r1 - 1, 10);
    rows.push({
      alarmAny: al.length > 0,
      alarmLate: al.some(t => t >= dc.r1 - 7), // 마지막 ~1시간
      erLow: er !== null && er < 0.3,
      ret: ((next.D.d.open - dc.D.d.close) / dc.D.d.close) * 100 * dir,
    });
  }
  const rep = (label: string, f: (r: Row) => boolean) => {
    const a = rows.filter(f).map(r => r.ret), b = rows.filter(r => !f(r)).map(r => r.ret);
    console.log(`  [1박] ${label}: 해당 ${a.length}일 일당 ${s2(mean(a))}(합 ${s1(a.reduce((x, y) => x + y, 0))}) vs 비해당 ${b.length}일 일당 ${s2(mean(b))}(합 ${s1(b.reduce((x, y) => x + y, 0))})`);
  };
  console.log(`  [1박] 자격일 ${rows.length}일 · 전체 일당 ${s2(mean(rows.map(r => r.ret)))} · 합 ${s1(rows.reduce((a, r) => a + r.ret, 0))}`);
  rep("D 알람(당일 아무 때나)", r => r.alarmAny);
  rep("D 알람(마감 1시간 내)", r => r.alarmLate);
  rep("ER<0.3(마감 시점)", r => r.erLow);
}

console.log(`PG-1 A1 증보 검증 — 모드: ${MODE}`);
for (const [name, code, isHx] of [["하이닉스(4단 사다리)", "000660", true], ["삼성전자(v2)", "005930", false]] as [string, string, boolean][]) {
  const all = buildAll(name, code, isHx);
  const cal = calib(all, true);
  if (MODE === "ablation") ablation(all, cal);
  if (MODE === "ovn") ovnProbe(all, cal);
}
console.log(`\n[A2.3 체결강도] 캐시 분봉은 총 거래량만 보유(매수/매도 체결 분리 없음) — 증보안 전제 미충족, 보류 명시.`);
