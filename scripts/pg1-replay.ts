// PG-1 이익 보호 매도신호 — 오프라인 리플레이 (기획 docs/pg1-profit-guard-spec.md v0.2 §7):
//   npx tsx scripts/pg1-replay.ts --baseline    ← 현행 청산의 반납률 분포만 (사전등록용, PG 계산 안 함)
//   npx tsx scripts/pg1-replay.ts --ablation    ← 베이스라인 vs +PG-1A vs +PG-1B vs 둘 다 + 제외크로스 검증
// 레그 재구성은 simLadder(하닉 4단 사다리)·simV2(삼전)를 미러링하되, 일별 레그 합계가 원본 시뮬레이터
// 출력과 일치함을 하드 assert — 미러가 어긋나면 즉시 중단(기획서 §7 베이스라인 정합).
// lookahead 가드: PG 판정은 마감 10분봉만 참조(profitGuard.ts 구조 보장), 10분봉 종가 = 해당 버킷 마지막
// 1분봉 종가임을 이벤트마다 assert. 당일 고점 참조는 사후 반납률 '측정'에만 사용(신호에 미사용).
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
import { agg10m, smaSeries, pg1aStream, pg1bStream, PG1A_DEFAULT, PG1B_DEFAULT, type Bar10, type Pg1aEvent, type Pg1bEvent } from "../lib/predict/profitGuard";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE = resolve(process.cwd(), ".predict-cache");
const MODE = process.argv.includes("--ablation") ? "ablation" : "baseline";
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };

// kr-overnight-sweep.ts collect()와 동일 — 233일 캐시에서 hist 15일 워밍업 후 사용
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

// ── 레그 미러 (simLadder/simV2와 산식 동일 — 일별 parity assert로 보증) ──
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

