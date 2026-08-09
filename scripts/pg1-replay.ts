// PG-1 이익 보호 매도신호 — 오프라인 리플레이 v0.2 (기획 docs/pg1-profit-guard-spec.md §11):
//   npx tsx scripts/pg1-replay.ts             ← ablation 사다리: base → +C → +C+래칫 → +C+래칫+A → +FULL(B⅓분할)
//                                                + 민감도 격자(n×p) + 게이트 지표 (사전등록 §10.1 대비)
//   npx tsx scripts/pg1-replay.ts --baseline  ← 베이스라인만 (v0.1에서 등록 완료 — 재확인용)
// v0.1판(A·B 전량 청산)은 게이트 전패 기각(c3b8cca) — 본 판은 발주자 v0.2 개정(PG-1C 샹들리에·본전 래칫·
// B⅓ 분할·거래량 등급)을 검증한다. A·B 단독 성적은 기지(旣知) 상태에서 진행(스펙 §14.1).
// 레그 재구성은 simLadder/simV2 미러 + 일별 parity 하드 assert. lookahead 가드: PG 판정은 마감 10분봉만,
// C의 HH는 보유 후 완결 봉만(진입 부분 버킷 제외), 10분 종가 = 버킷 마지막 1분 종가 assert.
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
  agg10m, smaSeries, atrSeries, pg1aStream, pg1bStream, pg1cExit,
  PG1A_DEFAULT, PG1B_DEFAULT, PG1C_DEFAULT, type Bar10, type Pg1aEvent, type Pg1bEvent, type Pg1cOpts,
} from "../lib/predict/profitGuard";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE = resolve(process.cwd(), ".predict-cache");
const MODE = process.argv.includes("--baseline") ? "baseline" : "ablation";
const FEE_RT = 0.02; // 왕복비용 % (국장 0.01%/편도×2) — 본전 래칫 레벨에만 사용
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

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

// ── 레그 미러 (v0.1과 동일 — simLadder/simV2 산식, 일별 parity assert로 보증) ──
type Leg = { pos: number; i0: number; dir: 1 | -1; px: number; size: number; endI?: number; endPx?: number; tag: string };

function ladderLegs(bars: MinuteBar[], r10: number, trs: { i: number; to: string; px: number }[], defense: boolean, highVol: boolean): Leg[] {
  const cw = trs.length ? { t: hm(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const cwFlip = trs.length ? trs.find((x) => x.i > trs[0].i && x.to !== trs[0].to) ?? null : null;
  const fJ = fisherFirstKr(bars, r10);
  const legs: Leg[] = [];
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    const oppI = opp ? cw!.i : undefined, oppPx = opp ? cw!.px : undefined;
    legs.push({ pos: 0, i0: fJ.i, dir: fJ.dir, px: fJ.px, size: 0.3 * (defense ? 0.5 : 1), endI: oppI, endPx: oppPx, tag: "F정찰" });
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
      legs.push({ pos: 0, i0: ev.i, dir: fJ.dir, px: ev.px, size: add, endI: oppI, endPx: oppPx, tag: `증액${ev.target * 100}` });
      held = ev.target;
    }
    if (opp && cw) {
      const rEnd = highVol ? cwFlip : null;
      legs.push({ pos: 1, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0, endI: rEnd?.i, endPx: rEnd?.px, tag: "이견재진입" });
    }
  } else if (cw) {
    const fOppLate = fJ && fJ.dir !== cw.dir ? fJ : null;
    const flipEx = highVol ? cwFlip : null;
    let endI: number | undefined, endPx: number | undefined;
    if (flipEx && (!fOppLate || flipEx.i <= fOppLate.i)) { endI = flipEx.i; endPx = flipEx.px; }
    else if (fOppLate) { endI = fOppLate.i; endPx = fOppLate.px; }
    legs.push({ pos: 0, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0, endI, endPx, tag: "창선행" });
  }
  return legs;
}

