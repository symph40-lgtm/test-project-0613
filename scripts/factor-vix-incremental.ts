// VIX 게이트의 '증분 가치' 검정 (Phase 1 최종 관문 — 사용자 지시 2026-08-08):
//   npx tsx scripts/factor-vix-incremental.ts
// VIX 5일 변화가 T0(갭)에 리프트 +3~+21로 2종목×3구간을 통과했다. 그러나 VIX와 미장은 강한 음의
// 상관이라, 이 신호가 '이미 쓰고 있는 간밤 미장(SOX)'의 재포장일 수 있다.
//   → SOX를 통제한 뒤에도 VIX가 갭을 추가로 나누는가? 나누지 못하면 새 팩터가 아니다.
// 방법: SOX 5일 변화를 3분위로 나누고 각 분위 '안에서' VIX 급등/급락별 갭 평균을 비교한다.
//   같은 SOX 상황인데 VIX에 따라 갭이 갈리면 증분 가치가 있는 것.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const FRED = process.env.FRED_API_KEY;

async function fred(id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED}&file_type=json&observation_start=2014-01-01`);
  if (!r.ok) return out;
  const j = await r.json() as { observations?: { date: string; value: string }[] };
  for (const o of j.observations ?? []) { const v = parseFloat(o.value); if (isFinite(v)) out.set(o.date, v); }
  return out;
}
function asOf(m: Map<string, number>, date: string, sorted: string[]): number | null {
  let lo = 0, hi = sorted.length - 1, best: string | null = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= date) { best = sorted[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best ? m.get(best)! : null;
}
const corr = (xs: number[], ys: number[]) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
  return sx > 0 && sy > 0 ? sxy / Math.sqrt(sx * sy) : 0;
};

type R = { date: string; t0: number; vixCh: number; soxCh: number };

async function run(sym: string, name: string, vix: Map<string, number>, vk: string[], sox: Map<string, number>, sk: string[]) {
  const bars = await fetchDailyPredict(sym, 2600);
  const rows: R[] = [];
  for (let i = 5; i < bars.length - 1; i++) {
    const c = bars[i], n = bars[i + 1];
    const v = asOf(vix, c.date, vk), v5 = asOf(vix, bars[i - 5].date, vk);
    const s = asOf(sox, c.date, sk), s5 = asOf(sox, bars[i - 5].date, sk);
    if (v == null || v5 == null || s == null || s5 == null || v5 === 0 || s5 === 0) continue;
    rows.push({
      date: c.date,
      t0: ((n.open - c.close) / c.close) * 100,
      vixCh: ((v - v5) / v5) * 100,
      soxCh: ((s - s5) / s5) * 100,
    });
  }
  console.log(`\n════ ${name} — ${rows.length}일 ════`);
  console.log(`  VIX 5일변화 vs SOX 5일변화 상관 ${corr(rows.map(r => r.vixCh), rows.map(r => r.soxCh)).toFixed(3)} ← 강한 음수면 같은 정보`);
  console.log(`  단변량 갭 상관: VIX ${corr(rows.map(r => r.vixCh), rows.map(r => r.t0)).toFixed(3)} · SOX ${corr(rows.map(r => r.soxCh), rows.map(r => r.t0)).toFixed(3)}`);

  // SOX 3분위 안에서 VIX가 추가로 나누는가
  const srt = rows.slice().sort((a, b) => a.soxCh - b.soxCh);
  const q = Math.floor(srt.length / 3);
  const buckets: [string, R[]][] = [
    ["SOX 하위⅓(미장 약세)", srt.slice(0, q)],
    ["SOX 중위⅓", srt.slice(q, 2 * q)],
    ["SOX 상위⅓(미장 강세)", srt.slice(2 * q)],
  ];
  console.log(`  ── SOX 통제 후 VIX의 증분 (같은 SOX 구간 안에서 VIX 상·하위 절반 갭 평균) ──`);
  let flips = 0;
  for (const [lb, g] of buckets) {
    const s2v = g.slice().sort((a, b) => a.vixCh - b.vixCh);
    const half = Math.floor(s2v.length / 2);
    const lowV = s2v.slice(0, half), highV = s2v.slice(half);
    const mLow = lowV.reduce((a, r) => a + r.t0, 0) / lowV.length;
    const mHigh = highV.reduce((a, r) => a + r.t0, 0) / highV.length;
    const diff = mLow - mHigh; // VIX 낮은 쪽이 갭이 높아야 신호가 살아 있음
    if (diff > 0) flips++;
    console.log(`     ${lb.padEnd(20)} n=${g.length} · VIX 하위½ 갭 ${s2(mLow)}% · VIX 상위½ 갭 ${s2(mHigh)}% · 차이 ${s2(diff)}%p ${diff > 0 ? "(신호 유지)" : "(신호 소멸/역전)"}`);
  }
  console.log(`     → 3개 구간 중 ${flips}개에서 신호 유지`);
}

async function main() {
  if (!FRED) { console.error("FRED_API_KEY 없음"); return; }
  const vix = await fred("VIXCLS");
  const vk = [...vix.keys()].sort();
  const r = await yf.chart("^SOX", { period1: new Date("2015-06-01"), interval: "1d" });
  const sox = new Map<string, number>();
  for (const q of r.quotes ?? []) {
    if (q.close == null) continue;
    sox.set((q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), q.close);
  }
  const sk = [...sox.keys()].sort();
  console.log(`VIX ${vix.size}일 · SOX ${sox.size}일`);
  await run("000660", "SK하이닉스", vix, vk, sox, sk);
  await run("005930", "삼성전자", vix, vk, sox, sk);
  console.log(`\n  ※ SOX를 통제한 뒤에도 VIX가 갭을 나누면 새 팩터, 못 나누면 SOX의 재포장이다.`);
}
main();
