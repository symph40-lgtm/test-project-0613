// SOXX F 선행일(관망 59일) 전용 — F 진입 × 창 심판 조합 실측 (사용자 지시 2026-08-04, v2 사양 완결편):
//   npx tsx scripts/soxx-flead-sweep.ts
// 대상: F 첫확인이 창1보다 빠른 날만 (현행 규칙은 관망 0%). 구조상 삼전 v2의 거울상 검증:
//   E0 F 진입 100%·심판 없음 (대조) / E1 F 진입 100% → 창1 반대 시 청산+창 방향 100% 역진입 (거울 v2)
//   E2 F 진입 100% → 창1 반대 시 청산만 / E3 F 50% → 창1 동의 시 100% / E4 창1이 F와 동의할 때만 창1에서 100%
// 공통: 스탑 -2%·당일 종가 청산. 우승안에는 1박(반대 판정 없는 날) 추가 실측. 데이터 SOXXM.

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

type DayD = { date: string; raw: Raw[]; regOpen: number; close: number; nextOpen: number | null; fJ: J; c1: J };

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
    const b5 = to5m(raw);
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
    const trs = fOut.transitions ?? [];
    if (!trs.length) continue;
    const k5 = b5.findIndex((b) => b.time === trs[0].time);
    if (k5 < 0) continue;
    const endMin = b5[k5].etMin + 4;
    let i1 = raw.findIndex((b) => b.etMin >= endMin);
    if (i1 < 0) i1 = raw.length - 1;
    const fJ: J = { i: i1, t: raw[i1].etMin, dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px };
    if (fJ.t >= c1.t) continue; // F 선행일만
    const next = dIdx.find((x) => x > date);
    days.push({ date, raw, regOpen: reg[0].open, close: reg[reg.length - 1].close, nextOpen: next ? dBy.get(next)!.open : null, fJ, c1 });
  }

  const agree = days.filter((d) => d.c1.dir === d.fJ.dir).length;
  console.log(`════ F 선행일 ${days.length}일 (창1 동의 ${agree}·반대 ${days.length - agree}) · F 확인 중앙 ${fmtT(med(days.map((d) => d.fJ.t)))} ET·창1 중앙 ${fmtT(med(days.map((d) => d.c1.t)))} ════`);

  const run = (mode: "E0" | "E1" | "E2" | "E3" | "E4", ovn: boolean): { pnl: number; wins: number; n: number; cut: number; worst: number } => {
    let pnl = 0, wins = 0, n = 0, cutN = 0, worst = 0;
    for (const d of days) {
      let cut = false;
      const oppC = d.c1.dir !== d.fJ.dir ? d.c1 : null;
      const holdOvn = ovn && !oppC && d.nextOpen !== null;
      const tranche = (j: J, size: number, forceI?: number, forcePx?: number): number => {
        let i0 = j.i, px = j.px;
        if (d.raw[j.i].etMin < ET_OPEN) { i0 = d.raw.findIndex((b) => b.etMin >= ET_OPEN); px = d.regOpen; }
        if (size <= 0 || (forceI !== undefined && forceI <= i0)) return 0;
        const s = STOP / 100;
        const lim = forceI ?? d.raw.length;
        for (let k = i0 + 1; k < lim; k++) {
          if (d.raw[k].etMin < ET_OPEN) continue;
          if (j.dir === 1 ? d.raw[k].low <= px * (1 - s) : d.raw[k].high >= px * (1 + s)) { cut = true; return -STOP * size; }
        }
        if (forceI !== undefined) return (((forcePx ?? d.close) - px) / px) * 100 * j.dir * size;
        return (((holdOvn ? d.nextOpen! : d.close) - px) / px) * 100 * j.dir * size;
      };
      let day = 0, traded = false;
      if (mode === "E0") { day += tranche(d.fJ, 1); traded = true; }
      else if (mode === "E1") {
        day += tranche(d.fJ, 1, oppC?.i, oppC?.px);
        if (oppC) day += tranche(oppC, 1);
        traded = true;
      } else if (mode === "E2") {
        day += tranche(d.fJ, 1, oppC?.i, oppC?.px);
        traded = true;
      } else if (mode === "E3") {
        day += tranche(d.fJ, 0.5, oppC?.i, oppC?.px);
        if (!oppC) day += tranche(d.c1, 0.5);
        else day += tranche(oppC, 1);
        traded = true;
      } else if (mode === "E4") {
        if (!oppC) { day += tranche(d.c1, 1); traded = true; }
      }
      if (traded) {
        n++;
        if (day > 0) wins++;
        if (cut) cutN++;
      }
      pnl += day;
      worst = Math.min(worst, day);
    }
    return { pnl, wins, n, cut: cutN, worst };
  };

  console.log(`\n[당일청산]`);
  for (const [label, mode] of [["E0 F 100%·심판 없음(대조)      ", "E0"], ["E1 F 100%→창1 반대 역진입     ", "E1"], ["E2 F 100%→창1 반대 청산만    ", "E2"], ["E3 F 50%→창1 동의 100%       ", "E3"], ["E4 창1·F 동의 시만 창1 진입   ", "E4"]] as const) {
    const r = run(mode, false);
    console.log(`${label}: ${s1(r.pnl)}%p · 거래 ${r.n}일·승률 ${r.n ? Math.round((100 * r.wins) / r.n) : 0}%·컷 ${r.cut}·최악 ${r.worst.toFixed(2)}%`);
  }
  console.log(`\n[+ 1박 (창1 반대 없는 날 — 다음날 시가 청산)]`);
  for (const [label, mode] of [["E1 + 1박", "E1"], ["E2 + 1박", "E2"], ["E4 + 1박", "E4"]] as const) {
    const r = run(mode, true);
    console.log(`${label}: ${s1(r.pnl)}%p · 최악 ${r.worst.toFixed(2)}%`);
  }
  console.log(`\n참고: 현행 규칙은 이 59일 전부 관망(0%p). 전체 모델 합산 = v2(비이견 1박) +73.1 + 채택안.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