function v2Legs(bars: MinuteBar[], trs: { i: number; to: string; px: number }[], fJ: { i: number; t: number; dir: 1 | -1; px: number } | null): Leg[] {
  const cw = trs.length ? { i: trs[0].i, t: hm(bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const legs: Leg[] = [];
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    legs.push({ pos: 0, i0: fJ.i, dir: fJ.dir, px: fJ.px, size: 0.3, endI: opp ? cw!.i : undefined, endPx: opp ? cw!.px : undefined, tag: "F정찰" });
    if (cw && cw.dir === fJ.dir) legs.push({ pos: 0, i0: cw.i, dir: fJ.dir, px: cw.px, size: 0.7, tag: "창동의" });
    if (opp && cw) legs.push({ pos: 1, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0, tag: "창역진입" });
  } else if (cw) {
    const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
    legs.push({ pos: 0, i0: cw.i, dir: cw.dir, px: cw.px, size: 1.0, endI: fOpp?.i, endPx: fOpp?.px, tag: "창선행" });
    if (fOpp) legs.push({ pos: 1, i0: fOpp.i, dir: fOpp.dir, px: fOpp.px, size: 1.0, tag: "F역진입" });
  }
  return legs;
}

// tranche 산식 + 본전 래칫(§7) + PG 청산. 스탑/래칫 레벨 터치가 항상 우선(컷 헌법).
// 래칫: 1분 종가 기준 미실현 ≥1R → 본전+왕복비용 / ≥2R → +1R. 레벨은 상향만(단조).
type Dyn = { pnl: number; cut: boolean; ratchetHit: boolean; exitI: number; exitPx: number; pg: boolean; stage: number };
function legOutcomeDyn(bars: MinuteBar[], close: number, leg: Leg, stopPct: number, ratchet: boolean, pgExitI?: number, pgExitPx?: number, initStage = 0): Dyn {
  const s = stopPct / 100;
  const lvl = (stage: number) => stage >= 2 ? leg.px * (1 + leg.dir * s) : stage === 1 ? leg.px * (1 + leg.dir * (FEE_RT / 100)) : leg.px * (1 - leg.dir * s);
  let stage = ratchet ? initStage : 0;
  let level = lvl(stage);
  const baseLim = leg.endI ?? bars.length;
  const lim = pgExitI !== undefined ? Math.min(baseLim, pgExitI + 1) : baseLim;
  for (let k = leg.i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (leg.dir === 1 ? b.low <= level : b.high >= level) {
      return { pnl: ((level - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: stage === 0, ratchetHit: stage > 0, exitI: k, exitPx: level, pg: false, stage };
    }
    if (ratchet && stage < 2) {
      const unreal = ((b.close - leg.px) / leg.px) * 100 * leg.dir;
      const next = unreal >= 2 * stopPct ? 2 : unreal >= stopPct ? 1 : 0;
      if (next > stage) { stage = next; level = lvl(stage); } // 상향만 — 하향 전이 없음(단조)
    }
  }
  // 래칫 레벨(≥1단)은 강제청산·PG청산 '당일 그 봉'의 터치도 우선한다 — 전환/PG 확정은 봉 마감,
  // 레벨 터치는 봉 내 선행 사건. (0단 초기컷은 원본 tranche 시맨틱 유지 — parity)
  const touchAt = (k: number): boolean => ratchet && stage >= 1 && k < bars.length && (leg.dir === 1 ? bars[k].low <= level : bars[k].high >= level);
  const lvlExit = (k: number): Dyn => ({ pnl: ((level - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: false, ratchetHit: true, exitI: k, exitPx: level, pg: false, stage });
  if (pgExitI !== undefined && pgExitI < baseLim) {
    if (touchAt(pgExitI)) return lvlExit(pgExitI);
    const px = pgExitPx ?? bars[pgExitI].close;
    return { pnl: ((px - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: false, ratchetHit: false, exitI: pgExitI, exitPx: px, pg: true, stage };
  }
  if (leg.endI !== undefined) {
    if (touchAt(leg.endI)) return lvlExit(leg.endI);
    const px = leg.endPx ?? close;
    return { pnl: ((px - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: false, ratchetHit: false, exitI: leg.endI, exitPx: px, pg: false, stage };
  }
  return { pnl: ((close - leg.px) / leg.px) * 100 * leg.dir * leg.size, cut: false, ratchetHit: false, exitI: bars.length - 1, exitPx: close, pg: false, stage };
}

// ── 10분봉 전 기간 시리즈 + PG 이벤트 ──
type Pg = {
  bars10: Bar10[]; dayRange: Map<string, [number, number]>;
  aUp: Pg1aEvent[]; aDn: Pg1aEvent[]; bUp: Pg1bEvent[]; bDn: Pg1bEvent[];
  atrBy: Map<number, (number | null)[]>;
};
function buildPg(allDates: string[], regByDate: Map<string, MinuteBar[]>): Pg {
  const bars10: Bar10[] = []; const dayRange = new Map<string, [number, number]>();
  for (const date of allDates) {
    const s = bars10.length;
    bars10.push(...agg10m(regByDate.get(date)!, date));
    dayRange.set(date, [s, bars10.length]);
  }
  const ma5 = smaSeries(bars10, 5), ma20 = smaSeries(bars10, 20);
  const atrBy = new Map<number, (number | null)[]>();
  for (const p of [14, 22]) atrBy.set(p, atrSeries(bars10, p));
  return {
    bars10, dayRange, atrBy,
    aUp: pg1aStream(bars10, ma5, ma20, 1, PG1A_DEFAULT), aDn: pg1aStream(bars10, ma5, ma20, -1, PG1A_DEFAULT),
    bUp: pg1bStream(bars10, 1, PG1B_DEFAULT), bDn: pg1bStream(bars10, -1, PG1B_DEFAULT),
  };
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

// ── 정책 평가 ──
type Cfg = { c?: Pg1cOpts; ratchet?: boolean; a?: boolean; b13?: boolean };
const CFGS: [string, Cfg][] = [
  ["base", {}],
  ["+R", { ratchet: true }], // 래칫 단독 한계 기여 (발주자 후속 질문 대비)
  ["+C", { c: PG1C_DEFAULT }],
  ["+CR", { c: PG1C_DEFAULT, ratchet: true }],
  ["+CRA", { c: PG1C_DEFAULT, ratchet: true, a: true }],
  ["FULL", { c: PG1C_DEFAULT, ratchet: true, a: true, b13: true }],
];
const GRID: Pg1cOpts[] = [];
for (const n of [2.5, 3.0, 3.5]) for (const p of [14, 22]) GRID.push({ n, p, a: 1.5 });

type PosCtx = {
  pos: number; legs: Leg[]; first: Leg; baseEnd: number;
  evA: { i1m: number; px: number; i: number } | null;
  evBs: { i1m: number; px: number; i: number; grade: "상" | "하" }[];
  t0: number; t1: number; // C 스캔 구간 (완결 10분봉, 전 기간 인덱스)
};
type DayCtx = { D: Day; posCtxs: PosCtx[] };
type PosRec = { date: string; pos: number; dir: 1 | -1; pnl: number; cut: boolean; ratchetHit: boolean; pgC: boolean; pgA: boolean; b13: boolean; mfePct: number; givebackPct: number; ratchetViol: boolean };

function evalPos(pg: Pg, D: Day, pc: PosCtx, cfg: Cfg, cOpt?: Pg1cOpts): { pnl: number; rec: PosRec; skipped: number } {
  const { first } = pc;
  // C 후보
  let cEv: { i1m: number; px: number } | null = null;
  const co = cOpt ?? cfg.c;
  if (co) {
    const atr = pg.atrBy.get(co.p)!;
    const hit = pg1cExit(pg.bars10, atr, pc.t0, pc.t1, first.dir, first.px, co);
    if (hit) {
      const i1m = evTo1m(D.bars, { time: pg.bars10[hit.i].time, px: hit.px });
      if (i1m > first.i0 && i1m < pc.baseEnd) cEv = { i1m, px: hit.px };
    }
  }
  const aEv = cfg.a && pc.evA && pc.evA.i1m > first.i0 && pc.evA.i1m < pc.baseEnd ? pc.evA : null;
  let pgEv: { i1m: number; px: number; kind: "C" | "A" } | null = null;
  if (cEv && aEv) pgEv = cEv.i1m <= aEv.i1m ? { ...cEv, kind: "C" } : { ...aEv, kind: "A" };
  else if (cEv) pgEv = { ...cEv, kind: "C" };
  else if (aEv) pgEv = { ...aEv, kind: "A" };
  const bEv = cfg.b13 ? pc.evBs.find(e => e.grade === "상" && e.i1m > first.i0 && e.i1m < (pgEv?.i1m ?? pc.baseEnd)) ?? null : null;

  let pnl = 0, cut = false, ratchetHit = false, pgC = false, pgA = false, viol = false, skipped = 0;
  let exitI = -1, exitPx = NaN;
  for (const l of pc.legs) {
    if (pgEv && l.i0 >= pgEv.i1m) { skipped++; continue; }
    const sizeMul = bEv && l.i0 >= bEv.i1m ? 2 / 3 : 1; // 트림 후 진입 레그는 ⅔ 규모
    const leg = sizeMul === 1 ? l : { ...l, size: l.size * sizeMul };
    let o: Dyn;
    if (bEv && l.i0 < bEv.i1m) {
      // 트림 전 구간 → ⅓ 실현 → 잔여 ⅔ 계속 (래칫 단계 승계)
      const seg1 = legOutcomeDyn(D.bars, D.d.close, leg, stopPctOf(pc), !!cfg.ratchet, bEv.i1m, bEv.px);
      if (seg1.pg) {
        pnl += seg1.pnl / 3;
        const rest = { ...leg, i0: bEv.i1m, size: leg.size * 2 / 3 };
        o = legOutcomeDyn(D.bars, D.d.close, rest, stopPctOf(pc), !!cfg.ratchet, pgEv?.i1m, pgEv?.px, seg1.stage);
      } else o = seg1; // 트림 전에 스탑/강제청산으로 종료
    } else {
      o = legOutcomeDyn(D.bars, D.d.close, leg, stopPctOf(pc), !!cfg.ratchet, pgEv?.i1m, pgEv?.px);
    }
    pnl += o.pnl; cut = cut || o.cut; ratchetHit = ratchetHit || o.ratchetHit;
    if (o.pg && pgEv) { pgC = pgC || pgEv.kind === "C"; pgA = pgA || pgEv.kind === "A"; }
    if (o.stage >= 1 && o.pnl < 0) viol = true; // 본전 래칫 위반 (§10 게이트 6 — 0건이어야 함)
    if (o.exitI > exitI) { exitI = o.exitI; exitPx = o.exitPx; }
  }
  // 반납 측정 (사후)
  let fav = first.px;
  for (let k = first.i0 + 1; k <= Math.min(exitI, D.bars.length - 1); k++) {
    const b = D.bars[k];
    fav = first.dir === 1 ? Math.max(fav, b.high) : Math.min(fav, b.low);
  }
  const mfePct = ((fav - first.px) / first.px) * 100 * first.dir;
  const givebackPct = exitI >= 0 ? ((fav - exitPx) / first.px) * 100 * first.dir : 0;
  return { pnl, skipped, rec: { date: D.date, pos: pc.pos, dir: first.dir, pnl, cut, ratchetHit, pgC, pgA, b13: !!bEv, mfePct, givebackPct, ratchetViol: viol } };
}
// stopPct는 종목 상수 — evalPos에서 참조할 수 있게 클로저 대신 컨텍스트에 심는다
let STOP_PCT_CUR = 2.5;
const stopPctOf = (_pc: PosCtx) => STOP_PCT_CUR;

function runSymbol(name: string, code: string, isHx: boolean) {
  const { days, allDates, regByDate } = collect(code);
  const pg = buildPg(allDates, regByDate);
  STOP_PCT_CUR = isHx ? 2.5 : 1.5;
  const stopPct = STOP_PCT_CUR;
  const cuts: boolean[] = [];
  const dayCtxs: DayCtx[] = [];
  let parityMax = 0;

  for (const D of days) {
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const fT = !isHx && D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fT.length ? D.bars.findIndex(b => b.time === fT[0].time) : -1;
    const fJ = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
    const highVol = isHighVolDay(D.hist);
    const legs = isHx ? ladderLegs(D.bars, D.r10, trs, prevCut2 || gapBig, highVol) : v2Legs(D.bars, trs, fJ);

    // parity (베이스라인 = 원본 시뮬레이터)
    const sim = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs as never, prevCut2 || gapBig, highVol)
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, fJ, C.newModel.ssV2.win);
    const basePnl = legs.reduce((a, l) => a + legOutcomeDyn(D.bars, D.d.close, l, stopPct, false).pnl, 0);
    parityMax = Math.max(parityMax, Math.abs(basePnl - sim.pnl));
    if (Math.abs(basePnl - sim.pnl) > 1e-6) throw new Error(`parity 실패 ${name} ${D.date}`);
    cuts.push(sim.pnl <= -2.4);

    const range = pg.dayRange.get(D.date);
    if (!range) continue;
    const [r0, r1] = range;
    const dayEvA = (dir: 1 | -1) => (dir === 1 ? pg.aUp : pg.aDn).filter(e => e.i >= r0 && e.i < r1 && e.kind === "valid").map(e => ({ i1m: evTo1m(D.bars, e), px: e.px, i: e.i }));
    const dayEvB = (dir: 1 | -1) => (dir === 1 ? pg.bUp : pg.bDn).filter(e => e.i >= r0 && e.i < r1 && e.kind === "warn").map(e => ({ i1m: evTo1m(D.bars, e), px: e.px, i: e.i, grade: e.grade }));

    const byPos = new Map<number, Leg[]>();
    for (const l of legs) byPos.set(l.pos, [...(byPos.get(l.pos) ?? []), l]);
    const posCtxs: PosCtx[] = [];
    for (const [posId, posLegs] of byPos) {
      const first = posLegs[0];
      const baseEnd = Math.max(...posLegs.map(l => legOutcomeDyn(D.bars, D.d.close, l, stopPct, false).exitI));
      const entryClock = hm(D.bars[first.i0].time) + 1; // 진입봉 마감 시각
      let t0 = r1; // C 스캔 시작: 진입 이후 시작하는 첫 완결 버킷
      for (let t = r0; t < r1; t++) if (hm(pg.bars10[t].time) >= entryClock) { t0 = t; break; }
      posCtxs.push({
        pos: posId, legs: posLegs, first, baseEnd, t0, t1: r1 - 1,
        evA: dayEvA(first.dir).find(e => e.i1m > first.i0 && e.i1m < baseEnd) ?? null,
        evBs: dayEvB(first.dir).filter(e => e.i1m > first.i0 && e.i1m < baseEnd),
      });
    }
    dayCtxs.push({ D, posCtxs });
  }

  console.log(`\n════ ${name} — ${days.length}일 · parity 최대오차 ${parityMax.toExponential(1)} ════`);

  // ── ablation 사다리 ──
  const cfgs = MODE === "baseline" ? CFGS.slice(0, 1) : CFGS;
  const recsBy = new Map<string, PosRec[]>();
  for (const [label, cfg] of cfgs) {
    const dayPnls: number[] = []; const recs: PosRec[] = [];
    let cutDays = 0, skippedTot = 0;
    for (const dc of dayCtxs) {
      let pnl = 0, dayCut = false;
      for (const pc of dc.posCtxs) {
        const r = evalPos(pg, dc.D, pc, cfg);
        pnl += r.pnl; skippedTot += r.skipped; dayCut = dayCut || r.rec.cut;
        recs.push(r.rec);
      }
      dayPnls.push(pnl); if (dayCut) cutDays++;
    }
    recsBy.set(label, recs);
    const tot = dayPnls.reduce((a, b) => a + b, 0), worst = Math.min(...dayPnls);
    const gbGain = recs.filter(r => r.mfePct >= 1).map(r => r.givebackPct);
    const nC = recs.filter(r => r.pgC).length, nA = recs.filter(r => r.pgA).length;
    const nR = recs.filter(r => r.ratchetHit).length, nB = recs.filter(r => r.b13).length;
    const viol = recs.filter(r => r.ratchetViol).length;
    console.log(`  [${label.padEnd(5)}] 합계 ${s1(tot)}%p · 최악일 ${s2(worst)} · 컷일 ${cutDays} · 반납중앙(MFE≥1%) ${s2(median(gbGain))}(n=${gbGain.length})` +
      (label === "base" ? "" : ` · C청산 ${nC} · A청산 ${nA} · 래칫청산 ${nR} · B트림 ${nB} · 증액불발 ${skippedTot}${viol ? ` · ⚠래칫위반 ${viol}` : ""}`));
  }

  if (MODE === "baseline") return;

  // ── 게이트 지표 ──
  // C vs A 선행성 (§10.1-3): 같은 보유에서 둘 다 발동 가능한 케이스
  let cFirst = 0, both = 0;
  for (const dc of dayCtxs) for (const pc of dc.posCtxs) {
    const co = PG1C_DEFAULT;
    const hit = pg1cExit(pg.bars10, pg.atrBy.get(co.p)!, pc.t0, pc.t1, pc.first.dir, pc.first.px, co);
    const cI = hit ? evTo1m(dc.D.bars, { time: pg.bars10[hit.i].time, px: hit.px }) : null;
    const cOk = cI !== null && cI > pc.first.i0 && cI < pc.baseEnd;
    const aOk = !!pc.evA;
    if (cOk && aOk) { both++; if (cI! < pc.evA!.i1m) cFirst++; }
  }
  console.log(`  C vs A 선행성: 둘 다 발동 ${both}건 중 C 선행 ${cFirst}건 (${both ? Math.round(cFirst / both * 100) : 0}%)`);

  // B 등급별 적중률 (§10.1-4) — 보유 중 경고, 적중 = 12봉 내 유리극값 미갱신 & 종가 역행
  const gradeStat = { 상: { n: 0, hit: 0 }, 하: { n: 0, hit: 0 } };
  for (const dc of dayCtxs) for (const pc of dc.posCtxs) {
    const [r0d, r1d] = pg.dayRange.get(dc.D.date)!;
    for (const w of pc.evBs) {
      const endT = Math.min(w.i + 12, r1d - 1);
      if (endT <= w.i) continue;
      let extBefore = -Infinity, ext = -Infinity;
      for (let t = r0d; t <= w.i; t++) extBefore = Math.max(extBefore, pc.first.dir === 1 ? pg.bars10[t].high : -pg.bars10[t].low);
      for (let t = w.i + 1; t <= endT; t++) ext = Math.max(ext, pc.first.dir === 1 ? pg.bars10[t].high : -pg.bars10[t].low);
      const adverse = (pg.bars10[endT].close - pg.bars10[w.i].close) * pc.first.dir < 0;
      gradeStat[w.grade].n++;
      if (ext < extBefore && adverse) gradeStat[w.grade].hit++;
    }
  }
  for (const g of ["상", "하"] as const) {
    const s = gradeStat[g];
    console.log(`  PG-1B 등급 ${g}: ${s.hit}/${s.n} 적중 (${s.n ? Math.round(s.hit / s.n * 100) : 0}%)`);
  }

  // 민감도 격자 (§10.1-6): +C 단독, n×p — 합계 부호 평탄성
  const cells: string[] = [];
  for (const co of GRID) {
    let tot = 0;
    for (const dc of dayCtxs) for (const pc of dc.posCtxs) tot += evalPos(pg, dc.D, pc, { c: co }, co).pnl;
    cells.push(`n${co.n}/p${co.p} ${s1(tot)}`);
  }
  console.log(`  +C 민감도(합계): ${cells.join(" · ")}  [base ${s1(dayCtxs.reduce((a, dc) => a + dc.posCtxs.reduce((x, pc) => x + evalPos(pg, dc.D, pc, {}).pnl, 0), 0))}]`);
}

console.log(`PG-1 리플레이 v0.2 — 모드: ${MODE} (사전등록 §10.1 → ablation 사다리 → 게이트)`);
runSymbol("하이닉스(4단 사다리)", "000660", true);
runSymbol("삼성전자(v2)", "005930", false);
