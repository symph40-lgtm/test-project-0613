// SOXX 조기 프리장(04:30~07:00 ET) 판정 최적화 (사용자 지시 2026-08-05 "이 시간에도 판정·진입 —
// F(OR)·창 규칙을 신모델 참고로 최적화"):
//   npx tsx scripts/soxx-early-pre-sweep.ts
// ⚠데이터 제약: 04:30~07:00 분봉은 최근 ~20일(야후 병합분)뿐 — 격자 최소화·구조 파라미터만,
//   채택은 저신뢰 페이퍼/소액 라벨로 (60일 축적 후 승격 판단이 관례).
// ①진폭 구조: 04:30~07 vs 07~09:30 vs 정규장 ②조기 F(5분봉·OR 04:30~45·오프셋 축소 격자) ·
//   조기 창(1분 6봉·tan1.0·눈금 자동적응, 게이트 04:30) ③방향 품질: 현행 F(07창)와 일치율·
//   조기 확인가→현행 진입가 드리프트(조기 진입이 추가로 먹는 몫)·일중 방향 적중.

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import { judgeSoxxDay, soxxUnitArr, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar, type SoxxJ } from "../lib/signal/us/soxxV2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE = resolve(process.cwd(), ".predict-cache");
const EARLY0 = 270; // 04:30
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const bmid = (b: SoxxBar) => (b.open + b.close) / 2;

function to5m(bars: SoxxBar[]): SoxxBar[] {
  const map = new Map<number, SoxxBar>();
  for (const b of bars) {
    const k = Math.floor(b.etMin / 5) * 5;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...map.values()].sort((a, b) => a.etMin - b.etMin);
}

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 200 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  type D = { date: string; all: SoxxBar[]; early: SoxxBar[]; raw: SoxxBar[]; reg: SoxxBar[]; hist: PredictDailyBar[]; r10: number; fJ: SoxxJ | null; c1: SoxxJ | null };
  const days: D[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const allB = (JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[]).filter((b) => b.etMin >= EARLY0 && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const early = allB.filter((b) => b.etMin < SOXX_ET_PRE);
    if (early.length < 100) continue; // 04:30~07:00 조밀일만 (150분 중 100+)
    const raw = allB.filter((b) => b.etMin >= SOXX_ET_PRE);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 });
    days.push({ date, all: allB, early, raw, reg, hist, r10, fJ, c1 });
  }
  console.log(`대상 ${days.length}일 (04:30~07:00 조밀 분봉 보유일)`);

  // ① 진폭 구조
  const amp = (bars: SoxxBar[]) => bars.length ? (Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low))) / bars[0].open * 100 : NaN;
  const aE = days.map((d) => amp(d.early)), aP = days.map((d) => amp(d.raw.filter((b) => b.etMin < SOXX_ET_OPEN))), aR = days.map((d) => amp(d.reg));
  console.log(`고저폭 중앙: 04:30~07시 ${med(aE).toFixed(2)}% · 07~09:30 ${med(aP).toFixed(2)}% · 정규장 ${med(aR).toFixed(2)}% — 축소비 ${(med(aE) / med(aR)).toFixed(2)}x`);

  // ② 변형들 — 조기 F(오프셋 축소 격자) + 조기 창(적응 눈금)
  type EJ = { t: number; dir: 1 | -1; px: number };
  const earlyF = (d: D, offR: number): EJ | null => {
    const b5 = to5m(d.all.filter((b) => b.etMin < SOXX_ET_PRE));
    if (b5.length < 5) return null;
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const out = runFisher({ date: d.date, dailyHistory: d.hist, openPx: b5[0].open, morning, prevDayMinutes: null },
      { orMinutes: 3, offsetRangeRatio: offR, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
    const trs = out.transitions ?? [];
    if (!trs.length) return null;
    const k5 = b5.findIndex((b) => b.time === trs[0].time);
    if (k5 < 0) return null;
    return { t: b5[k5].etMin + 4, dir: trs[0].to === "up" ? 1 : -1, px: trs[0].px };
  };
  const earlyCw = (d: D): EJ | null => {
    const bars = d.all.filter((b) => b.etMin < SOXX_ET_PRE);
    const unit = soxxUnitArr(bars, d.r10);
    for (let t = 5; t < bars.length; t++) {
      for (const dir of [1, -1] as const) {
        if ((bmid(bars[t]) - bmid(bars[t - 5])) * dir >= unit[t - 5] * 5) return { t: bars[t].etMin, dir, px: bars[t].close };
      }
    }
    return null;
  };

  const evalV = (label: string, get: (d: D) => EJ | null) => {
    let n = 0, agree = 0, drift = 0, dayHit = 0, worstDr = 0;
    const ts: number[] = [];
    for (const d of days) {
      const e = get(d);
      if (!e) continue;
      n++; ts.push(e.t);
      // 현행 진입가: F선행이면 F확인가(프리장 직접 진입 사양), 아니면 창1가
      const fFirst = d.fJ && (!d.c1 || d.fJ.t < d.c1.t);
      const cur = fFirst ? d.fJ : d.c1;
      if (cur && e.dir === cur.dir) agree++;
      if (cur) {
        const dd = ((cur.px - e.px) / e.px) * 100 * e.dir; // 조기 진입이 추가로 먹는 드리프트 (방향 맞을 때 +)
        drift += dd; worstDr = Math.min(worstDr, dd);
      }
      const closeD = d.reg[d.reg.length - 1].close;
      if (((closeD - e.px) / e.px) * e.dir > 0) dayHit++;
    }
    console.log(`${label}: 판정 ${n}/${days.length}일 · 확인 중앙 ${fmtT(med(ts) || 0)} · 현행 신호와 방향 일치 ${n ? Math.round((100 * agree) / n) : 0}% · 조기 드리프트 합 ${s1(drift)}%p(최악 ${s2(worstDr)}) · 종가 방향 적중 ${n ? Math.round((100 * dayHit) / n) : 0}%`);
  };

  for (const offR of [0.05, 0.0375, 0.025, 0.0125]) evalV(`조기 F 오프셋 ${offR}`, (d) => earlyF(d, offR));
  evalV("조기 창(6봉·tan1.0·적응 눈금)", earlyCw);
}
main().catch((e) => { console.error(e); process.exit(1); });
