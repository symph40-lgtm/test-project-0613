// SOXX 창판정 재확인(창2) × 피셔F 조합 최적화 (사용자 설계 2026-08-04 새벽):
//   npx tsx scripts/soxx-cw2-combo-sweep.ts
// 아이디어: 봉이 깨끗한 SOXX에서 "첫 창판정(창1) 후 같은 방향 재점화(창2)"를 추가 검증으로 활용.
// 창2 정의: 창1 이후 원조건(6봉 누적 순전진)이 일단 꺼졌다가 같은 방향으로 다시 충족되는 첫 봉(재점화).
// 변형 (전부 F 심판 공통 — F 반대 첫확인 시 전량 청산+반대 100% 역진입·스탑 -2%·09:30 게이트):
//   V0 기준: 창1 100% (현행 v2)
//   A 분할: 창1 50% → 창2 +50%
//   B 재확인 진입: 창1은 대기 신호 — 창2에서만 100% (진입 전 F 반대 확인 시 그날 관망)
//   D 3단: 창1 30% → F 동의 +40% → 창2 +30%
// 2부: 당일청산 우승안에 오버나이트 1박 자격 {F동의(기준)·창2·F동의AND창2·F동의OR창2} 조합.
// 문턱 1.0/1.2 병행. 데이터 = SOXXM 병합 1분봉 245일.

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

