// SOXX 창1 진입 후 케이스 매트릭스 — F(동의/부동의/부재) × 창2(재점화 속도) (사용자 지시 2026-08-04):
//   npx tsx scripts/soxx-case-matrix.ts
// 각 칸: 일수 · 당일청산 손익 · 1박(다음날 시가) 손익 · Δ오버나이트(1박-당일) · 컷일 —
// "어떤 날을 재워야 하는가"를 칸 단위로 판정. 창2 축: 빠름(창1 후 ≤30분)/늦음(>30분)/없음.
// 기준: 창1(6봉·1.0·09:30 게이트) 100%·F 심판(반대 시 역진입 — 역진입 레그는 항상 당일 종가)·스탑 -2%.
// 데이터 SOXXM 병합 1분봉.

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

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));

  type Cell = { n: number; close: number; ovn: number; cut: number };
  const mk = (): Cell => ({ n: 0, close: 0, ovn: 0, cut: 0 });
  const fCats = ["F동의", "F부동의(이견)", "F부재"] as const;
  const cCats = ["창2 빠름(≤30분)", "창2 늦음(>30분)", "창2 없음"] as const;
  const matrix = new Map<string, Cell>();
  for (const fc of fCats) for (const cc of cCats) matrix.set(`${fc}|${cc}`, mk());
  let fFirstDays = 0, noC1 = 0;

  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
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
    if (!c1) { noC1++; continue; }
    let c2: J | null = null, armed = false;
    for (let t = c1.i + 1; t < raw.length; t++) {
      if (!cond(t, c1.dir)) { armed = true; continue; }
      if (armed) { c2 = { i: t, t: raw[t].etMin, dir: c1.dir, px: raw[t].close }; break; }
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
    if (fJ && fJ.t < c1.t) { fFirstDays++; continue; } // 관망일
    const close = reg[reg.length - 1].close;
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const fOpp = fJ && fJ.dir !== c1.dir ? fJ : null;
    const fc = fOpp ? "F부동의(이견)" : fJ ? "F동의" : "F부재";
    const cc = !c2 ? "창2 없음" : c2.t - c1.t <= 30 ? "창2 빠름(≤30분)" : "창2 늦음(>30분)";
    let cut = false;
    const tranche = (j: J, exitPx: number | null, forceI?: number, forcePx?: number): number => {
      let i0 = j.i, px = j.px;
      if (raw[j.i].etMin < ET_OPEN) { i0 = 0; px = reg[0].open; }
      if (forceI !== undefined && forceI <= i0) return 0;
      const s = STOP / 100;
      const lim = forceI ?? raw.length;
      for (let k = i0 + 1; k < lim; k++) {
        if (raw[k].etMin < ET_OPEN) continue;
        if (j.dir === 1 ? raw[k].low <= px * (1 - s) : raw[k].high >= px * (1 + s)) { cut = true; return -STOP; }
      }
      const e = forceI !== undefined ? (forcePx ?? close) : (exitPx ?? close);
      return ((e - px) / px) * 100 * j.dir;
    };
    const re = fOpp ? tranche(fOpp, close) : 0;
    const pClose = tranche(c1, close, fOpp?.i, fOpp?.px) + re;
    cut = false;
    const reB = fOpp ? tranche(fOpp, close) : 0;
    const pOvn = tranche(c1, nextOpen, fOpp?.i, fOpp?.px) + reB;
    const cell = matrix.get(`${fc}|${cc}`)!;
    cell.n++;
    cell.close += pClose;
    cell.ovn += pOvn;
    if (cut) cell.cut++;
  }

  console.log(`════ SOXX 창1 진입 후 케이스 매트릭스 (SOXXM·창1 6봉·1.0·F 심판·스탑 -2%) ════`);
  console.log(`관망(F 선행) ${fFirstDays}일 · 창1 없음 ${noC1}일 제외\n`);
  console.log(`칸: 일수 · 당일청산 합 · 1박 합 · Δ오버나이트 · 컷일`);
  for (const fc of fCats) {
    console.log(`\n■ ${fc}`);
    for (const cc of cCats) {
      const c = matrix.get(`${fc}|${cc}`)!;
      if (!c.n) { console.log(`  ${cc}: 0일`); continue; }
      console.log(`  ${cc}: ${c.n}일 · 당일 ${s1(c.close)}%p · 1박 ${s1(c.ovn)}%p · Δ ${s1(c.ovn - c.close)} · 컷 ${c.cut}`);
    }
    const tot = cCats.map((cc) => matrix.get(`${fc}|${cc}`)!).reduce((a, c) => ({ n: a.n + c.n, close: a.close + c.close, ovn: a.ovn + c.ovn, cut: a.cut + c.cut }), mk());
    console.log(`  ── 소계: ${tot.n}일 · 당일 ${s1(tot.close)}%p · 1박 ${s1(tot.ovn)}%p · Δ ${s1(tot.ovn - tot.close)}`);
  }
  console.log(`\n주: 이견일의 '1박'은 창1 레그가 F 시점에 이미 청산되므로 Δ가 작음(역진입 레그는 두 경우 모두 당일 종가).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
