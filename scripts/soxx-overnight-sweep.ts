// SOXX v2 오버나이트 청산 실측 (사용자 지시 8/3 "정교화" 후속 — 격차의 구조 가설 검증):
//   npx tsx scripts/soxx-overnight-sweep.ts
// 가설: 미장은 정보가 오버나이트 갭으로 소화됨 — 당일청산 v2는 갭 수익을 포기. 삼전과의 격차 원인.
// ① 진단: 일중(시가→종가) vs 오버나이트(전일종가→시가) 변동 배분 — SOXX vs 삼전
// ② 청산 변형: A 당일 종가(기준 +55.1) / B 공통일(F 동의)만 오버나이트 1박 → 다음날 시가 청산 /
//    C 전 포지션 오버나이트 1박. 스탑 -2%(장중)·오버나이트 구간은 스탑 불가(갭 리스크 그대로 측정).
// 셀: 6봉·1.2 (①의 최고 셀 — 6봉·1.0과 동률 평원).

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const ET_OPEN = 570, ET_CLOSE = 960, ET_PRE = 420;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
type Dir = 1 | -1;
type Raw = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
type Tr = { i: number; t: number; dir: Dir; px: number };
const bmid = (b: Raw) => (b.open + b.close) / 2;
const WIN = 6, TAN = 1.2, STOP = 2.0;

function unitArrL(bars: Raw[], fallback: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : fallback;
    return Math.max(u * 0.5, 1e-9);
  });
}
function cumFirst(bars: Raw[], unit: number[]): Tr | null {
  const w = WIN - 1;
  for (let t = w; t < bars.length; t++) {
    if (bars[t].etMin < ET_OPEN) continue;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - w])) * dir >= TAN * unit[t - w] * w) return { i: t, t: bars[t].etMin, dir, px: bars[t].close };
    }
  }
  return null;
}
function to5m(bars: Raw[]): Raw[] {
  const map = new Map<number, Raw>();
  for (const b of bars) {
    const k = Math.floor(b.etMin / 5) * 5;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...map.values()].sort((a, b) => a.etMin - b.etMin);
}

