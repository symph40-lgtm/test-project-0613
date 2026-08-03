// SOXX v2 정교화 스윕 (사용자 지시 2026-08-03 — 직이식 +54.8을 SOXX 고유 튜닝으로):
//   npx tsx scripts/soxx-v2-refine-sweep.ts
// 축 (삼전에서 유효성 검증된 것만): ①창 크기 4/5/6/8봉 × 문턱 0.84/1.0/1.2/1.5 (16셀)
//   ②최적 셀에서 스탑 1.5/2.0/2.5 ③최적 셀에서 심판 F 변형 — 현행(07:00 프리장창) vs 정규장창(09:30~,
//   국장 rebox 원리의 미장판). 창판정 09:30 게이트 고정·당일(16:00) 청산.
// 평가: 합계·승률·컷일·최악일 + 평원 여부. 계좌 환산(SOXL 3x) 비교도 출력.

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
function cumFirst(bars: Raw[], unit: number[], tanA: number, win: number): Tr | null {
  const w = win - 1;
  for (let t = w; t < bars.length; t++) {
    if (bars[t].etMin < ET_OPEN) continue;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - w])) * dir >= tanA * unit[t - w] * w) return { i: t, t: bars[t].etMin, dir, px: bars[t].close };
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

type DayD = { raw: Raw[]; unit: number[]; regOpenI: number; close: number; fJ: Tr | null; fJreg: Tr | null };

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));

  const files = readdirSync(resolve(process.cwd(), ".predict-cache")).filter((f) => /^SOXXA-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const days: DayD[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(process.cwd(), `.predict-cache/${f}`), "utf8")) as Raw[];
    const raw = rawAll.filter((b) => b.etMin >= ET_PRE && b.etMin < ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const mkF = (bars5: Raw[]): Tr | null => {
      const morning: MinuteBar[] = bars5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      if (morning.length < 5) return null;
      const out = runFisher({ date, dailyHistory: hist, openPx: bars5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
      const trs = out.transitions ?? [];
      if (!trs.length) return null;
      const t5 = bars5.findIndex((b) => b.time === trs[0].time);
      if (t5 < 0) return null;
      const endMin = bars5[t5].etMin + 4;
      let i1 = raw.findIndex((b) => b.etMin >= endMin);
      if (i1 < 0) i1 = raw.length - 1;
      return { i: i1, t: raw[i1].etMin, dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px };
    };
    const b5 = to5m(raw);
    days.push({
      raw, unit: unitArrL(raw, r10), regOpenI: Math.max(0, raw.findIndex((b) => b.etMin >= ET_OPEN)), close: reg[reg.length - 1].close,
      fJ: mkF(b5),
      fJreg: mkF(b5.filter((b) => b.etMin >= ET_OPEN)), // 정규장창 F (09:30~45 OR — 국장 rebox 원리)
    });
  }

  const cell = (win: number, tan: number, stop: number, judge: "pre" | "reg"): { pnl: number; entries: number; wins: number; cutDays: number; worst: number } => {
    let pnl = 0, entries = 0, wins = 0, cutDays = 0, worst = 0;
    for (const d of days) {
      const fJ = judge === "pre" ? d.fJ : d.fJreg;
      const cw = cumFirst(d.raw, d.unit, tan, win);
      let day = 0;
      if (cw && !(fJ && fJ.t < cw.t)) {
        entries++;
        const tranche = (j: Tr, forceI?: number, forcePx?: number): number => {
          let i0 = j.i, px = j.px;
          if (d.raw[j.i].etMin < ET_OPEN) { i0 = d.regOpenI; px = d.raw[d.regOpenI].open; }
          if (forceI !== undefined && forceI <= i0) return 0;
          const s = stop / 100;
          const lim = forceI ?? d.raw.length;
          for (let k = i0 + 1; k < lim; k++) {
            if (d.raw[k].etMin < ET_OPEN) continue;
            if (j.dir === 1 ? d.raw[k].low <= px * (1 - s) : d.raw[k].high >= px * (1 + s)) return -stop;
          }
          const px2 = forceI !== undefined ? (forcePx ?? d.close) : d.close;
          return ((px2 - px) / px) * 100 * j.dir;
        };
        const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
        const t1 = tranche(cw, fOpp?.i, fOpp?.px);
        let t2 = 0;
        if (fOpp) t2 = tranche(fOpp);
        day = t1 + t2;
        if (t1 === -stop || t2 === -stop) cutDays++;
        if (day > 0) wins++;
      }
      pnl += day;
      worst = Math.min(worst, day);
    }
    return { pnl, entries, wins, cutDays, worst };
  };

  console.log(`════ SOXX v2 정교화 — ${days.length}일 · 창 09:30 게이트·당일청산 (기준: 직이식 6봉·1.0·스탑2.0 = +54.8) ════`);
  console.log(`\n[① 창 크기 × 문턱 (스탑 2.0·F 현행)]`);
  let best = { win: 6, tan: 1.0, pnl: -Infinity };
  for (const win of [4, 5, 6, 8]) {
    const row: string[] = [];
    for (const tan of [0.84, 1.0, 1.2, 1.5]) {
      const r = cell(win, tan, 2.0, "pre");
      row.push(`${tan.toFixed(2)}: ${s1(r.pnl)}`);
      if (r.pnl > best.pnl) best = { win, tan, pnl: r.pnl };
    }
    console.log(`  ${win}봉 │ ${row.join("  ")}`);
  }
  console.log(`  최고: ${best.win}봉·${best.tan} = ${s1(best.pnl)}%p`);

  console.log(`\n[② 최고 셀의 스탑 스윕]`);
  for (const stop of [1.5, 2.0, 2.5]) {
    const r = cell(best.win, best.tan, stop, "pre");
    console.log(`  스탑 -${stop.toFixed(1)}%: ${s1(r.pnl)}%p · 승률 ${r.entries ? Math.round((100 * r.wins) / r.entries) : 0}%·컷일 ${r.cutDays}·최악 ${r.worst.toFixed(2)}%`);
  }

  console.log(`\n[③ 최고 셀의 심판 F 변형]`);
  for (const [label, j] of [["현행 F (07:00 프리장창)", "pre"], ["정규장창 F (09:30 OR — rebox 원리)", "reg"]] as const) {
    const r = cell(best.win, best.tan, 2.0, j);
    console.log(`  ${label}: ${s1(r.pnl)}%p · 승률 ${r.entries ? Math.round((100 * r.wins) / r.entries) : 0}%·컷일 ${r.cutDays}·최악 ${r.worst.toFixed(2)}%`);
  }
  console.log(`\n참고 계좌 환산: SOXX ×3(SOXL) vs 삼전 ×2(ETF) — 삼전 +112.8×2=+226% 상당, SOXX +54.8×3=+164% 상당(기준셀).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
