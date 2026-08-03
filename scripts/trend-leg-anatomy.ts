// 추세 레그 해부 — 하닉·삼전·SOXX 미시구조 비교 (사용자 가설 2026-08-03 밤:
// "SOXX는 노이즈 적어 컷도 적지만, 전진은 완만하고 지속성이 길 것"):
//   npx tsx scripts/trend-leg-anatomy.ts
// 레그 정의: 정규장(국장 09:00~15:30·미장 09:30~16:00) 내 지배 스윙(최대 저점→고점 or 고점→저점),
//   크기 ≥ 0.8×r10%인 날만 (추세일 필터·스케일 프리). 레그 구간 내 측정:
//   ①지속시간(분) ②순전진 크기(%·r10 배수) ③효율 = 순전진/경로합(노이즈 비) ④분당 전진 속도(%/분·눈금 대비 각도)
//   ⑤색 순도 = 레그 방향 봉 비율 ⑥최장 연속 동색봉 ⑦최대 되돌림(레그 크기 대비 %) ⑧역색 2연속 run 수
// 주 비교 = 5분봉 집계(세 종목 동일 잣대 — SOXX IEX 1분 결측 왜곡 제거). 1분 지표는 참고(국장 2종 + SOXX 유의).

import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE = resolve(process.cwd(), ".predict-cache");
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
type Bar = { t: number; open: number; high: number; low: number; close: number };

function aggregate(bars: Bar[], step: number): Bar[] {
  const map = new Map<number, Bar>();
  for (const b of bars) {
    const k = Math.floor(b.t / step) * step;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, t: k });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

type LegStats = {
  durMin: number; sizePct: number; sizeR10: number; eff: number; speedPctMin: number; angleDeg: number;
  purity: number; maxRun: number; maxRetracePct: number; counterRuns: number;
};
function anatomize(bars: Bar[], r10Pct: number, barMin: number): LegStats | null {
  if (bars.length < 30) return null;
  // 지배 레그: 러닝 극값으로 최대 상승/하락 스윙
  let minI = 0, maxI = 0, upBest = 0, upS = 0, upE = 0, dnBest = 0, dnS = 0, dnE = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].low < bars[minI].low) minI = i;
    if (bars[i].high > bars[maxI].high) maxI = i;
    const up = (bars[i].high - bars[minI].low) / bars[minI].low;
    if (up > upBest) { upBest = up; upS = minI; upE = i; }
    const dn = (bars[maxI].high - bars[i].low) / bars[maxI].high;
    if (dn > dnBest) { dnBest = dn; dnS = maxI; dnE = i; }
  }
  const dir: 1 | -1 = upBest >= dnBest ? 1 : -1;
  const [s, e, size] = dir === 1 ? [upS, upE, upBest * 100] : [dnS, dnE, dnBest * 100];
  if (e - s < 5 || size < 0.8 * r10Pct) return null;
  const leg = bars.slice(s, e + 1);
  // 효율·되돌림
  let path = 0;
  for (let k = 1; k < leg.length; k++) path += Math.abs(leg[k].close - leg[k - 1].close);
  const net = Math.abs(leg[leg.length - 1].close - leg[0].close);
  let ext = leg[0].close, maxRetrace = 0;
  for (const b of leg) {
    ext = dir === 1 ? Math.max(ext, b.close) : Math.min(ext, b.close);
    const re = dir === 1 ? ext - b.close : b.close - ext;
    maxRetrace = Math.max(maxRetrace, re);
  }
  // 색 순도·연속봉·역색 run
  let same = 0, colored = 0, run = 0, maxRun = 0, counterRun = 0, counterRuns = 0;
  for (const b of leg) {
    const c = Math.sign(b.close - b.open);
    if (c === 0) { run = 0; counterRun = 0; continue; }
    colored++;
    if (c === dir) { same++; run++; maxRun = Math.max(maxRun, run); if (counterRun >= 2) counterRuns++; counterRun = 0; }
    else { counterRun++; run = 0; }
  }
  if (counterRun >= 2) counterRuns++;
  // 눈금(30봉 평균폭×0.5) 대비 분당 전진 각도
  const rng = leg.map((b) => b.high - b.low);
  const unit = Math.max(rng.reduce((a, b) => a + b, 0) / rng.length * 0.5, 1e-9);
  const perBarAdv = net / Math.max(1, leg.length - 1);
  const durMin = (e - s) * barMin;
  return {
    durMin, sizePct: size, sizeR10: size / r10Pct, eff: path > 0 ? net / path : 0,
    speedPctMin: size / durMin, angleDeg: Math.atan(perBarAdv / unit) * 180 / Math.PI,
    purity: colored ? same / colored : 0, maxRun, maxRetracePct: net > 0 ? (maxRetrace / net) * 100 : 0, counterRuns,
  };
}

