// SOXX F 심판을 1분봉으로 — 5분봉(현행) 대비 (사용자 질문 8/5 밤 "확인봉을 1분봉으로 하라고 했는데"):
//   npx tsx scripts/soxx-f-1min-sweep.ts
// 현행 F = 5분봉(OR 3봉=15분·확인 1봉=5분·반전 1봉). 1분봉 변형: OR 15봉(동일 15분), 확인·반전을
// 5분(동일 시간)/3분/1분로 스윕. 나머지 파이프라인(창1·수정안·보호·프리진입·rebox)은 주기준 그대로.
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

function f1m(date: string, raw: SoxxBar[], hist: PredictDailyBar[], conf: number, rev: number): SoxxJ | null {
  const morning: MinuteBar[] = raw.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const out = runFisher({ date, dailyHistory: hist, openPx: raw[0].open, morning, prevDayMinutes: null },
    { orMinutes: 15, offsetRangeRatio: 0.05, confirmMinutes: conf, reversalMinutes: rev, strongBreakRatio: 0.1, reboxHHMM: "09:30", reboxMinutes: 15 });
  const trs = out.transitions ?? [];
  if (!trs.length) return null;
  const i = raw.findIndex((b) => b.time === trs[0].time);
  if (i < 0) return null;
  return { i, t: raw[i].etMin, dir: trs[0].to === "up" ? 1 : -1, px: trs[0].px };
}

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const variants: [string, number, number][] = [["1분봉 확인5·반전5", 5, 5], ["1분봉 확인3·반전3", 3, 3], ["1분봉 확인1·반전1", 1, 1]];
  const tot = new Map<string, { p: number; worst: number; cut: number; ts: number[] }>();
  tot.set("현행(5분봉)", { p: 0, worst: 0, cut: 0, ts: [] });
  for (const [lab] of variants) tot.set(lab, { p: 0, worst: 0, cut: 0, ts: [] });
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
    const t0 = tot.get("현행(5분봉)")!; t0.p += s0.p; t0.worst = Math.min(t0.worst, s0.p); if (s0.cut) t0.cut++; if (fJ) t0.ts.push(fJ.t);
    for (const [lab, conf, rev] of variants) {
      const fx = f1m(date, raw, hist, conf, rev);
      const sx = scoreSoxxDay(raw, c1, fx, close, nextOpen, true, true);
      const t = tot.get(lab)!; t.p += sx.p; t.worst = Math.min(t.worst, sx.p); if (sx.cut) t.cut++; if (fx) t.ts.push(fx.t);
    }
  }
  console.log(`${n}일 — 주기준 파이프라인(rebox+보호+프리진입)에서 F 봉 크기만 교체:`);
  for (const [lab, t] of tot) console.log(`${lab}: ${s1(t.p)}%p · 최악 ${t.worst.toFixed(2)} · 컷 ${t.cut} · F 확인 중앙 ${fmtT(Math.round(med(t.ts)))}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
