// 갭 과대·과소반응 판별 검증 (사용자 반문 2026-08-08: "밤 정보가 다음날 국장에 반영될 텐데
// 방향 예측이 안 된다면 뭐하러 하나"):
//   npx tsx scripts/kr-gap-residual.ts
// 지금까지 잰 것은 '밤 정보 → 당일 방향'이었고 전부 음수였다. 그런데 진짜 물어야 할 것은 다르다:
//   밤 정보는 갭에 '반영'된다(갭 방향이 SOX와 71~73% 일치). 문제는 그게 이미 시가에 들어 있다는 것.
//   → 그렇다면 '얼마나' 반영됐는지, 즉 밤 정보 대비 갭이 과한지 부족한지가 남은 정보 아닌가?
// 방법: 갭을 밤 정보(SOX)로 회귀 → 잔차(실제갭 − 예상갭)를 과대/과소반응 지표로 삼아 r_oc 예측력 검정.
//   잔차 > 0 = 밤 정보가 설명하는 것보다 갭이 과했다(과대반응) → 장중 되돌림 가설
//   잔차 < 0 = 갭이 덜 반응했다(과소반응) → 장중 마저 간다 가설
// 회귀계수는 워크포워드(직전 120일 롤링)로 추정해 미래 정보 누출을 막는다.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;

type Row = { date: string; gap: number; rOC: number; sox: number };

function collect(code: string, soxBy: Map<string, number>): Row[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const days: PredictDailyBar[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    days.push({ date, open: reg[0].open, close: reg[reg.length - 1].close, high: 0, low: 0, volume: 0 });
  }
  const out: Row[] = [];
  for (let i = 1; i < days.length; i++) {
    // 한국 t일 갭 = 전날(t-1) 종가 → t일 시가. 그 사이 밤 = 미국 t-1일 세션.
    const sox = soxBy.get(days[i - 1].date);
    if (sox === undefined) continue;
    out.push({
      date: days[i].date,
      gap: ((days[i].open - days[i - 1].close) / days[i - 1].close) * 100,
      rOC: ((days[i].close - days[i].open) / days[i].open) * 100,
      sox,
    });
  }
  return out;
}

// 직전 W일로 gap = a + b·sox 회귀 (워크포워드)
function fit(rows: Row[], upto: number, W = 120): { a: number; b: number } | null {
  const w = rows.slice(Math.max(0, upto - W), upto);
  if (w.length < 40) return null;
  const mx = w.reduce((s, r) => s + r.sox, 0) / w.length;
  const my = w.reduce((s, r) => s + r.gap, 0) / w.length;
  let sxy = 0, sxx = 0;
  for (const r of w) { sxy += (r.sox - mx) * (r.gap - my); sxx += (r.sox - mx) ** 2; }
  if (sxx <= 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

function report(name: string, rows: Row[]) {
  const up = rows.filter(r => r.rOC > 0).length;
  console.log(`\n════ ${name} — ${rows.length}일 ════`);
  console.log(`  r_oc 무조건부 상승 ${pctOf(up, rows.length)}% · 평균 ${s2(rows.reduce((a, r) => a + r.rOC, 0) / rows.length)}%`);

  // 전체 기간 회귀계수 (참고 표기용)
  const all = fit(rows, rows.length, rows.length);
  console.log(`  갭 ≈ ${all ? `${all.a.toFixed(2)} + ${all.b.toFixed(2)}×SOX` : "—"}  ← 밤 정보가 갭에 반영되는 정도(b가 클수록 강하게 반영)`);

  // 워크포워드 잔차
  type E = Row & { resid: number };
  const ev: E[] = [];
  for (let i = 0; i < rows.length; i++) {
    const m = fit(rows, i);
    if (!m) continue;
    ev.push({ ...rows[i], resid: rows[i].gap - (m.a + m.b * rows[i].sox) });
  }
  if (ev.length < 60) { console.log(`  워크포워드 표본 ${ev.length}일 — 부족`); return; }
  const sd = Math.sqrt(ev.reduce((a, r) => a + r.resid ** 2, 0) / ev.length);
  console.log(`  워크포워드 채점 ${ev.length}일 · 잔차 표준편차 ${sd.toFixed(2)}%p`);

  const test = (label: string, sig: (r: E) => number) => {
    const g = ev.filter(r => sig(r) !== 0);
    if (g.length < 20) { console.log(`     ${label.padEnd(34)} 표본 ${g.length}일 — 부족`); return; }
    const hit = g.filter(r => r.rOC * sig(r) > 0).length;
    const longs = g.filter(r => sig(r) === 1).length;
    const base = (longs * up + (g.length - longs) * (ev.length - up)) / ev.length;
    const avg = g.reduce((a, r) => a + r.rOC * sig(r), 0) / g.length;
    console.log(`     ${label.padEnd(34)} ${String(g.length).padStart(3)}일 · 적중 ${String(pctOf(hit, g.length)).padStart(3)}% · 평균 ${s2(avg).padStart(6)}% · 리프트 ${String(Math.round(((hit - base) / g.length) * 100)).padStart(3)}%p`);
  };
  console.log(`  ── 잔차(밤 정보 대비 갭의 과대·과소) 기반 r_oc 방향 ──`);
  test("① 과대반응이면 반대(전체)", r => (r.resid > 0 ? -1 : 1));
  for (const k of [0.5, 1.0, 1.5]) {
    test(`② |잔차| ≥ ${k}σ 일 때 반대`, r => (Math.abs(r.resid) < k * sd ? 0 : r.resid > 0 ? -1 : 1));
  }
  test("③ 과대반응이면 추종(반대 가설)", r => (r.resid > 0 ? 1 : -1));
  console.log(`  ── 비교: 잔차 대신 원값을 쓰면 ──`);
  test("④ 갭 그대로 반대(잔차 미사용)", r => (Math.abs(r.gap) < 0.3 ? 0 : r.gap > 0 ? -1 : 1));
  test("⑤ SOX 방향 추종(잔차 미사용)", r => (r.sox > 0 ? 1 : -1));
  // 잔차 분위별 평균 r_oc
  console.log(`  ── 잔차 5분위별 평균 r_oc (단조성 확인) ──`);
  const srt = ev.slice().sort((a, b) => a.resid - b.resid);
  const q = Math.floor(srt.length / 5);
  for (let i = 0; i < 5; i++) {
    const g = srt.slice(i * q, i === 4 ? srt.length : (i + 1) * q);
    console.log(`     Q${i + 1} (잔차 ${g[0].resid.toFixed(1)}~${g[g.length - 1].resid.toFixed(1)}) ${String(g.length).padStart(3)}일 · 평균 r_oc ${s2(g.reduce((a, r) => a + r.rOC, 0) / g.length)}% · 상승 ${pctOf(g.filter(r => r.rOC > 0).length, g.length)}%`);
  }
}

async function main() {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 2 * 365 * 86400e3), interval: "1d" });
  const q = (r.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
  const soxBy = new Map<string, number>();
  for (let i = 1; i < q.length; i++) {
    const d = (q[i].date instanceof Date ? q[i].date : new Date(q[i].date)).toISOString().slice(0, 10);
    soxBy.set(d, ((q[i].close - q[i - 1].close) / q[i - 1].close) * 100);
  }
  report("하이닉스", collect("000660", soxBy));
  report("삼성전자", collect("005930", soxBy));
  console.log(`\n  ※ 잔차 = 실제 갭 − (밤 정보로 예상되는 갭). 회귀계수는 직전 120일 롤링(워크포워드)이라 미래 정보 없음.`);
}
main();
