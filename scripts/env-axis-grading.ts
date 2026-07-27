// 환경 점수판 축별 "크기 → 익일 수익" 버킷 실측 (사용자 제안 2026-07-27 — "변경 크기에 따라
// 가중치가 달라져야"): 임의 가중 대신, 각 축의 변화 크기 버킷별 익일(마감→익일마감) 수익
// 분포가 단조로운 구간에만 단계 가중을 부여한다. 스펙 9장 후속.
//   npx tsx scripts/env-axis-grading.ts
// 시점 정합: t일 15:05 판정이 아는 값(간밤 미국·전일 환율) → t+1 수익과 대조 (게이트 프레임과 동일).

import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";

const yf = new YahooFinance();
type Series = { date: string; close: number }[];
async function daySeries(symbol: string, days: number): Promise<Series> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((q) => q.close != null && isFinite(q.close as number))
    .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close as number }));
}
function lastTwoBefore(s: Series, kstDate: string): [number, number] | null {
  for (let i = s.length - 1; i >= 1; i--) if (s[i].date < kstDate) return [s[i].close, s[i - 1].close];
  return null;
}

async function main() {
  const [sox, fx, tnx, wti, dxy] = await Promise.all([
    daySeries("^SOX", 4300), daySeries("KRW=X", 4300), daySeries("^TNX", 4300), daySeries("CL=F", 4300), daySeries("DX-Y.NYB", 4300),
  ]);
  const norm10y = (v: number) => (v > 20 ? v / 10 : v);
  const chg = (s: Series, d: string): number | null => { const t = lastTwoBefore(s, d); return t ? ((t[0] - t[1]) / t[1]) * 100 : null; };
  const chgPp = (s: Series, d: string): number | null => { const t = lastTwoBefore(s, d); return t ? norm10y(t[0]) - norm10y(t[1]) : null; };

  type Axis = { name: string; val: (d: string) => number | null; edges: number[] };
  const axes: Axis[] = [
    { name: "간밤 SOX %", val: (d) => chg(sox, d), edges: [-3, -1.5, -0.5, 0.5, 1.5, 3] },
    { name: "전일 10Y %p", val: (d) => chgPp(tnx, d), edges: [-0.08, -0.04, 0.04, 0.08, 0.15] },
    { name: "간밤 DXY %", val: (d) => chg(dxy, d), edges: [-0.8, -0.4, 0.4, 0.8, 1.2] },
    { name: "전일 환율 %", val: (d) => chg(fx, d), edges: [-1, -0.5, 0.5, 1, 1.5] },
    { name: "간밤 WTI %", val: (d) => chg(wti, d), edges: [-3, -1.5, 1.5, 3, 5] },
  ];

  for (const sym of ["005930", "000660"]) {
    const bars = await fetchDailyPredict(sym, 2600);
    const n = bars.length;
    console.log(`\n■ ${sym} (${bars[260]?.date}~, 표본 ${n - 261}일)`);
    for (const ax of axes) {
      const nb = ax.edges.length + 1;
      const cnt = new Array(nb).fill(0), sum = new Array(nb).fill(0), up = new Array(nb).fill(0);
      for (let i = 260; i < n - 1; i++) {
        const v = ax.val(bars[i].date);
        if (v === null) continue;
        let b = ax.edges.findIndex((e) => v < e);
        if (b < 0) b = nb - 1;
        const r = (bars[i + 1].close / bars[i].close - 1) * 100;
        cnt[b]++; sum[b] += r; if (r > 0) up[b]++;
      }
      const lab = (b: number) => b === 0 ? `<${ax.edges[0]}` : b === nb - 1 ? `≥${ax.edges[nb - 2]}` : `${ax.edges[b - 1]}~${ax.edges[b]}`;
      const cells = Array.from({ length: nb }, (_, b) =>
        `${lab(b)}: ${cnt[b]}일 ${cnt[b] ? (sum[b] / cnt[b] >= 0 ? "+" : "") + (sum[b] / cnt[b]).toFixed(2) : "—"}%·상승${cnt[b] ? Math.round((100 * up[b]) / cnt[b]) : 0}%`);
      console.log(`  ${ax.name.padEnd(10)} ${cells.join(" | ")}`);
    }
  }
  console.log(`\n주: 셀 값 = 익일 평균수익·상승비율. 단조 구간만 단계 가중 후보 (표본 30일 미만 셀은 불신).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
