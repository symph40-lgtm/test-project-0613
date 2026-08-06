// 신모델 vs 기존 계층 — 전체 vs 최근 1개월 (사용자 지시 2026-08-06):
//   npx tsx scripts/nm-vs-legacy-window.ts
// 기존 정의(각 라이브 지침 재현): 하이닉스 계층 = F/M/본 레그 회계 20/30/50 가중·스탑 -2.5
//   (candleWindow nm_cmp hier와 동일 산식) / 삼성전자 계층 = 동일 구조(ss cfg·스탑 -1.5·본은 고변동일 트레일)
//   / SOXX 기존 = 현행 F 전이 레그 회계·스탑 -2 (us-soxx-1y-sweep A와 동일). 신모델은 nm-window-analysis와 동일.
// ⚠일봉·r10을 캐시에서 재구성한 근사 — 공식 수치와 수%p 오차 가능(하닉 신사다리 +118.3 vs 공식 +118.2로 검증됨).

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher, type FisherCfg } from "../lib/predict/models/fisher";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

type Tr = { time: string; to: "up" | "down"; px: number };
// 계층 레그 회계 (candleWindow nm_cmp의 leg와 동일): 전이=진입/전환, 컷 앵커=확인가, 잔여 종가
function leg(bb: MinuteBar[], tl: Tr[], close: number, stopPct: number): number {
  const idx = new Map<string, number>();
  bb.forEach((x, i) => { if (!idx.has(x.time)) idx.set(x.time, i); });
  const s = stopPct / 100;
  let p = 0;
  for (let k = 0; k < tl.length; k++) {
    const t = tl[k];
    const i0 = idx.get(t.time);
    if (i0 === undefined) continue;
    const endI = k + 1 < tl.length ? idx.get(tl[k + 1].time) ?? bb.length : bb.length;
    const dir = t.to === "up" ? 1 : -1;
    let cutHit = false;
    for (let i = i0 + 1; i < endI; i++) {
      if (dir === 1 ? bb[i].low <= t.px * (1 - s) : bb[i].high >= t.px * (1 + s)) { cutHit = true; break; }
    }
    p += cutHit ? -stopPct : (((k + 1 < tl.length ? tl[k + 1].px : close) - t.px) / t.px) * 100 * dir;
  }
  return p;
}

type DayPair = { date: string; nm: number; old: number; oc: number };
function loadDay(f: string): MinuteBar[] | null {
  const p = resolve(CACHE, f);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]) : null;
}

