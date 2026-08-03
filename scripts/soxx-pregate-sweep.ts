// SOXX 프리장(07:00~09:30 ET) 시간대 성능 비교 (사용자 지시 2026-08-03):
//   npx tsx scripts/soxx-pregate-sweep.ts
// 질문: 창판정을 프리장부터 허용하면 득인가 실인가 — 판정 허용 시각 격자 {07:00, 08:00, 09:00, 09:30}.
// 모델: B 삼전식 v2 (1분 6봉 누적 순전진 100% → F(5분·라이브 cfg) 반대 첫확인 역진입·스탑 -2%·16:00 청산).
// 소스: ①야후 1분봉 최근 ~4주 (프리장 조밀 — 주 판정 근거) ②Alpaca 245일 (프리장 희소 — 참고 대조).
// + 게이트 없음일 때 프리장 판정일의 손익 분해 (프리장 판정이 돈이 되는 유형인가).

import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOP = 2.0;
const ET_OPEN = 570, ET_CLOSE = 960, ET_PRE = 420;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
type Dir = 1 | -1;
type Raw = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
type Tr = { i: number; t: number; dir: Dir; px: number };
const bmid = (b: Raw) => (b.open + b.close) / 2;

function unitArrL(bars: Raw[], fallback: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : fallback;
    return Math.max(u * 0.5, 1e-9);
  });
}
function cumFirst(bars: Raw[], unit: number[], fromMin: number): Tr | null {
  for (let t = 5; t < bars.length; t++) {
    if (bars[t].etMin < fromMin) continue;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - 5])) * dir >= unit[t - 5] * 5) return { i: t, t: bars[t].etMin, dir, px: bars[t].close };
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

type DayD = { date: string; raw: Raw[]; regOpenI: number; close: number; fJ: Tr | null; unit: number[] };
function prepDay(date: string, rawAll: Raw[], hist: PredictDailyBar[]): DayD | null {
  const raw = rawAll.filter((b) => b.etMin >= ET_PRE && b.etMin < ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
  const reg = raw.filter((b) => b.etMin >= ET_OPEN);
  if (reg.length < 250 || hist.length < 11) return null;
  const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
  const b5 = to5m(raw);
  const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
  const t5 = new Map<string, number>();
  b5.forEach((b, k) => t5.set(b.time, k));
  const fTrs: Tr[] = (fOut.transitions ?? []).flatMap((t) => {
    const k5 = t5.get(t.time);
    if (k5 === undefined) return [];
    const endMin = b5[k5].etMin + 4;
    let i1 = raw.findIndex((b) => b.etMin >= endMin);
    if (i1 < 0) i1 = raw.length - 1;
    return [{ i: i1, t: raw[i1].etMin, dir: (t.to === "up" ? 1 : -1) as Dir, px: t.px }];
  });
  return { date, raw, regOpenI: Math.max(0, raw.findIndex((b) => b.etMin >= ET_OPEN)), close: reg[reg.length - 1].close, fJ: fTrs.length ? fTrs[0] : null, unit: unitArrL(raw, r10) };
}

function v2Day(d: DayD, fromMin: number): { pnl: number; cwT: number | null } {
  const cw = cumFirst(d.raw, d.unit, fromMin);
  if (!cw || (d.fJ && d.fJ.t < cw.t)) return { pnl: 0, cwT: cw?.t ?? null };
  const tranche = (j: Tr, forceI?: number, forcePx?: number): number => {
    let i0 = j.i, px = j.px;
    if (d.raw[j.i].etMin < ET_OPEN) { i0 = d.regOpenI; px = d.raw[d.regOpenI].open; }
    if (forceI !== undefined && forceI <= i0) return 0;
    const s = STOP / 100;
    const lim = forceI ?? d.raw.length;
    for (let k = i0 + 1; k < lim; k++) {
      if (d.raw[k].etMin < ET_OPEN) continue;
      if (j.dir === 1 ? d.raw[k].low <= px * (1 - s) : d.raw[k].high >= px * (1 + s)) return -STOP;
    }
    const px2 = forceI !== undefined ? (forcePx ?? d.close) : d.close;
    return ((px2 - px) / px) * 100 * j.dir;
  };
  const fOpp = d.fJ && d.fJ.dir !== cw.dir ? d.fJ : null;
  let p = tranche(cw, fOpp?.i, fOpp?.px);
  if (fOpp) p += tranche(fOpp);
  return { pnl: p, cwT: cw.t };
}

function report(label: string, days: DayD[]): void {
  console.log(`\n════ ${label} — ${days.length}일 ════`);
  for (const g of [ET_PRE, 480, 540, ET_OPEN]) {
    let sum = 0, entry = 0, preJ = 0, preSum = 0, regSum = 0;
    for (const d of days) {
      const r = v2Day(d, g);
      sum += r.pnl;
      if (r.cwT !== null) {
        entry++;
        if (r.cwT < ET_OPEN) { preJ++; preSum += r.pnl; } else regSum += r.pnl;
      }
    }
    console.log(`판정 허용 ${fmtT(g)}~: 합 ${s1(sum)}%p (판정 ${entry}일 — 프리장 판정 ${preJ}일 ${s1(preSum)}%p · 정규장 판정 ${s1(regSum)}%p)`);
  }
}

async function main() {
  // ① 야후 1분봉 최근 4주 (프리장 조밀)
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const yByDay = new Map<string, Raw[]>();
  for (let c = 0; c < 4; c++) {
    const p2 = new Date(Date.now() - c * 7 * 86400e3);
    const p1 = new Date(p2.getTime() - 7 * 86400e3);
    try {
      const r = await yf.chart("SOXX", { period1: p1, period2: p2, interval: "1m", includePrePost: true });
      for (const q of r.quotes ?? []) {
        if (q.close == null || q.open == null || q.high == null || q.low == null) continue;
        const dd = q.date instanceof Date ? q.date : new Date(q.date);
        const p = Object.fromEntries(etFmt.formatToParts(dd).map((x) => [x.type, x.value]));
        const day = `${p.year}-${p.month}-${p.day}`;
        const etMin = parseInt(p.hour === "24" ? "0" : p.hour, 10) * 60 + parseInt(p.minute, 10);
        const arr = yByDay.get(day) ?? [];
        arr.push({ etMin, time: fmtT(etMin), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 });
        yByDay.set(day, arr);
      }
    } catch { /* 청크 실패 무시 */ }
    await sleep(400);
  }
  const yDays: DayD[] = [];
  for (const [date, bars] of [...yByDay.entries()].sort()) {
    const d = prepDay(date, bars, daily.filter((x) => x.date < date).slice(-60));
    if (d) yDays.push(d);
  }
  report("야후 1분봉 (프리장 조밀 — 주 판정 근거)", yDays);

  // ② Alpaca 245일 (프리장 희소 — 참고)
  const files = readdirSync(resolve(process.cwd(), ".predict-cache")).filter((f) => /^SOXXA-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const aDays: DayD[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const bars = JSON.parse(readFileSync(resolve(process.cwd(), `.predict-cache/${f}`), "utf8")) as Raw[];
    const d = prepDay(date, bars, daily.filter((x) => x.date < date).slice(-60));
    if (d) aDays.push(d);
  }
  report("Alpaca 245일 (프리장 희소 — 참고 대조)", aDays);
  console.log(`\n주: 프리장 판정 진입은 정규장 시가 체결·프리장 스탑 미적용(얇은 체결 보호). F는 두 소스 모두 07:00 창 그대로.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
