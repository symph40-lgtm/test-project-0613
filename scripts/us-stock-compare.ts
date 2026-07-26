// 미장 종목 피셔 적합성 비교 — SNDK(샌디스크)·MU(마이크론) vs SOXX (사용자 요청 2026-07-26
// "변동성 적고 추세 있어 보이는데 피셔 판정으로 이익 내기 어떤지").
//   npx tsx scripts/us-stock-compare.ts   (야후 5분봉 60일 캡 ≈ 41세션 — SOXX 관례와 동일)
// 잣대 (SOXX 스트림과 동일): 본피셔 0.15×avgRange10·확인 2봉·강돌파 0.1·반전 1봉, 09:30 창.
//   라벨 ①동일 잣대 ±0.9% ②자기 스케일(0.9 × 자기 중앙|rOC| / SOXX 중앙|rOC|).
//   경제성 = 전이 레그(진입→다음 전이/종가, 스탑 -2%) + 14:30 컷 판정의 부호적중.

import YahooFinance from "yahoo-finance2";
import { runUsFisher, ET_OPEN, ET_CLOSE } from "../lib/signal/us/models";
import type { UsBar } from "../lib/signal/us/models";
import type { PredictDailyBar } from "../lib/predict/types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const STOP = 2.0;

async function fetch5m(sym: string): Promise<Map<string, UsBar[]>> {
  const r = await yf.chart(sym, { period1: new Date(Date.now() - 59 * 86400e3), interval: "5m", includePrePost: false });
  const byDay = new Map<string, UsBar[]>();
  for (const q of r.quotes ?? []) {
    if (q.close == null || q.open == null) continue;
    const p = Object.fromEntries(etFmt.formatToParts(q.date instanceof Date ? q.date : new Date(q.date)).map((x) => [x.type, x.value]));
    const h = p.hour === "24" ? 0 : parseInt(p.hour, 10);
    const m = h * 60 + parseInt(p.minute, 10);
    if (m < ET_OPEN || m >= ET_CLOSE) continue;
    const d = `${p.year}-${p.month}-${p.day}`;
    const arr = byDay.get(d) ?? [];
    arr.push({ etMin: m, time: `${String(h).padStart(2, "0")}:${p.minute}`, open: q.open, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close, volume: typeof q.volume === "number" ? q.volume : 0 });
    byDay.set(d, arr);
  }
  for (const a of byDay.values()) a.sort((x, y) => x.etMin - y.etMin);
  return byDay;
}
async function fetchD(sym: string): Promise<PredictDailyBar[]> {
  const r = await yf.chart(sym, { period1: new Date(Date.now() - 200 * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((x): x is typeof x & { close: number; open: number; high: number; low: number } => x.close != null && x.open != null && x.high != null && x.low != null)
    .map((x) => {
      const p = Object.fromEntries(etFmt.formatToParts(x.date instanceof Date ? x.date : new Date(x.date)).map((y) => [y.type, y.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, open: x.open, high: x.high, low: x.low, close: x.close, volume: 0 };
    }).sort((a, b) => a.date.localeCompare(b.date));
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

type Res = { sym: string; sessions: number; medRoc: number; medRange: number; trendFix: number; trendScale: number; dirDays: number; hit: number; legPnl: number; legPnl2: number; legs: number; stops: number; halves: [number, number] };

async function evalSym(sym: string, rocScaleBase: number | null): Promise<Res> {
  const [byDay, daily] = await Promise.all([fetch5m(sym), fetchD(sym)]);
  const days = [...byDay.keys()].sort();
  const rocs: number[] = [], ranges: number[] = [];
  for (const d of days) {
    const reg = byDay.get(d)!;
    if (reg.length < 60) continue;
    rocs.push(Math.abs(((reg[reg.length - 1].close - reg[0].open) / reg[0].open) * 100));
    ranges.push(((Math.max(...reg.map((b) => b.high)) - Math.min(...reg.map((b) => b.low))) / reg[0].open) * 100);
  }
  const medRoc = med(rocs);
  const thrScale = rocScaleBase !== null ? 0.9 * (medRoc / rocScaleBase) : 0.9;
  let sessions = 0, trendFix = 0, trendScale = 0, dirDays = 0, hit = 0, legPnl = 0, legPnl2 = 0, legs = 0, stops = 0;
  const halves: [number, number] = [0, 0];
  const valid = days.filter((d) => (byDay.get(d)?.length ?? 0) >= 60);
  for (const d of valid) {
    const reg = byDay.get(d)!;
    const hist = daily.filter((b) => b.date < d).slice(-120);
    if (hist.length < 30) continue;
    sessions++;
    const half = valid.indexOf(d) < valid.length / 2 ? 0 : 1;
    const rOC = ((reg[reg.length - 1].close - reg[0].open) / reg[0].open) * 100;
    const hi = Math.max(...reg.map((b) => b.high)), lo = Math.min(...reg.map((b) => b.low));
    const pos = hi > lo ? (reg[reg.length - 1].close - lo) / (hi - lo) : 0.5;
    if ((rOC >= 0.9 && pos >= 0.65) || (rOC <= -0.9 && pos <= 0.35)) trendFix++;
    if ((rOC >= thrScale && pos >= 0.65) || (rOC <= -thrScale && pos <= 0.35)) trendScale++;
    // 14:30 컷 판정 (본 스트림과 동일)
    const wCut = reg.filter((b) => b.etMin + 5 <= 14 * 60 + 30);
    if (wCut.length >= 6) {
      const v = runUsFisher(wCut, hist, 0.15, { strongBreakRatio: 0.1 }).verdict;
      if (v !== "none") {
        dirDays++;
        if ((v === "leverage" && rOC > 0) || (v === "inverse" && rOC < 0)) hit++;
      }
    }
    // 전이 레그 경제성 — 5분 스텝 시뮬 (상태 전이 시 진입/전환, 스탑 -2%)
    type T = { dir: "up" | "down"; px: number; i: number };
    const trans: T[] = [];
    let prev: string = "none";
    for (let t = ET_OPEN + 30; t <= ET_CLOSE; t += 5) {
      const w = reg.filter((b) => b.etMin + 5 <= t);
      if (w.length < 6) continue;
      const v = runUsFisher(w, hist, 0.15, { strongBreakRatio: 0.1 }).verdict;
      if (v !== prev && v !== "none") trans.push({ dir: v === "leverage" ? "up" : "down", px: w[w.length - 1].close, i: w.length - 1 });
      if (v !== "none") prev = v;
    }
    const stopScaled = rocScaleBase !== null ? Math.max(2, 2.0 * (med(ranges) / 3.8)) : 2.0; // 변동성 비례 (SOXX 레인지 기준)
    for (let k = 0; k < trans.length; k++) {
      const t = trans[k];
      const endI = k + 1 < trans.length ? trans[k + 1].i : reg.length - 1;
      const dirUp = t.dir === "up";
      let pnl: number | null = null, pnl2: number | null = null;
      for (let j = t.i + 1; j <= endI; j++) {
        const adv = dirUp ? ((reg[j].low - t.px) / t.px) * 100 : ((t.px - reg[j].high) / t.px) * 100;
        if (pnl === null && adv <= -STOP) { pnl = -STOP; stops++; }
        if (pnl2 === null && adv <= -stopScaled) pnl2 = -stopScaled;
        if (pnl !== null && pnl2 !== null) break;
      }
      const exitPnl = ((reg[endI].close - t.px) / t.px) * 100 * (dirUp ? 1 : -1);
      if (pnl === null) pnl = exitPnl;
      if (pnl2 === null) pnl2 = exitPnl;
      legPnl += pnl; legPnl2 += pnl2; legs++;
      halves[half] += pnl;
    }
  }
  return { sym, sessions, medRoc, medRange: med(ranges), trendFix, trendScale, dirDays, hit, legPnl, legPnl2, legs, stops, halves };
}

async function main() {
  const soxx = await evalSym("SOXX", null);
  const base = soxx.medRoc;
  const out = [soxx];
  for (const s of ["SNDK", "MU"]) {
    try { out.push(await evalSym(s, base)); } catch (e) { console.log(`${s} 데이터 실패:`, (e as Error).message); }
  }
  console.log("\n종목 | 세션 | 중앙|rOC| | 중앙레인지 | 추세일(±0.9%) | 추세일(자기스케일) | 14:30컷 부호적중 | 레그 경제성(스탑-2%)");
  for (const r of out) {
    console.log(
      `${r.sym.padEnd(5)} | ${r.sessions} | ${r.medRoc.toFixed(2)}% | ${r.medRange.toFixed(2)}% | ${r.trendFix}/${r.sessions} (${Math.round((100 * r.trendFix) / r.sessions)}%) | ${r.trendScale}/${r.sessions} (${Math.round((100 * r.trendScale) / r.sessions)}%) | ${r.hit}/${r.dirDays} = ${r.dirDays ? Math.round((100 * r.hit) / r.dirDays) : 0}% | ${r.legs}레그 ${r.legPnl >= 0 ? "+" : ""}${r.legPnl.toFixed(1)}%p (전/후 ${r.halves[0].toFixed(1)}/${r.halves[1].toFixed(1)}·스탑 ${r.stops}) | 비례스탑 ${r.legPnl2 >= 0 ? "+" : ""}${r.legPnl2.toFixed(1)}%p`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
