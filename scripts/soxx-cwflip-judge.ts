// SOXX 창1 선행일 — 창의 반대 전환(반대 방향 점화)을 청산 신호로 쓸 수 있나 (사용자 지시 2026-08-04):
//   npx tsx scripts/soxx-cwflip-judge.ts
// 삼전 전례: 창 전환은 노이즈(전환청산 -3.5)로 기각. SOXX 창은 고품질(컷 6%)이라 재검증.
// 기준(수정안): 창1 100%·이견(F 반대) 보유·F 동의 시 1박·스탑 -2% = +78.2/186일
// C1 창 반대 점화 시 그 자리 청산·그날 종료(1박 취소) / C2 = C1 + 반대 100% 역진입(당일 종가)
// C3 장중 무시·그날 1박만 취소 / 참고: 반대 점화 발생률·시각 분포

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
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
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

type DayD = { raw: Raw[]; close: number; nextOpen: number | null; c1: J; flip: J | null; fSame: boolean; fOpp: boolean };

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
    let flip: J | null = null;
    for (let t = c1.i + 1; t < raw.length && !flip; t++) {
      if (cond(t, (c1.dir * -1) as Dir)) flip = { i: t, t: raw[t].etMin, dir: (c1.dir * -1) as Dir, px: raw[t].close };
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
    if (fJ && fJ.t < c1.t) continue; // F 선행 제외
    const next = dIdx.find((x) => x > date);
    days.push({
      raw, close: reg[reg.length - 1].close, nextOpen: next ? dBy.get(next)!.open : null, c1, flip,
      fSame: !!(fJ && fJ.dir === c1.dir && fJ.t > c1.t), fOpp: !!(fJ && fJ.dir !== c1.dir),
    });
  }

  const flipDays = days.filter((d) => d.flip).length;
  const lags = days.filter((d) => d.flip).map((d) => d.flip!.t - d.c1.t);
  console.log(`════ 창 반대 점화 — ${days.length}일 중 발생 ${flipDays}일(${Math.round((100 * flipDays) / days.length)}%) · 창1 후 중앙 ${med(lags)}분 ════`);

  const run = (mode: "base" | "C1" | "C2" | "C3"): { pnl: number; worst: number } => {
    let pnl = 0, worst = 0;
    for (const d of days) {
      const useFlip = mode !== "base" && d.flip;
      let ovn = d.fSame && d.nextOpen !== null; // 긍정형: F 동의일만 1박
      if (useFlip) ovn = false;
      let exitI: number | undefined, exitPx: number | undefined;
      if ((mode === "C1" || mode === "C2") && d.flip) { exitI = d.flip.i; exitPx = d.flip.px; }
      let day = 0;
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
      if (mode === "C2" && d.flip) {
        let st2 = false;
        for (let k = d.flip.i + 1; k < d.raw.length; k++) {
          if (d.raw[k].etMin < ET_OPEN) continue;
          if (d.flip.dir === 1 ? d.raw[k].low <= d.flip.px * (1 - s) : d.raw[k].high >= d.flip.px * (1 + s)) { day += -STOP; st2 = true; break; }
        }
        if (!st2) day += ((d.close - d.flip.px) / d.flip.px) * 100 * d.flip.dir;
      }
      pnl += day;
      worst = Math.min(worst, day);
    }
    return { pnl, worst };
  };

  const base = run("base");
  console.log(`기준(수정안·F동의 1박):        ${s1(base.pnl)}%p · 최악 ${base.worst.toFixed(2)}%`);
  for (const [label, mode] of [["C1 반대 점화 시 청산·1박 취소 ", "C1"], ["C2 청산+반대 100% 역진입     ", "C2"], ["C3 장중 무시·1박만 취소       ", "C3"]] as const) {
    const r = run(mode);
    console.log(`${label}: ${s1(r.pnl)}%p (Δ ${s1(r.pnl - base.pnl)}) · 최악 ${r.worst.toFixed(2)}%`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