function krPairs(code: string, calc: (bars: MinuteBar[], krx: MinuteBar[], hist: PredictDailyBar[], r10: number, prevCut2: boolean, close: number) => { nm: number; old: number }): DayPair[] {
  const files = readdirSync(CACHE).filter((f) => new RegExp(`^${code}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort();
  const daily: PredictDailyBar[] = [];
  const out: DayPair[] = [];
  const cuts: boolean[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = loadDay(f) ?? [];
    if (reg.length < 100) continue;
    const pre = loadDay(`${code}NX-${date}.json`) ?? [];
    const hist = daily.slice(-120);
    const day: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map((b) => b.high)), low: Math.min(...reg.map((b) => b.low)), volume: 0 };
    if (hist.length >= 15) {
      const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
      const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
      const r = calc([...pre, ...reg], reg, hist, r10, prevCut2, day.close);
      out.push({ date, nm: Math.round(r.nm * 100) / 100, old: Math.round(r.old * 100) / 100, oc: ((day.close - day.open) / day.open) * 100 });
      cuts.push(r.nm <= -2.4);
    }
    daily.push(day);
  }
  return out;
}

function show(name: string, rows: DayPair[], lastFrom: string) {
  const sum = (a: DayPair[], f: (r: DayPair) => number) => a.reduce((x, r) => x + f(r), 0);
  const recent = rows.filter((r) => r.date >= lastFrom);
  const line = (label: string, a: DayPair[]) =>
    console.log(`${label} (${a.length}일): 신모델 ${s1(sum(a, (r) => r.nm))}%p (일당 ${s2(sum(a, (r) => r.nm) / Math.max(1, a.length))}) vs 기존 ${s1(sum(a, (r) => r.old))}%p (일당 ${s2(sum(a, (r) => r.old) / Math.max(1, a.length))}) → 격차 ${s1(sum(a, (r) => r.nm) - sum(a, (r) => r.old))}`);
  console.log(`\n════ ${name} ════`);
  line("전체", rows);
  line(`최근 1개월(${lastFrom}~)`, recent);
  line(`최근 1개월 ∧ |시가→종가|≥5%`, recent.filter((r) => Math.abs(r.oc) >= 5));
  line(`전체 ∧ |시가→종가|≥5%`, rows.filter((r) => Math.abs(r.oc) >= 5));
}

async function main() {
  // 하이닉스: 신사다리 vs 계층(F/M/본 20/30/50·스탑 -2.5·본 전일 트레일)
  const hxF: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const hxM: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const hxB: FisherCfg = { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes };
  const hx = krPairs("000660", (bars, krx, hist, r10, prevCut2, close) => {
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const prevClose = hist[hist.length - 1].close;
    const gapBig = Math.abs(((krx[0].open - prevClose) / prevClose) * 100) >= 4;
    const nm = simLadder(bars, r10, close, trs, prevCut2 || gapBig, isHighVolDay(hist)).pnl;
    const mk = (b: MinuteBar[]) => ({ date: "x", dailyHistory: hist, openPx: b[0].open, morning: b, prevDayMinutes: null });
    const fT = runFisher(mk(bars), hxF).transitions ?? [];
    const mT = runFisher(mk(bars), hxM).transitions ?? [];
    const bT = krx.length >= 20 ? (runFisher(mk(krx), hxB).transitions ?? []) : [];
    const old = 0.2 * leg(bars, fT, close, 2.5) + 0.3 * leg(bars, mT, close, 2.5) + 0.5 * leg(krx, bT, close, 2.5);
    return { nm, old };
  });
  show("하이닉스 — 신사다리 vs 계층", hx, "2026-07-01");

  // 삼성전자: v2(5봉·rebox) vs 계층(ss cfg·스탑 -1.5·본 고변동일 트레일)
  const ssF: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const ssM: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  const ss = krPairs("005930", (bars, krx, hist, r10, _pc, close) => {
    const fTrs = bars.length >= 20 ? (runFisher({ date: "x", dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    const fJ = fTrs.length && fIdx >= 0 ? { i: fIdx, t: hhmmToMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    const nm = simV2(bars, r10, close, C.newModel.ssV2.tan, fJ, C.newModel.ssV2.win).pnl;
    const mk = (b: MinuteBar[]) => ({ date: "x", dailyHistory: hist, openPx: b[0].open, morning: b, prevDayMinutes: null });
    const ssBcfg: FisherCfg = { strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, ...(isHighVolDay(hist) ? { trailRangeRatio: C.ssTrail.rangeRatio, trailConfirmMinutes: C.ssTrail.confirmMinutes } : {}) };
    const fT = runFisher(mk(bars), ssF).transitions ?? [];
    const mT = runFisher(mk(bars), ssM).transitions ?? [];
    const bT = krx.length >= 20 ? (runFisher(mk(krx), ssBcfg).transitions ?? []) : [];
    const old = 0.2 * leg(bars, fT, close, 1.5) + 0.3 * leg(bars, mT, close, 1.5) + 0.5 * leg(krx, bT, close, 1.5);
    return { nm, old };
  });
  show("삼성전자 — v2(5봉) vs 계층", ss, "2026-07-01");

  // SOXX: v2 주기준 vs 현행 F 레그 회계 (스탑 -2·전이 전부 전환·프리장 진입은 개장가)
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const soxxDaily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = soxxDaily.map((b) => b.date);
  const dBy = new Map(soxxDaily.map((b) => [b.date, b]));
  const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const to5 = (bars: SoxxBar[]): SoxxBar[] => {
    const map = new Map<number, SoxxBar>();
    for (const b of bars) {
      const k = Math.floor(b.etMin / 5) * 5;
      const cur = map.get(k);
      if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
      else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
    }
    return [...map.values()].sort((a, b) => a.etMin - b.etMin);
  };
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const us: DayPair[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = soxxDaily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 });
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const close = reg[reg.length - 1].close;
    const nm = scoreSoxxDay(raw, c1, fJ, close, nextOpen, true, true).p;
    // 기존: F(무rebox) 전이 전부 레그 회계
    const b5 = to5(raw);
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
    const t5 = new Map<string, number>(b5.map((b, k) => [b.time, k]));
    const trs: { i: number; dir: 1 | -1; px: number }[] = (fOut.transitions ?? []).flatMap((t) => {
      const k5 = t5.get(t.time);
      if (k5 === undefined) return [];
      const endMin = b5[k5].etMin + 4;
      let i1 = raw.findIndex((b) => b.etMin >= endMin);
      if (i1 < 0) i1 = raw.length - 1;
      return [{ i: i1, dir: (t.to === "up" ? 1 : -1) as 1 | -1, px: t.px }];
    });
    let old = 0;
    for (let k = 0; k < trs.length; k++) {
      let { i: i0, px } = trs[k];
      if (raw[i0].etMin < SOXX_ET_OPEN) { i0 = raw.findIndex((b) => b.etMin >= SOXX_ET_OPEN); px = reg[0].open; }
      const nx = k + 1 < trs.length ? trs[k + 1] : null;
      const lim = nx && nx.i > i0 ? nx.i : nx ? i0 : raw.length;
      if (nx && nx.i <= i0) continue;
      let cutHit = false;
      for (let i = i0 + 1; i < lim; i++) {
        if (raw[i].etMin < SOXX_ET_OPEN) continue;
        if (trs[k].dir === 1 ? raw[i].low <= px * 0.98 : raw[i].high >= px * 1.02) { cutHit = true; break; }
      }
      old += cutHit ? -2 : (((nx ? nx.px : close) - px) / px) * 100 * trs[k].dir;
    }
    us.push({ date, nm: Math.round(nm * 100) / 100, old: Math.round(old * 100) / 100, oc: ((close - reg[0].open) / reg[0].open) * 100 });
  }
  show("SOXX — v2 주기준 vs 현행 F", us, "2026-07-07");
}
main().catch((e) => { console.error(e); process.exit(1); });