async function loadKr(code: string): Promise<{ bars: Bar[]; r10Pct: number }[]> {
  const daily = await fetchDailyPredict(code, 400);
  const out: { bars: Bar[]; r10Pct: number }[] = [];
  for (let i = 130; i < daily.length; i++) {
    const f = resolve(CACHE, `${code}-${daily[i].date}.json`);
    if (!existsSync(f)) continue;
    const raw = JSON.parse(readFileSync(f, "utf8")) as { time: string; open: number; high: number; low: number; close: number }[];
    const hist = daily.slice(Math.max(0, i - 60), i);
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const prev = hist[hist.length - 1]?.close;
    if (!prev || raw.length < 240) continue;
    const bars = raw
      .map((b) => ({ t: parseInt(b.time.slice(0, 2), 10) * 60 + parseInt(b.time.slice(3, 5), 10), open: b.open, high: b.high, low: b.low, close: b.close }))
      .filter((b) => b.t >= 540 && b.t <= 930);
    out.push({ bars, r10Pct: (r10 / prev) * 100 });
  }
  return out;
}
async function loadSoxx(): Promise<{ bars: Bar[]; r10Pct: number }[]> {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (r.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  // 병합본(SOXXM — Alpaca+야후 결측 보강, 사용자 지시 8/3 밤) 우선
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out: { bars: Bar[]; r10Pct: number; date?: string }[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const prev = hist[hist.length - 1].close;
    const raw = (JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as { etMin: number; open: number; high: number; low: number; close: number }[])
      .filter((b) => b.etMin >= 570 && b.etMin < 960)
      .map((b) => ({ t: b.etMin, open: b.open, high: b.high, low: b.low, close: b.close }));
    if (raw.length < 250) continue;
    out.push({ bars: raw, r10Pct: (r10 / prev) * 100, date });
  }
  return out;
}

function report(name: string, days: { bars: Bar[]; r10Pct: number }[], step: number): void {
  const st: LegStats[] = [];
  for (const d of days) {
    const bars = step > 1 ? aggregate(d.bars, step) : d.bars;
    const a = anatomize(bars, d.r10Pct, step);
    if (a) st.push(a);
  }
  const m = (f: (x: LegStats) => number, digits = 2) => med(st.map(f)).toFixed(digits);
  console.log(`${name} (레그일 ${st.length}): 지속 ${m((x) => x.durMin, 0)}분 · 크기 ${m((x) => x.sizePct)}%(r10의 ${m((x) => x.sizeR10)}배) · 효율 ${m((x) => x.eff)} · 속도 ${m((x) => x.speedPctMin, 3)}%/분·각도 ${m((x) => x.angleDeg, 0)}° · 색순도 ${m((x) => x.purity)} · 최장연속 ${m((x) => x.maxRun, 0)}봉 · 최대되돌림 ${m((x) => x.maxRetracePct, 0)}%(레그 대비) · 역색2련 ${m((x) => x.counterRuns, 0)}회`);
}

async function main() {
  const hx = await loadKr("000660");
  const ss = await loadKr("005930");
  const sx = await loadSoxx();
  console.log(`════ 추세 레그 해부 — 정규장·지배 스윙 ≥0.8×r10% (하닉 ${hx.length}·삼전 ${ss.length}·SOXX ${sx.length}일 로드) ════`);
  console.log(`\n[주 비교 — 1분봉 (사용자 지시: SOXX는 병합본 SOXXM — 최근 20일 완전·과거 정규장 97%)]`);
  report("하닉", hx, 1);
  report("삼전", ss, 1);
  report("SOXX", sx, 1);
  report("SOXX(완전 병합 최근 20일)", sx.filter((d) => (d as { date?: string }).date !== undefined && (d as { date?: string }).date! >= "2026-07-06"), 1);
  console.log(`\n[참고 — 5분봉 집계]`);
  report("하닉", hx, 5);
  report("삼전", ss, 5);
  report("SOXX", sx, 5);
  console.log(`\n용어: 효율 = 순전진/경로합(1=일직선·낮을수록 노이즈) · 각도 = 봉당 전진을 자기 눈금으로 잰 기울기 ·`);
  console.log(`      색순도 = 레그 방향 봉 비율 · 최대되돌림 = 레그 진행 중 역행 최대폭(레그 크기 %) · 역색2련 = 반대색 2연속 이상 구간 수`);
}
main().catch((e) => { console.error(e); process.exit(1); });
