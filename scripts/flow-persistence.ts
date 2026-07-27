// 외인 수급의 며칠 묶음 추세(자기 지속성) 실측 (사용자 질문 2026-07-27 — "전날엔 익일 수급을
// 모르는데, 며칠 묶음의 추세가 있나?"): 수급→수급 지속성과, 묶음 상태→익일 수익 정보가치를 분리 측정.
//   npx tsx scripts/flow-persistence.ts   (.predict-cache/frgn-*.json·futflow.json — 무통신)
// ① 부호 지속: P(내일 순매수 | 오늘 순매수) 등 · 연속 묶음 길이 분포 vs 무작위 기대
// ② 자기상관: 순매매량 lag1~5 · 직전 3일 누적 → 익일 수급 상관
// ③ 묶음 상태 → 익일 종목 수익 (3일 연속 매수/매도 후 익일 — 6장 게이트 기각의 원천 재확인)

import { readFileSync } from "fs";
import { resolve } from "path";
import { fetchDailyPredict } from "../lib/predict/data";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
type Flow = { date: string; frgn?: number; frgnFut?: number };
const load = (f: string): Flow[] => JSON.parse(readFileSync(resolve(process.cwd(), ".predict-cache", f), "utf8"));
const pearson = (x: number[], y: number[]): number => {
  const n = Math.min(x.length, y.length);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return c / Math.sqrt(vx * vy);
};

function analyze(name: string, vals: { date: string; v: number }[]): void {
  const v = vals.map((x) => x.v);
  const n = v.length;
  // ① 부호 지속
  let bb = 0, bTot = 0, ss = 0, sTot = 0;
  for (let i = 0; i < n - 1; i++) {
    if (v[i] > 0) { bTot++; if (v[i + 1] > 0) bb++; }
    else if (v[i] < 0) { sTot++; if (v[i + 1] < 0) ss++; }
  }
  const buyRate = v.filter((x) => x > 0).length / n;
  // 연속 묶음 길이
  const runs: number[] = [];
  let cur = 1;
  for (let i = 1; i < n; i++) {
    if ((v[i] > 0) === (v[i - 1] > 0)) cur++;
    else { runs.push(cur); cur = 1; }
  }
  runs.push(cur);
  const meanRun = runs.reduce((a, b) => a + b, 0) / runs.length;
  const maxRun = Math.max(...runs);
  // ② 자기상관 · 3일 누적 → 익일
  const lags = [1, 2, 3, 5].map((L) => pearson(v.slice(0, n - L), v.slice(L)).toFixed(2));
  const cum3: number[] = [], next: number[] = [];
  for (let i = 3; i < n - 1; i++) { cum3.push(v[i - 2] + v[i - 1] + v[i]); next.push(v[i + 1]); }
  const rCum = pearson(cum3, next);
  // 3일 연속 후 익일 부호 유지 확률
  let b3 = 0, b3Tot = 0, s3 = 0, s3Tot = 0;
  for (let i = 2; i < n - 1; i++) {
    if (v[i] > 0 && v[i - 1] > 0 && v[i - 2] > 0) { b3Tot++; if (v[i + 1] > 0) b3++; }
    if (v[i] < 0 && v[i - 1] < 0 && v[i - 2] < 0) { s3Tot++; if (v[i + 1] < 0) s3++; }
  }
  console.log(`\n═ ${name} (${n}일, 매수일 비율 ${Math.round(buyRate * 100)}%)`);
  console.log(`  ① 지속: P(내일 매수|오늘 매수) ${Math.round((100 * bb) / bTot)}% (기저 ${Math.round(buyRate * 100)}%) · P(내일 매도|오늘 매도) ${Math.round((100 * ss) / sTot)}% (기저 ${Math.round((1 - buyRate) * 100)}%)`);
  console.log(`     3일 연속 매수(${b3Tot}회) 후 내일도 매수 ${Math.round((100 * b3) / b3Tot)}% · 3일 연속 매도(${s3Tot}회) 후 내일도 매도 ${Math.round((100 * s3) / s3Tot)}%`);
  console.log(`     묶음 평균 ${meanRun.toFixed(1)}일 (무작위 기대 ~2.0일) · 최장 ${maxRun}일`);
  console.log(`  ② 자기상관 lag1/2/3/5: ${lags.join("/")} · 직전 3일 누적→익일 수급 r=${rCum.toFixed(2)}`);
}

async function main() {
  for (const [code, name] of [["005930", "삼전"], ["000660", "하닉"]] as const) {
    const flow = load(`frgn-${code}.json`).map((x) => ({ date: x.date, v: x.frgn ?? 0 })).filter((x) => x.v !== 0);
    analyze(`${name} 현물 외인`, flow);
    // ③ 묶음 상태 → 익일 수익
    const bars = await fetchDailyPredict(code, 2600);
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    const fmap = new Map(flow.map((x) => [x.date, x.v]));
    const fdates = flow.map((x) => x.date);
    let stats: Record<string, { c: number; s: number; u: number }> = {};
    for (let k = 2; k < fdates.length; k++) {
      const d = fdates[k];
      const i = idx.get(d);
      if (i === undefined || i + 1 >= bars.length) continue;
      const [a, b, c] = [fmap.get(fdates[k - 2])!, fmap.get(fdates[k - 1])!, fmap.get(d)!];
      const key = a > 0 && b > 0 && c > 0 ? "3일연속 매수" : a < 0 && b < 0 && c < 0 ? "3일연속 매도" : c > 0 ? "당일 매수(비연속)" : "당일 매도(비연속)";
      const r = (bars[i + 1].close / bars[i].close - 1) * 100;
      stats[key] ??= { c: 0, s: 0, u: 0 };
      stats[key].c++; stats[key].s += r; if (r > 0) stats[key].u++;
    }
    console.log(`  ③ 묶음→익일 수익: ${Object.entries(stats).map(([k, x]) => `${k} ${x.c}일 ${(x.s / x.c >= 0 ? "+" : "") + (x.s / x.c).toFixed(2)}%·상승${Math.round((100 * x.u) / x.c)}%`).join(" | ")}`);
  }
  const fut = load("futflow.json").map((x) => ({ date: x.date, v: x.frgnFut ?? 0 })).filter((x) => x.v !== 0);
  analyze("K200 선물 외인", fut);
}

main().catch((e) => { console.error(e); process.exit(1); });