type DayD = { date: string; raw: Raw[]; unit: number[]; regOpenI: number; close: number; nextOpen: number | null; fJ: J | null; cw1: Record<string, J | null>; cw2: Record<string, J | null> };

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
    // 창1·창2 (문턱별) — 재점화 = 조건이 꺼졌다 다시 켜지는 첫 봉
    const cw1: Record<string, J | null> = {}, cw2: Record<string, J | null> = {};
    for (const tan of [1.0, 1.2]) {
      const cond = (t: number, dir: Dir) => t >= 5 && (bmid(raw[t]) - bmid(raw[t - 5])) * dir >= tan * unit[t - 5] * 5;
      let c1: J | null = null, c2: J | null = null;
      for (let t = 5; t < raw.length && !c1; t++) {
        if (raw[t].etMin < ET_OPEN) continue;
        for (const dir of [1, -1] as const) {
          if (cond(t, dir)) { c1 = { i: t, t: raw[t].etMin, dir, px: raw[t].close }; break; }
        }
      }
      if (c1) {
        let armed = false;
        for (let t = c1.i + 1; t < raw.length; t++) {
          if (!cond(t, c1.dir)) { armed = true; continue; }
          if (armed) { c2 = { i: t, t: raw[t].etMin, dir: c1.dir, px: raw[t].close }; break; }
        }
      }
      cw1[tan.toFixed(1)] = c1;
      cw2[tan.toFixed(1)] = c2;
    }
    // F (현행 — 07:00 창·5분 집계)
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
    const next = dIdx.find((x) => x > date);
    days.push({ date, raw, unit, regOpenI: Math.max(0, raw.findIndex((b) => b.etMin >= ET_OPEN)), close: reg[reg.length - 1].close, nextOpen: next ? dBy.get(next)!.open : null, fJ, cw1, cw2 });
  }

  type Res = { pnl: number; entries: number; wins: number; cutDays: number; worst: number };
  const runVariant = (tan: string, mode: "V0" | "A" | "B" | "D", ovn: "none" | "fSame" | "cw2" | "and" | "or"): Res & { ovnN: number } => {
    let pnl = 0, entries = 0, wins = 0, cutDays = 0, worst = 0, ovnN = 0;
    for (const d of days) {
      const c1 = d.cw1[tan], c2 = d.cw2[tan], fJ = d.fJ;
      let day = 0, cut = false;
      const fOpp = fJ && c1 && fJ.dir !== c1.dir ? fJ : null;
      const fSame = fJ && c1 && fJ.dir === c1.dir && fJ.t > c1.t;
      const holdOvn = (() => {
        if (ovn === "none") return false;
        const a = !!fSame, b = !!(c2 && (!fOpp || c2.t < fOpp.t));
        return ovn === "fSame" ? a : ovn === "cw2" ? b : ovn === "and" ? a && b : a || b;
      })();
      const tranche = (j: J, size: number, forceI?: number, forcePx?: number): number => {
        let i0 = j.i, px = j.px;
        if (d.raw[j.i].etMin < ET_OPEN) { i0 = d.regOpenI; px = d.raw[d.regOpenI].open; }
        if (size <= 0 || (forceI !== undefined && forceI <= i0)) return 0;
        const s = STOP / 100;
        const lim = forceI ?? d.raw.length;
        for (let k = i0 + 1; k < lim; k++) {
          if (d.raw[k].etMin < ET_OPEN) continue;
          if (j.dir === 1 ? d.raw[k].low <= px * (1 - s) : d.raw[k].high >= px * (1 + s)) { cut = true; return -STOP * size; }
        }
        if (forceI !== undefined) return (((forcePx ?? d.close) - px) / px) * 100 * j.dir * size;
        const exitPx = holdOvn && d.nextOpen ? d.nextOpen : d.close;
        return ((exitPx - px) / px) * 100 * j.dir * size;
      };
      if (c1 && !(fJ && fJ.t < c1.t)) {
        let held = false;
        if (mode === "V0") { day += tranche(c1, 1, fOpp?.i, fOpp?.px); held = true; }
        else if (mode === "A") {
          day += tranche(c1, 0.5, fOpp?.i, fOpp?.px);
          if (c2 && (!fOpp || c2.t < fOpp.t)) day += tranche(c2, 0.5, fOpp?.i, fOpp?.px);
          held = true;
        } else if (mode === "B") {
          if (c2 && (!fOpp || c2.t < fOpp.t)) { day += tranche(c2, 1, fOpp?.i, fOpp?.px); held = true; }
        } else if (mode === "D") {
          day += tranche(c1, 0.3, fOpp?.i, fOpp?.px);
          if (fSame && fJ) day += tranche(fJ, 0.4, fOpp?.i, fOpp?.px);
          if (c2 && (!fOpp || c2.t < fOpp.t)) day += tranche(c2, 0.3, fOpp?.i, fOpp?.px);
          held = true;
        }
        if (fOpp) day += tranche(fOpp, 1); // 역진입 (당일 종가 청산 — 1박 자격 없음)
        if (held || day !== 0) {
          entries++;
          if (day > 0) wins++;
          if (cut) cutDays++;
          if (holdOvn && d.nextOpen) ovnN++;
        }
      }
      pnl += day;
      worst = Math.min(worst, day);
    }
    return { pnl, entries, wins, cutDays, worst, ovnN };
  };

  // 창2 통계
  for (const tan of ["1.0", "1.2"]) {
    const has1 = days.filter((d) => d.cw1[tan]).length;
    const has2 = days.filter((d) => d.cw2[tan]).length;
    const lag = days.filter((d) => d.cw1[tan] && d.cw2[tan]).map((d) => d.cw2[tan]!.t - d.cw1[tan]!.t);
    console.log(`문턱 ${tan}: 창1 ${has1}일 · 창2(재점화) ${has2}일(${Math.round((100 * has2) / has1)}%) · 창1→창2 지연 중앙 ${med(lag)}분`);
  }

  console.log(`\n[1부 — 당일청산 · F 심판 공통 (${days.length}일)]`);
  for (const tan of ["1.0", "1.2"]) {
    for (const [label, mode] of [["V0 창1 100% (기준)     ", "V0"], ["A  창1 50%→창2 100%   ", "A"], ["B  창2에서만 100% 진입 ", "B"], ["D  30→F동의70→창2 100 ", "D"]] as const) {
      const r = runVariant(tan, mode, "none");
      console.log(`${tan} ${label}: ${s1(r.pnl)}%p · 진입 ${r.entries}·승률 ${r.entries ? Math.round((100 * r.wins) / r.entries) : 0}%·컷일 ${r.cutDays}·최악 ${r.worst.toFixed(2)}%`);
    }
  }

  console.log(`\n[2부 — 오버나이트 1박 자격 조합 (V0·창1 100% 기준)]`);
  for (const tan of ["1.0", "1.2"]) {
    for (const [label, ovn] of [["F동의 (기존 채택안)   ", "fSame"], ["창2 재점화            ", "cw2"], ["F동의 AND 창2         ", "and"], ["F동의 OR 창2          ", "or"]] as const) {
      const r = runVariant(tan, "V0", ovn);
      console.log(`${tan} ${label}: ${s1(r.pnl)}%p · 최악 ${r.worst.toFixed(2)}% · 1박 ${r.ovnN}회`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
