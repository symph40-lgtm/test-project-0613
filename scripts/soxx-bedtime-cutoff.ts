// SOXX 창1 선행일 — 취침 시각 제약 하의 1박 규칙 실무 구현 실측 (사용자 질문 2026-08-04):
//   npx tsx scripts/soxx-bedtime-cutoff.ts
// 배경: 이견일 종가 청산(16:00 ET=한국 05:00)은 자는 시간 → 실무는 "자기 전 F 판정 상태로 결정".
// 실무 규칙: 취침 시각 C까지 F 동의 문자를 확인한 날만 MOC 예약 없이 1박, 그 외(이견·무판정·늦은 동의)는
//   자기 전 MOC(종가) 매도 예약 + 스탑 -2%. → 늦은 동의를 놓치는 비용이 얼마인지 스윕.
// C 스윕: 한국 23:00/23:30/24:00/01:00 = ET 10:00/10:30/11:00/12:00 + F 동의 확인 시각 분포.

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

type DayD = { raw: Raw[]; close: number; nextOpen: number | null; c1: J; fJ: J | null };

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
    if (fJ && fJ.t < c1.t) continue; // F 선행일 제외 (별도 규칙 영역)
    const next = dIdx.find((x) => x > date);
    days.push({ raw, close: reg[reg.length - 1].close, nextOpen: next ? dBy.get(next)!.open : null, c1, fJ });
  }

  const same = days.filter((d) => d.fJ && d.fJ.dir === d.c1.dir);
  const tsSame = same.map((d) => d.fJ!.t).sort((a, b) => a - b);
  const q = (p: number) => tsSame[Math.floor(p * (tsSame.length - 1))];
  console.log(`════ 취침 컷오프 스윕 — 창1 선행 ${days.length}일 · F 동의 ${same.length}일 ════`);
  console.log(`F 동의 확인 시각(ET): 중앙 ${fmtT(q(0.5))} · 75% ${fmtT(q(0.75))} · 90% ${fmtT(q(0.9))} · 최댓값 ${fmtT(tsSame[tsSame.length - 1] ?? 0)}`);

  const run = (cutoff: number | null): { pnl: number; ovnN: number; missed: number } => {
    let pnl = 0, ovnN = 0, missed = 0;
    for (const d of days) {
      const agreed = !!(d.fJ && d.fJ.dir === d.c1.dir && d.fJ.t >= d.c1.t);
      const inTime = cutoff === null || (d.fJ !== null && d.fJ.t <= cutoff);
      const ovn = agreed && inTime && d.nextOpen !== null;
      if (agreed && !inTime) missed++;
      if (ovn) ovnN++;
      let day = 0;
      const s = STOP / 100;
      let stopped = false;
      for (let k = d.c1.i + 1; k < d.raw.length; k++) {
        if (d.raw[k].etMin < ET_OPEN) continue;
        if (d.c1.dir === 1 ? d.raw[k].low <= d.c1.px * (1 - s) : d.raw[k].high >= d.c1.px * (1 + s)) { day = -STOP; stopped = true; break; }
      }
      if (!stopped) {
        const e = ovn ? d.nextOpen! : d.close;
        day = ((e - d.c1.px) / d.c1.px) * 100 * d.c1.dir;
      }
      pnl += day;
    }
    return { pnl, ovnN, missed };
  };

  const base = run(null);
  console.log(`기준(컷오프 없음 — 동의면 무조건 1박): ${s1(base.pnl)}%p · 1박 ${base.ovnN}일`);
  for (const [label, cut] of [["한국 23:00 (ET 10:00)", 600], ["한국 23:30 (ET 10:30)", 630], ["한국 24:00 (ET 11:00)", 660], ["한국 01:00 (ET 12:00)", 720]] as const) {
    const r = run(cut);
    console.log(`  ${label}: ${s1(r.pnl)}%p (Δ ${s1(r.pnl - base.pnl)}) · 1박 ${r.ovnN}일 · 늦은 동의 놓침 ${r.missed}일`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
