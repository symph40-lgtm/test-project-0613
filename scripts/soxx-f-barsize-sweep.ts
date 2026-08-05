// F 봉 크기 확대 스윕 (사용자 지시 8/5 밤 "확인봉의 크기를 늘려봐") — 10분봉·15분봉 vs 현행 5분봉
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar, type SoxxJ } from "../lib/signal/us/soxxV2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function toNm(bars: SoxxBar[], n: number): SoxxBar[] {
  const map = new Map<number, SoxxBar>();
  for (const b of bars) {
    const k = Math.floor(b.etMin / n) * n;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...map.values()].sort((a, b) => a.etMin - b.etMin);
}
function fN(date: string, raw: SoxxBar[], hist: PredictDailyBar[], n: number, orBars: number): SoxxJ | null {
  const bn = toNm(raw, n);
  if (bn.length < orBars + 2) return null;
  const morning: MinuteBar[] = bn.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const out = runFisher({ date, dailyHistory: hist, openPx: bn[0].open, morning, prevDayMinutes: null },
    { orMinutes: orBars, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1, reboxHHMM: "09:30", reboxMinutes: 15 });
  const trs = out.transitions ?? [];
  if (!trs.length) return null;
  const k = bn.findIndex((b) => b.time === trs[0].time);
  if (k < 0) return null;
  const endMin = bn[k].etMin + n - 1;
  let i1 = raw.findIndex((b) => b.etMin >= endMin);
  if (i1 < 0) i1 = raw.length - 1;
  return { i: i1, t: raw[i1].etMin, dir: trs[0].to === "up" ? 1 : -1, px: trs[0].px };
}
async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const V: [string, number, number][] = [["10분봉·OR2봉(20분)", 10, 2], ["10분봉·OR1봉(10분)", 10, 1], ["15분봉·OR1봉(15분)", 15, 1]];
  const tot = new Map<string, { p: number; worst: number; cut: number; ts: number[] }>();
  tot.set("현행 5분봉·OR3봉(15분)", { p: 0, worst: 0, cut: 0, ts: [] });
  for (const [l] of V) tot.set(l, { p: 0, worst: 0, cut: 0, ts: [] });
  let n = 0;
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const close = reg[reg.length - 1].close;
    n++;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 });
    const s0 = scoreSoxxDay(raw, c1, fJ, close, nextOpen, true, true);
    const t0 = tot.get("현행 5분봉·OR3봉(15분)")!; t0.p += s0.p; t0.worst = Math.min(t0.worst, s0.p); if (s0.cut) t0.cut++; if (fJ) t0.ts.push(fJ.t);
    for (const [lab, sz, orB] of V) {
      const fx = fN(date, raw, hist, sz, orB);
      const sx = scoreSoxxDay(raw, c1, fx, close, nextOpen, true, true);
      const t = tot.get(lab)!; t.p += sx.p; t.worst = Math.min(t.worst, sx.p); if (sx.cut) t.cut++; if (fx) t.ts.push(fx.t);
    }
  }
  console.log(`${n}일 — 주기준 파이프라인에서 F 봉 크기만 교체 (확인 1봉 유지):`);
  for (const [lab, t] of tot) console.log(`${lab}: ${s1(t.p)}%p · 최악 ${t.worst.toFixed(2)} · 컷 ${t.cut} · F 확인 중앙 ${fmtT(Math.round(med(t.ts)))}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