function v2Legs(bars: MinuteBar[], r10: number, trs: { i: number; to: string; px: number }[], fJ: { i: number; t: number; dir: 1 | -1; px: number } | null): Leg[] {
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

// tranche 산식 동일 + 청산 시점·가격 반환. pgExitI 지정 시 그 봉 종가 청산(스탑이 먼저면 스탑 우선 — 컷 헌법)
function legOutcome(bars: MinuteBar[], close: number, leg: Leg, stopPct: number, pgExitI?: number, pgExitPx?: number): { pnl: number; cut: boolean; exitI: number; exitPx: number; pg: boolean } {
  const s = stopPct / 100;
  const baseLim = leg.endI ?? bars.length;
  const lim = pgExitI !== undefined ? Math.min(baseLim, pgExitI + 1) : baseLim; // 스탑 스캔은 청산 봉까지
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

// ── 10분봉 전 기간 시리즈 + PG 이벤트 (일간 연결 MA) ──
type Pg = {
  bars10: Bar10[]; dayRange: Map<string, [number, number]>;
  aUp: Pg1aEvent[]; aDn: Pg1aEvent[]; bUp: Pg1bEvent[]; bDn: Pg1bEvent[];
  aUp2: Pg1aEvent[]; aDn2: Pg1aEvent[]; // 탐색판: 제외를 갭 수렴 패턴만으로 한정 (사전등록 밖 — 명기)
  ma20: (number | null)[];
};
function buildPg(allDates: string[], regByDate: Map<string, MinuteBar[]>): Pg {
  const bars10: Bar10[] = []; const dayRange = new Map<string, [number, number]>();
  for (const date of allDates) {
    const s = bars10.length;
    bars10.push(...agg10m(regByDate.get(date)!, date));
    dayRange.set(date, [s, bars10.length]);
  }
  const ma5 = smaSeries(bars10, 5), ma20 = smaSeries(bars10, 20);
  const gc = { ...PG1A_DEFAULT, exclusion: "gapConv" as const };
  return {
    bars10, dayRange, ma20,
    aUp: pg1aStream(bars10, ma5, ma20, 1, PG1A_DEFAULT), aDn: pg1aStream(bars10, ma5, ma20, -1, PG1A_DEFAULT),
    aUp2: pg1aStream(bars10, ma5, ma20, 1, gc), aDn2: pg1aStream(bars10, ma5, ma20, -1, gc),
    bUp: pg1bStream(bars10, 1, PG1B_DEFAULT), bDn: pg1bStream(bars10, -1, PG1B_DEFAULT),
  };
}

// 10분봉 이벤트 → 그날 1분봉 인덱스(버킷 마지막 봉). 종가 일치 하드 assert (10분 집계 ↔ 1분 정합).
function evTo1m(dayBars: MinuteBar[], ev: { time: string; px: number }): number {
  const m0 = hm(ev.time), endM = ev.time === "15:20" ? 15 * 60 + 31 : m0 + 10;
  let idx = -1;
  for (let i = 0; i < dayBars.length; i++) {
    const t = hm(dayBars[i].time);
    if (t >= m0 && t < endM && dayBars[i].time >= "09:00") idx = i;
  }
  if (idx < 0) throw new Error(`evTo1m: 버킷 ${ev.time} 1분봉 없음`);
  if (Math.abs(dayBars[idx].close - ev.px) > 1e-9) throw new Error(`evTo1m: 종가 불일치 ${ev.time} ${dayBars[idx].close} != ${ev.px}`);
  return idx;
}

// 종가×MA20 하향 이탈 변형 (§3.4 대안 — ablation 전용, 유효성 조건 없음·탐색적)
function ma20BreakEvents(bars10: Bar10[], ma20: (number | null)[], dir: 1 | -1): { i: number; date: string; time: string; px: number }[] {
  const out: { i: number; date: string; time: string; px: number }[] = [];
  for (let t = 1; t < bars10.length; t++) {
    const p = ma20[t - 1], c = ma20[t];
    if (p === null || c === null || bars10[t].nMin === 0 || bars10[t - 1].nMin === 0) continue;
    const crossed = dir === 1 ? bars10[t - 1].close >= p && bars10[t].close < c : bars10[t - 1].close <= p && bars10[t].close > c;
    if (crossed) out.push({ i: t, date: bars10[t].date, time: bars10[t].time, px: bars10[t].close });
  }
  return out;
}

type PosRec = {
  date: string; pos: number; dir: 1 | -1; entryI: number; entryPx: number; sizeMax: number;
  exitI: number; exitPx: number; pnl: number; cut: boolean; pgExit: boolean; mfePct: number; givebackPct: number;
};

function runSymbol(name: string, code: string, isHx: boolean) {
  const { days, allDates, regByDate } = collect(code);
  const pg = MODE === "ablation" ? buildPg(allDates, regByDate) : null;
  const a20Up = pg ? ma20BreakEvents(pg.bars10, pg.ma20, 1) : [];
  const a20Dn = pg ? ma20BreakEvents(pg.bars10, pg.ma20, -1) : [];
  const stopPct = isHx ? 2.5 : 1.5;
  const cuts: boolean[] = [];
  type Policy = "base" | "A" | "B" | "AB" | "A20" | "A2";
  const policies: Policy[] = MODE === "ablation" ? ["base", "A", "B", "AB", "A20", "A2"] : ["base"];
  const dayPnl: Record<Policy, number[]> = { base: [], A: [], B: [], AB: [], A20: [], A2: [] };
  const posRecs: Record<Policy, PosRec[]> = { base: [], A: [], B: [], AB: [], A20: [], A2: [] };
  const cutDays: Record<Policy, number> = { base: 0, A: 0, B: 0, AB: 0, A20: 0, A2: 0 };
  const skippedAdds: Record<Policy, number> = { base: 0, A: 0, B: 0, AB: 0, A20: 0, A2: 0 };
  const exclChecks: { date: string; time: string; wouldPnl: number; actualPnl: number }[] = [];
  const exclChecks2: { date: string; time: string; wouldPnl: number; actualPnl: number }[] = [];
  const bWarnsInHold: { date: string; i: number; time: string; dir: 1 | -1; hit: boolean | null; leadToA: number | null }[] = [];
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

    const legs = isHx ? ladderLegs(D.bars, D.r10, trs, prevCut2 || gapBig, highVol) : v2Legs(D.bars, D.r10, trs, fJ);

    // ── parity: 레그 합계 == 원본 시뮬레이터 (하드 assert) ──
    const sim = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs as never, prevCut2 || gapBig, highVol)
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, fJ, C.newModel.ssV2.win);
    const basePnl = legs.reduce((a, l) => a + legOutcome(D.bars, D.d.close, l, stopPct).pnl, 0);
    parityMax = Math.max(parityMax, Math.abs(basePnl - sim.pnl));
    if (Math.abs(basePnl - sim.pnl) > 1e-6) throw new Error(`parity 실패 ${name} ${D.date}: 미러 ${basePnl} vs 원본 ${sim.pnl}`);
    cuts.push(sim.pnl <= -2.4); // 서킷브레이커 이력은 베이스라인 기준 고정 (스윕과 동일)

    // 그날 PG 이벤트 (1분 인덱스로 매핑)
    const range = pg?.dayRange.get(D.date);
    const dayEv = (evs: { i: number; date: string; time: string; px: number; kind?: string }[], kindFilter?: string) =>
      (range ? evs.filter(e => e.i >= range[0] && e.i < range[1] && (!kindFilter || e.kind === kindFilter)) : [])
        .map(e => ({ ...e, i1m: evTo1m(D.bars, e) }));
    const evA = { 1: dayEv(pg?.aUp ?? [], "valid"), [-1]: dayEv(pg?.aDn ?? [], "valid") } as Record<1 | -1, { i1m: number; px: number; time: string; i: number }[]>;
    const evA2 = { 1: dayEv(pg?.aUp2 ?? [], "valid"), [-1]: dayEv(pg?.aDn2 ?? [], "valid") } as Record<1 | -1, { i1m: number; px: number; time: string; i: number }[]>;
    const evB = { 1: dayEv(pg?.bUp ?? [], "warn"), [-1]: dayEv(pg?.bDn ?? [], "warn") } as Record<1 | -1, { i1m: number; px: number; time: string; i: number }[]>;
    const evA20 = { 1: dayEv(a20Up), [-1]: dayEv(a20Dn) } as Record<1 | -1, { i1m: number; px: number; time: string; i: number }[]>;
    const evAexcl = { 1: dayEv(pg?.aUp ?? [], "excluded"), [-1]: dayEv(pg?.aDn ?? [], "excluded") } as Record<1 | -1, { i1m: number; px: number; time: string; i: number }[]>;
    const evA2excl = { 1: dayEv(pg?.aUp2 ?? [], "excluded"), [-1]: dayEv(pg?.aDn2 ?? [], "excluded") } as Record<1 | -1, { i1m: number; px: number; time: string; i: number }[]>;

    for (const pol of policies) {
      let pnl = 0, dayCut = false;
      const byPos = new Map<number, Leg[]>();
      for (const l of legs) byPos.set(l.pos, [...(byPos.get(l.pos) ?? []), l]);
      for (const [posId, posLegs] of byPos) {
        const first = posLegs[0];
        // 포지션 첫 진입 후 첫 PG 이벤트 (베이스라인 강제청산 이전 것만 유효 — 이후는 이미 청산된 상태)
        const baseEnd = Math.max(...posLegs.map(l => legOutcome(D.bars, D.d.close, l, stopPct).exitI));
        const pick = (evs: { i1m: number; px: number }[]) => evs.find(e => e.i1m > first.i0 && e.i1m < baseEnd) ?? null;
        let pgEv: { i1m: number; px: number } | null = null;
        if (pol === "A") pgEv = pick(evA[first.dir]);
        else if (pol === "A2") pgEv = pick(evA2[first.dir]);
        else if (pol === "B") pgEv = pick(evB[first.dir]);
        else if (pol === "A20") pgEv = pick(evA20[first.dir]);
        else if (pol === "AB") {
          const a = pick(evA[first.dir]), b = pick(evB[first.dir]);
          pgEv = a && b ? (a.i1m <= b.i1m ? a : b) : a ?? b;
        }
        let exitI = -1, exitPx = NaN, posPnl = 0, posCut = false, pgUsed = false, sizeMax = 0;
        for (const l of posLegs) {
          if (pgEv && l.i0 >= pgEv.i1m) { skippedAdds[pol]++; continue; } // PG 청산 후 증액 불발
          const o = legOutcome(D.bars, D.d.close, l, stopPct, pgEv?.i1m, pgEv?.px);
          posPnl += o.pnl; posCut = posCut || o.cut; pgUsed = pgUsed || o.pg; sizeMax += l.size;
          if (o.exitI > exitI) { exitI = o.exitI; exitPx = o.exitPx; }
        }
        if (exitI < 0) continue;
        // 반납률 측정 (사후·신호 미사용): 진입 후~청산까지 유리 극값 대비 청산가
        let fav = first.px;
        for (let k = first.i0 + 1; k <= Math.min(exitI, D.bars.length - 1); k++) {
          const b = D.bars[k];
          fav = first.dir === 1 ? Math.max(fav, b.high) : Math.min(fav, b.low);
        }
        const mfePct = ((fav - first.px) / first.px) * 100 * first.dir;
        const givebackPct = ((fav - exitPx) / first.px) * 100 * first.dir;
        posRecs[pol].push({ date: D.date, pos: posId, dir: first.dir, entryI: first.i0, entryPx: first.px, sizeMax, exitI, exitPx, pnl: posPnl, cut: posCut, pgExit: pgUsed, mfePct, givebackPct });
        pnl += posPnl; dayCut = dayCut || posCut;
      }
      dayPnl[pol].push(pnl);
      if (dayCut) cutDays[pol]++;
    }

    // 제외 크로스 정당성 (§3.3): 보유 중 발생한 제외 크로스 — 거기서 청산했다면 vs 실제 베이스라인
    if (MODE === "ablation") {
      const byPos = new Map<number, Leg[]>();
      for (const l of legs) byPos.set(l.pos, [...(byPos.get(l.pos) ?? []), l]);
      for (const [, posLegs] of byPos) {
        const first = posLegs[0];
        const baseEnd = Math.max(...posLegs.map(l => legOutcome(D.bars, D.d.close, l, stopPct).exitI));
        for (const [evsX, sink] of [[evAexcl, exclChecks], [evA2excl, exclChecks2]] as const) {
          const ex = evsX[first.dir].find(e => e.i1m > first.i0 && e.i1m < baseEnd);
          if (!ex) continue;
          let would = 0, actual = 0;
          for (const l of posLegs) {
            if (l.i0 >= ex.i1m) continue;
            would += legOutcome(D.bars, D.d.close, l, stopPct, ex.i1m, ex.px).pnl;
            actual += legOutcome(D.bars, D.d.close, l, stopPct).pnl;
          }
          sink.push({ date: D.date, time: D.bars[ex.i1m].time, wouldPnl: would, actualPnl: actual });
        }
        // PG-1B 적중 채점 (§6 정의: 경고 후 12봉 내 유리극값 미갱신 & 역행 진행) + B→A 선행
        for (const w of evB[first.dir].filter(e => e.i1m > first.i0 && e.i1m < baseEnd)) {
          const r = pg!.dayRange.get(D.date)!;
          const M = 12, endT = Math.min(w.i + M, r[1] - 1);
          let hit: boolean | null = null;
          if (endT > w.i) {
            let ext = -Infinity, extBefore = -Infinity;
            for (let t = r[0]; t <= w.i; t++) extBefore = Math.max(extBefore, first.dir === 1 ? pg!.bars10[t].high : -pg!.bars10[t].low);
            for (let t = w.i + 1; t <= endT; t++) ext = Math.max(ext, first.dir === 1 ? pg!.bars10[t].high : -pg!.bars10[t].low);
            const adverse = (pg!.bars10[endT].close - pg!.bars10[w.i].close) * first.dir < 0;
            hit = ext < extBefore && adverse;
          }
          const nextA = evA[first.dir].find(e => e.i1m > w.i1m && e.i1m < baseEnd);
          bWarnsInHold.push({ date: D.date, i: w.i, time: w.time, dir: first.dir, hit, leadToA: nextA ? nextA.i - w.i : null });
        }
      }
    }
  }

  // ── 출력 ──
  console.log(`\n════ ${name} — ${days.length}일 · 미러 parity 최대오차 ${parityMax.toExponential(1)} ════`);
  const report = (pol: Policy) => {
    const tot = dayPnl[pol].reduce((a, b) => a + b, 0);
    const worst = Math.min(...dayPnl[pol]);
    const recs = posRecs[pol];
    const gb = recs.map(r => r.givebackPct);
    const gbGain = recs.filter(r => r.mfePct >= 1).map(r => r.givebackPct);
    const pgN = recs.filter(r => r.pgExit).length;
    console.log(`  [${pol.padEnd(4)}] 합계 ${s1(tot)}%p · 최악일 ${s2(worst)} · 컷일 ${cutDays[pol]} · 포지션 ${recs.length}` +
      ` · 반납 중앙(전체) ${s2(median(gb))} · 반납 중앙(MFE≥1%) ${s2(median(gbGain))}(n=${gbGain.length}) · 평균 ${s2(mean(gbGain))}` +
      (pol === "base" ? "" : ` · PG청산 ${pgN}회 · 증액불발 ${skippedAdds[pol]}`));
  };
  for (const pol of policies) report(pol);

  if (MODE === "baseline") {
    // 사전등록용 분포 상세 (PG 미계산)
    const recs = posRecs.base;
    const gbGain = recs.filter(r => r.mfePct >= 1).map(r => r.givebackPct).sort((a, b) => a - b);
    const q = (p: number) => gbGain.length ? gbGain[Math.min(gbGain.length - 1, Math.floor(p * gbGain.length))] : NaN;
    console.log(`  MFE≥1% 포지션 ${gbGain.length}개 반납 분포: p25 ${s2(q(0.25))} · p50 ${s2(q(0.5))} · p75 ${s2(q(0.75))} · p90 ${s2(q(0.9))}`);
    const dirSplit = (d: 1 | -1) => {
      const g = recs.filter(r => r.dir === d && r.mfePct >= 1).map(r => r.givebackPct);
      return `${d === 1 ? "레버" : "인버"} n=${g.length} 중앙 ${s2(median(g))}`;
    };
    console.log(`  방향별: ${dirSplit(1)} / ${dirSplit(-1)}`);
  } else {
    // 제외 크로스 정당성 (등록판 / 탐색판)
    for (const [label, arr] of [["등록판(sameDir)", exclChecks], ["탐색판(gapConv)", exclChecks2]] as const) {
      const good = arr.filter(e => e.wouldPnl < e.actualPnl).length;
      console.log(`  제외 크로스 ${label}: ${arr.length}건 — 제외가 옳았음 ${good}건 (${arr.length ? Math.round(good / arr.length * 100) : 0}%)`);
    }
    // PG-1B 적중률·선행
    const judged = bWarnsInHold.filter(w => w.hit !== null);
    const hits = judged.filter(w => w.hit).length;
    const leads = bWarnsInHold.filter(w => w.leadToA !== null).map(w => w.leadToA!);
    console.log(`  PG-1B 보유 중 경고 ${bWarnsInHold.length}건 · 적중 ${hits}/${judged.length} (${judged.length ? Math.round(hits / judged.length * 100) : 0}%) · B→A 선행 중앙 ${median(leads).toFixed(0)}봉 (n=${leads.length})`);
    // 조기청산 비용 vs 반납 감소: PG로 청산된 포지션의 (해당 정책 pnl - 베이스라인 pnl) 분해
    const baseByKey = new Map(posRecs.base.map(r => [`${r.date}#${r.pos}`, r]));
    // 방향별 순효과 — SOXX 인버스 한정 보호청산(8/4 채택) 선례 대응: 인버스 레그만 적용했을 때의 delta
    for (const pol of ["A", "A2", "B", "AB", "A20"] as const) {
      let dLev = 0, dInv = 0;
      for (const r of posRecs[pol]) {
        const b = baseByKey.get(`${r.date}#${r.pos}`);
        if (!b) continue;
        if (r.dir === 1) dLev += r.pnl - b.pnl; else dInv += r.pnl - b.pnl;
      }
      console.log(`  방향별 순효과 [${pol}]: 레버 ${s1(dLev)}%p / 인버 ${s1(dInv)}%p`);
    }
    for (const pol of ["A", "A2"] as const) {
      let oppLoss = 0, saved = 0, nWorse = 0, nBetter = 0;
      for (const r of posRecs[pol].filter(x => x.pgExit)) {
        const b = baseByKey.get(`${r.date}#${r.pos}`);
        if (!b) continue;
        const d = r.pnl - b.pnl;
        if (d >= 0) { saved += d; nBetter++; } else { oppLoss += -d; nWorse++; }
      }
      console.log(`  PG-1${pol === "A" ? "A(등록판)" : "A 탐색판(gapConv)"} 청산 포지션: 개선 ${nBetter}건 +${saved.toFixed(1)}%p vs 악화 ${nWorse}건 -${oppLoss.toFixed(1)}%p (순 ${s1(saved - oppLoss)}%p)`);
    }
  }
  return { dayPnl, posRecs };
}

console.log(`PG-1 리플레이 — 모드: ${MODE} (사전등록 순서: baseline → §6.1 기입 → ablation)`);
runSymbol("하이닉스(4단 사다리)", "000660", true);
runSymbol("삼성전자(v2)", "005930", false);
