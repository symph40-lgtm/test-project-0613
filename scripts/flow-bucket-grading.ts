// 외인 수급 크기 버킷 → 익일 수익 (사용자 지시 2026-07-27 — "수급도 구간으로 나눠 크기별
// 점수화"): env-axis-grading 프레임. 축 = ①당일 코스피 외인 현물 순매수(억원 — 15:05엔 KIS
// 잠정, 19시엔 확정 수준) ②직전 3일 누적. 단조·극단 신호가 있는 구간에 점수 가중 부여.
//   npx tsx scripts/flow-bucket-grading.ts   (.predict-cache/kospiflow.json — 무통신)

import { readFileSync } from "fs";
import { resolve } from "path";
import { fetchDailyPredict } from "../lib/predict/data";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const raw = JSON.parse(readFileSync(resolve(process.cwd(), ".predict-cache", "kospiflow.json"), "utf8")) as { date: string; v?: number; frgn?: number }[];
const flow = raw.map((x) => ({ date: x.date, v: x.v ?? x.frgn ?? 0 })).filter((x) => x.v !== 0);
const fIdx = new Map(flow.map((x, i) => [x.date, i]));

async function main() {
  const axes = [
    { name: "당일 순매수 (억원)", edges: [-20000, -10000, -3000, 3000, 10000, 20000], val: (fi: number) => flow[fi].v },
    { name: "3일 누적 (억원)", edges: [-40000, -20000, -6000, 6000, 20000, 40000], val: (fi: number) => (fi >= 2 ? flow[fi - 2].v + flow[fi - 1].v + flow[fi].v : null) },
  ];
  for (const [code, name] of [["005930", "삼전"], ["000660", "하닉"]] as const) {
    const bars = await fetchDailyPredict(code, 2600);
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    console.log(`\n■ ${name}`);
    for (const ax of axes) {
      const nb = ax.edges.length + 1;
      const cnt = new Array(nb).fill(0), sum = new Array(nb).fill(0), up = new Array(nb).fill(0);
      for (const [date, fi] of fIdx) {
        const i = idx.get(date);
        if (i === undefined || i + 1 >= bars.length) continue;
        const v = ax.val(fi);
        if (v === null) continue;
        let b = ax.edges.findIndex((e) => v < e);
        if (b < 0) b = nb - 1;
        const r = (bars[i + 1].close / bars[i].close - 1) * 100;
        cnt[b]++; sum[b] += r; if (r > 0) up[b]++;
      }
      const lab = (b: number) => b === 0 ? `<${ax.edges[0] / 10000}조` : b === nb - 1 ? `≥${ax.edges[nb - 2] / 10000}조` : `${ax.edges[b - 1] / 10000}~${ax.edges[b] / 10000}조`;
      console.log(`  ${ax.name}`);
      console.log(`    ${Array.from({ length: nb }, (_, b) => `${lab(b)}: ${cnt[b]}일 ${cnt[b] ? (sum[b] / cnt[b] >= 0 ? "+" : "") + (sum[b] / cnt[b]).toFixed(2) : "—"}%·상승${cnt[b] ? Math.round((100 * up[b]) / cnt[b]) : 0}%`).join(" | ")}`);
    }
  }
  console.log(`\n주: 익일 평균수익·상승비율. 단조·양종목 일관 구간만 점수 후보.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