async function main() {
  // ① 변동 배분 진단
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const sx: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const ss = await fetchDailyPredict("005930", 300);
  const split = (bars: PredictDailyBar[], label: string) => {
    const intra: number[] = [], ovn: number[] = [];
    const b = bars.slice(-250);
    for (let i = 1; i < b.length; i++) {
      intra.push(Math.abs(b[i].close / b[i].open - 1) * 100);
      ovn.push(Math.abs(b[i].open / b[i - 1].close - 1) * 100);
    }
    console.log(`${label}: 일중 |시가→종가| 중앙 ${med(intra).toFixed(2)}% vs 오버나이트 |갭| 중앙 ${med(ovn).toFixed(2)}% (비율 ${(med(ovn) / med(intra)).toFixed(2)})`);
  };
  console.log(`[① 변동 배분 — 최근 250일]`);
  split(sx, "SOXX");
  split(ss, "삼전");

  // ② 청산 변형
  const files = readdirSync(resolve(process.cwd(), ".predict-cache")).filter((f) => /^SOXXA-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  type DayD = { date: string; raw: Raw[]; unit: number[]; regOpenI: number; close: number; fJ: Tr | null; nextOpen: number | null };
  const days: DayD[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(process.cwd(), `.predict-cache/${f}`), "utf8")) as Raw[];
    const raw = rawAll.filter((b) => b.etMin >= ET_PRE && b.etMin < ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= ET_OPEN);
    const hist = sx.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const b5 = to5m(raw);
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
    const trs = fOut.transitions ?? [];
    let fJ: Tr | null = null;
    if (trs.length) {
      const t5 = b5.findIndex((b) => b.time === trs[0].time);
      if (t5 >= 0) {
        const endMin = b5[t5].etMin + 4;
        let i1 = raw.findIndex((b) => b.etMin >= endMin);
        if (i1 < 0) i1 = raw.length - 1;
        fJ = { i: i1, t: raw[i1].etMin, dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px };
      }
    }
    days.push({ date, raw, unit: unitArrL(raw, r10), regOpenI: Math.max(0, raw.findIndex((b) => b.etMin >= ET_OPEN)), close: reg[reg.length - 1].close, fJ, nextOpen: null });
  }
  // 다음날 시가 연결 (일봉 시가 사용 — 정규장 시가)
  const sxByDate = new Map(sx.map((b) => [b.date, b]));
  const sxDates = sx.map((b) => b.date);
  for (const d of days) {
    const next = sxDates.find((x) => x > d.date);
    d.nextOpen = next ? sxByDate.get(next)!.open : null;
  }

  const run = (mode: "close" | "commonOvn" | "allOvn"): { pnl: number; worst: number; wins: number; entries: number; ovnDays: number } => {
    let pnl = 0, worst = 0, wins = 0, entries = 0, ovnDays = 0;
    for (const d of days) {
      const cw = cumFirst(d.raw, d.unit);
      let day = 0;
      if (cw && !(d.fJ && d.fJ.t < cw.t)) {
        entries++;
        const fOpp = d.fJ && d.fJ.dir !== cw.dir ? d.fJ : null;
        const fSame = d.fJ && d.fJ.dir === cw.dir;
        const tranche = (j: Tr, holdOvn: boolean, forceI?: number, forcePx?: number): number => {
          let i0 = j.i, px = j.px;
          if (d.raw[j.i].etMin < ET_OPEN) { i0 = d.regOpenI; px = d.raw[d.regOpenI].open; }
          if (forceI !== undefined && forceI <= i0) return 0;
          const s = STOP / 100;
          const lim = forceI ?? d.raw.length;
          for (let k = i0 + 1; k < lim; k++) {
            if (d.raw[k].etMin < ET_OPEN) continue;
            if (j.dir === 1 ? d.raw[k].low <= px * (1 - s) : d.raw[k].high >= px * (1 + s)) return -STOP;
          }
          if (forceI !== undefined) return (((forcePx ?? d.close) - px) / px) * 100 * j.dir;
          const exitPx = holdOvn && d.nextOpen ? d.nextOpen : d.close;
          return ((exitPx - px) / px) * 100 * j.dir;
        };
        const holdMain = mode === "allOvn" || (mode === "commonOvn" && !!fSame);
        if (holdMain && d.nextOpen) ovnDays++;
        day += tranche(cw, holdMain, fOpp?.i, fOpp?.px);
        if (fOpp) {
          const holdRe = mode === "allOvn"; // 역진입 레그는 공통일 아님 — commonOvn에선 종가
          day += tranche(fOpp, holdRe);
          if (holdRe && d.nextOpen) ovnDays++;
        }
        if (day > 0) wins++;
      }
      pnl += day;
      worst = Math.min(worst, day);
    }
    return { pnl, worst, wins, entries, ovnDays };
  };

  console.log(`\n[② 청산 변형 — 6봉·${TAN}·스탑 -${STOP}% (${days.length}일)]`);
  for (const [label, mode] of [["A 당일 종가 청산 (기준)      ", "close"], ["B 공통일만 오버나이트 1박    ", "commonOvn"], ["C 전 포지션 오버나이트 1박   ", "allOvn"]] as const) {
    const r = run(mode);
    console.log(`${label}: ${s1(r.pnl)}%p · 승률 ${r.entries ? Math.round((100 * r.wins) / r.entries) : 0}%·최악일 ${r.worst.toFixed(2)}% · 오버나이트 ${r.ovnDays}회`);
  }
  console.log(`\n주: 오버나이트 구간은 스탑 불가(갭 리스크 내재 — 최악일로 측정). 다음날 시가 = 일봉 정규장 시가.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
