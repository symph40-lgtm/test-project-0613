// SOXX 이견일 — 전량청산·역진입 각각의 가치 분해 (사용자 질문 2026-08-04):
//   npx tsx scripts/soxx-flip-value.ts
// 대상: 창1 선행 진입 후 F가 반대를 확인한 날(이견일). 세 단계 비교로 부품별 기여 산출:
//   A0 심판 없음(창1 종가까지 보유) → A1 F 확인 시 청산만 → A2 청산+반대 100% 역진입(현행)
//   Δ(A0→A1) = 청산의 가치 · Δ(A1→A2) = 역진입의 가치. 역진입 레그 단독 승률·컷·분포 병기.
// 스탑 -2%·당일 종가·SOXXM 병합 1분봉.

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
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
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

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));

  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  let n = 0;
  let a0 = 0, a1 = 0, a2 = 0;
  let a0Cut = 0, reWins = 0, reCuts = 0, reSum = 0;
  const rePnls: number[] = [];
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
    if (fJ.t <= c1.t || fJ.dir === c1.dir) continue; // 이견일(창1 선행 + F 반대)만
    n++;
    const close = reg[reg.length - 1].close;
    const tranche = (j: J, forceI?: number, forcePx?: number): { pnl: number; cut: boolean } => {
      const s = STOP / 100;
      const lim = forceI ?? raw.length;
      for (let k = j.i + 1; k < lim; k++) {
        if (raw[k].etMin < ET_OPEN) continue;
        if (j.dir === 1 ? raw[k].low <= j.px * (1 - s) : raw[k].high >= j.px * (1 + s)) return { pnl: -STOP, cut: true };
      }
      const e = forceI !== undefined ? (forcePx ?? close) : close;
      return { pnl: ((e - j.px) / j.px) * 100 * j.dir, cut: false };
    };
    const hold = tranche(c1); // A0: 종가까지
    const cutEarly = tranche(c1, fJ.i, fJ.px); // A1: F 시점 청산
    const re = tranche(fJ); // 역진입 레그
    a0 += hold.pnl; if (hold.cut) a0Cut++;
    a1 += cutEarly.pnl;
    a2 += cutEarly.pnl + re.pnl;
    reSum += re.pnl;
    rePnls.push(re.pnl);
    if (re.pnl > 0) reWins++;
    if (re.cut) reCuts++;
  }
  console.log(`════ SOXX 이견일 ${n}일 — 청산·역진입 부품별 가치 (스탑 -${STOP}%·당일 종가) ════`);
  console.log(`A0 심판 없음(종가까지 보유):  ${s1(a0)}%p (컷 ${a0Cut})`);
  console.log(`A1 F 확인 시 청산만:          ${s1(a1)}%p   → 청산의 가치 Δ ${s1(a1 - a0)}`);
  console.log(`A2 청산+반대 100% 역진입(현행): ${s1(a2)}%p   → 역진입의 가치 Δ ${s1(a2 - a1)}`);
  console.log(`\n[역진입 레그 단독] ${n}회 · 승률 ${Math.round((100 * reWins) / n)}% · 컷 ${reCuts}회 · 합 ${s1(reSum)}%p · 회당 중앙 ${s2(med(rePnls))}%·평균 ${s2(reSum / n)}%`);
}
main().catch((e) => { console.error(e); process.exit(1); });
