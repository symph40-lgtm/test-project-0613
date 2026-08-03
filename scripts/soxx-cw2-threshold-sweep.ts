// 창2(재점화) 도착 기준선 X 최적화 (사용자 지시 2026-08-04):
//   npx tsx scripts/soxx-cw2-threshold-sweep.ts
// 기준 사양(수정안): 창1 100% 진입(09:30 게이트) · 이견일(F 반대)=보유 유지·당일 종가 청산 ·
//   비이견일=1박(다음날 시가) · 스탑 -2%(장중). F 역진입 없음.
// A) 조기 경계: 재점화가 창1+X분까지 없으면 그 시점 청산·그날 종료(1박 취소) — X 스윕
// B) 1박 자격 강화: 비이견 AND 재점화 ≤X분만 1박(그 외 종가 청산) — X 스윕
// + 재점화 지연 분포(중앙·사분위) 동봉. 데이터 SOXXM 245일.

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const ET_OPEN = 570, ET_CLOSE = 960, ET_PRE = 420, STOP = 2.0;
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
type Dir = 1 | -1;
type Raw = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
type J = { i: number; t: number; dir: Dir; px: number };
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

type DayD = { raw: Raw[]; close: number; nextOpen: number | null; c1: J; refireT: number | null; fOpp: boolean };

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));

  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const days: DayD[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as Raw[];
    const raw = rawAll.filter((b) => b.etMin >= ET_PRE && b.etMin < ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const unit = unitArrL(raw, r10);
    const cond = (t: number, dir: Dir) => t >= 5 && (bmid(raw[t]) - bmid(raw[t - 5])) * dir >= unit[t - 5] * 5;
    let c1: J | null = null;
    for (let t = 5; t < raw.length && !c1; t++) {
      if (raw[t].etMin < ET_OPEN) continue;
      for (const dir of [1, -1] as const) if (cond(t, dir)) { c1 = { i: t, t: raw[t].etMin, dir, px: raw[t].close }; break; }
    }
    if (!c1) continue;
    let refireT: number | null = null, armed = false;
    for (let t = c1.i + 1; t < raw.length; t++) {
      if (!cond(t, c1.dir)) { armed = true; continue; }
      if (armed) { refireT = raw[t].etMin; break; }
    }
    const b5 = to5m(raw);
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
    const trs = fOut.transitions ?? [];
    let fJ: J | null = null;
    if (trs.length) {
      const k5 = b5.findIndex((b) => b.time === trs[0].time);
      if (k5 >= 0) {
        const endMin = b5[k5].etMin + 4;
        let i1 = raw.findIndex((b) => b.etMin >= endMin);
        if (i1 < 0) i1 = raw.length - 1;
        fJ = { i: i1, t: raw[i1].etMin, dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px };
      }
    }
    if (fJ && fJ.t < c1.t) continue; // F 선행 관망 (별도 규칙 영역)
    const next = dIdx.find((x) => x > date);
    days.push({ raw, close: reg[reg.length - 1].close, nextOpen: next ? dBy.get(next)!.open : null, c1, refireT, fOpp: !!(fJ && fJ.dir !== c1.dir) });
  }

  // 재점화 지연 분포
  const delays = days.filter((d) => d.refireT !== null).map((d) => d.refireT! - d.c1.t).sort((a, b) => a - b);
  const q = (p: number) => delays[Math.floor(p * (delays.length - 1))];
  console.log(`════ 창2 기준선 스윕 — ${days.length}일 (재점화 지연: 25% ${q(0.25)}분·중앙 ${q(0.5)}분·75% ${q(0.75)}분·90% ${q(0.9)}분) ════`);

  const run = (mode: "base" | "A" | "B", X: number): { pnl: number; worst: number; act: number } => {
    let pnl = 0, worst = 0, act = 0;
    for (const d of days) {
      const late = d.refireT === null || d.refireT - d.c1.t > X;
      let exitI: number | undefined, exitPx: number | undefined, ovn = !d.fOpp && d.nextOpen !== null;
      if (mode === "A" && late) {
        const cutMin = d.c1.t + X;
        let gI = d.raw.findIndex((b) => b.etMin >= cutMin);
        if (gI < 0) gI = d.raw.length - 1;
        exitI = gI; exitPx = d.raw[gI].close; ovn = false; act++;
      } else if (mode === "B" && late && ovn) { ovn = false; act++; }
      let day = 0;
      {
        const s = STOP / 100;
        let stopped = false;
        const lim = exitI ?? d.raw.length;
        for (let k = d.c1.i + 1; k < lim; k++) {
          if (d.raw[k].etMin < ET_OPEN) continue;
          if (d.c1.dir === 1 ? d.raw[k].low <= d.c1.px * (1 - s) : d.raw[k].high >= d.c1.px * (1 + s)) { day = -STOP; stopped = true; break; }
        }
        if (!stopped) {
          const e = exitPx ?? (ovn ? d.nextOpen! : d.close);
          day = ((e - d.c1.px) / d.c1.px) * 100 * d.c1.dir;
        }
      }
      pnl += day;
      worst = Math.min(worst, day);
    }
    return { pnl, worst, act };
  };

  const base = run("base", 0);
  console.log(`기준(수정안 — 경계 규칙 없음): ${s1(base.pnl)}%p · 최악 ${base.worst.toFixed(2)}%`);
  console.log(`\n[A 조기 경계 — X분 내 재점화 없으면 그 시점 청산·1박 취소]`);
  for (const X of [10, 15, 20, 30, 45, 60, 90]) {
    const r = run("A", X);
    console.log(`  X=${String(X).padStart(2)}분: ${s1(r.pnl)}%p (Δ ${s1(r.pnl - base.pnl)}) · 최악 ${r.worst.toFixed(2)}% · 발동 ${r.act}일`);
  }
  console.log(`\n[B 1박 자격 강화 — 비이견 AND 재점화 ≤X분만 1박]`);
  for (const X of [10, 15, 20, 30, 45, 60, 90]) {
    const r = run("B", X);
    console.log(`  X=${String(X).padStart(2)}분: ${s1(r.pnl)}%p (Δ ${s1(r.pnl - base.pnl)}) · 최악 ${r.worst.toFixed(2)}% · 1박 취소 ${r.act}일`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
