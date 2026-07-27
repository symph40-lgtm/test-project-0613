// 코스피 시장 전체 외인 '현물' 수급의 묶음 추세 실측 (사용자 요청 2026-07-27 — "종목 말고
// 코스피 현물로"): flow-persistence.ts와 동일 잣대 — 수급→수급 지속성 + 묶음 상태→익일
// 삼전·하닉 수익. 소스: 네이버 sise/investorDealTrendDay sosok=01 (억원, 2015~ 캐시 kospiflow.json).
//   npx tsx scripts/kospi-flow-persistence.ts

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { fetchDailyPredict } from "../lib/predict/data";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");

// 코스피 시장 투자자별 일자별 순매수 (억원) — futflow와 동일 페이지 구조, sosok=01
async function fetchKospiCashFlow(): Promise<{ date: string; v: number }[]> {
  const file = resolve(CACHE_DIR, "kospiflow.json");
  if (existsSync(file)) {
    try {
      // 기존 daily-swing-flow 캐시는 {date, frgn} 키 — v로 정규화
      const cached = JSON.parse(readFileSync(file, "utf8")) as { date: string; v?: number; frgn?: number }[];
      if (cached.length > 1000) return cached.map((x) => ({ date: x.date, v: x.v ?? x.frgn ?? 0 }));
    } catch { /* 재수집 */ }
  }
  const byDate = new Map<string, number>();
  for (let p = 1; p <= 400; p++) {
    const res = await fetch(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=20991231&sosok=01&page=${p}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
    });
    if (!res.ok) break;
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    const rowRe = /<td class="date2">(\d{2})\.(\d{2})\.(\d{2})<\/td>([\s\S]*?)<\/tr>/g;
    let m: RegExpExecArray | null;
    let found = 0;
    while ((m = rowRe.exec(html)) !== null) {
      const date = `20${m[1]}-${m[2]}-${m[3]}`;
      const nums = [...m[4].matchAll(/<td class="rate_(?:up|down)3">([+\-]?[\d,]+)<\/td>/g)].map((x) => parseFloat(x[1].replace(/,/g, "")));
      if (nums.length < 2 || !isFinite(nums[1])) continue; // [개인, 외국인, 기관계]
      if (!byDate.has(date)) byDate.set(date, nums[1]);
      found++;
    }
    if (found === 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const rows = [...byDate.entries()].map(([date, v]) => ({ date, v })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length > 0) writeFileSync(file, JSON.stringify(rows));
  return rows;
}

const pearson = (x: number[], y: number[]): number => {
  const n = Math.min(x.length, y.length);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return c / Math.sqrt(vx * vy);
};

async function main() {
  const flow = (await fetchKospiCashFlow()).filter((x) => x.v !== 0);
  const v = flow.map((x) => x.v);
  const n = v.length;
  let bb = 0, bTot = 0, ss = 0, sTot = 0;
  for (let i = 0; i < n - 1; i++) {
    if (v[i] > 0) { bTot++; if (v[i + 1] > 0) bb++; }
    else { sTot++; if (v[i + 1] < 0) ss++; }
  }
  const buyRate = v.filter((x) => x > 0).length / n;
  const runs: number[] = [];
  let cur = 1;
  for (let i = 1; i < n; i++) { if ((v[i] > 0) === (v[i - 1] > 0)) cur++; else { runs.push(cur); cur = 1; } }
  runs.push(cur);
  let b3 = 0, b3Tot = 0, s3 = 0, s3Tot = 0;
  for (let i = 2; i < n - 1; i++) {
    if (v[i] > 0 && v[i - 1] > 0 && v[i - 2] > 0) { b3Tot++; if (v[i + 1] > 0) b3++; }
    if (v[i] < 0 && v[i - 1] < 0 && v[i - 2] < 0) { s3Tot++; if (v[i + 1] < 0) s3++; }
  }
  const lags = [1, 2, 3, 5].map((L) => pearson(v.slice(0, n - L), v.slice(L)).toFixed(2));
  console.log(`═ 코스피 시장 외인 현물 (${flow[0]?.date}~${flow[n - 1]?.date}, ${n}일, 매수일 비율 ${Math.round(buyRate * 100)}%)`);
  console.log(`  ① 지속: P(내일 매수|오늘 매수) ${Math.round((100 * bb) / bTot)}% (기저 ${Math.round(buyRate * 100)}%) · P(내일 매도|오늘 매도) ${Math.round((100 * ss) / sTot)}% (기저 ${Math.round((1 - buyRate) * 100)}%)`);
  console.log(`     3일 연속 매수(${b3Tot}회) 후 내일도 매수 ${Math.round((100 * b3) / b3Tot)}% · 3일 연속 매도(${s3Tot}회) 후 내일도 매도 ${Math.round((100 * s3) / s3Tot)}%`);
  console.log(`     묶음 평균 ${(runs.reduce((a, b) => a + b, 0) / runs.length).toFixed(1)}일 (무작위 ~2.0) · 최장 ${Math.max(...runs)}일`);
  console.log(`  ② 자기상관 lag1/2/3/5: ${lags.join("/")}`);

  // ③ 묶음 상태 → 익일 삼전·하닉 수익
  const fmap = new Map(flow.map((x) => [x.date, x.v]));
  const fdates = flow.map((x) => x.date);
  for (const [code, name] of [["005930", "삼전"], ["000660", "하닉"]] as const) {
    const bars = await fetchDailyPredict(code, 2600);
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    const stats: Record<string, { c: number; s: number; u: number }> = {};
    for (let k = 2; k < fdates.length; k++) {
      const i = idx.get(fdates[k]);
      if (i === undefined || i + 1 >= bars.length) continue;
      const [a, b, c] = [fmap.get(fdates[k - 2])!, fmap.get(fdates[k - 1])!, fmap.get(fdates[k])!];
      const key = a > 0 && b > 0 && c > 0 ? "3일연속 매수" : a < 0 && b < 0 && c < 0 ? "3일연속 매도" : c > 0 ? "당일 매수(비연속)" : "당일 매도(비연속)";
      const r = (bars[i + 1].close / bars[i].close - 1) * 100;
      stats[key] ??= { c: 0, s: 0, u: 0 };
      stats[key].c++; stats[key].s += r; if (r > 0) stats[key].u++;
    }
    console.log(`  ③ ${name} 익일 수익: ${Object.entries(stats).map(([k, x]) => `${k} ${x.c}일 ${(x.s / x.c >= 0 ? "+" : "") + (x.s / x.c).toFixed(2)}%·상승${Math.round((100 * x.u) / x.c)}%`).join(" | ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
