// 정책금리 기대(금리인상/인하 확률) 변화 축 실측 (사용자 요청 2026-07-27 — "FOMC 금리인상
// 확률 변화에 따라서도 분석"): CME FedWatch의 원천인 연방기금 선물(ZQ=F, 내재금리 = 100-가격)의
// 일일 기대 변화(bp)를 축으로, ①전체 ②FOMC 임박(D-3~결정일) ③FOMC 직후(D+1~D+3) 구간별로
// 익일(한국 마감→익일 마감) 수익과 대조. 단조 구간만 점수판 가중 후보 (env-axis-grading 프레임).
//   npx tsx scripts/fed-rate-expectation.ts
// ⚠근월물 롤오버로 월말 부근 소폭 점프 가능 — |변화| 25bp 초과는 이상치로 제외.

import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
import { FOMC_DECISION_DATES } from "../lib/predict-daily/eventCalendar";

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
const dayDiff = (a: string, b: string) => Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400e3);

async function main() {
  const zq = await daySeries("ZQ=F", 4300);
  // 미 2년물 (2YY=F, 2021-08~) — 정책금리 기대의 실질 집계 (근월 ZQ의 회의 확률 무반응 한계 보완).
  // 내재금리 아님·수익률 그대로: chgBp = (오늘-어제)×100.
  const y2 = await daySeries("2YY=F", 4300);
  // FOMC 상대 위치: 다음 결정일까지 일수(0=결정일) / 직전 결정일로부터 일수
  const nextFomcIn = (d: string): number => {
    let best = 999;
    for (const f of FOMC_DECISION_DATES) { const dd = dayDiff(f, d); if (dd >= 0 && dd < best) best = dd; }
    return best;
  };
  const sinceFomc = (d: string): number => {
    let best = 999;
    for (const f of FOMC_DECISION_DATES) { const dd = dayDiff(d, f); if (dd > 0 && dd < best) best = dd; }
    return best;
  };

  const EDGES = [-10, -5, -2, 2, 5, 10];
  for (const sym of ["005930", "000660"]) {
    const bars = await fetchDailyPredict(sym, 2600);
    const n = bars.length;
    for (const src of [
      { name: "ZQ 근월 내재금리", s: zq, implied: true },
      { name: "미 2년물 (2YY=F, 2021-08~)", s: y2, implied: false },
    ]) {
    console.log(`\n■ ${sym} — ${src.name}`);
    for (const win of [
      { name: "전체", ok: (_d: string) => true },
      { name: "FOMC 임박 (D-3~결정일)", ok: (d: string) => nextFomcIn(d) <= 3 },
      { name: "FOMC 직후 (D+1~D+3)", ok: (d: string) => sinceFomc(d) <= 3 },
      { name: "평상시 (임박·직후 제외)", ok: (d: string) => nextFomcIn(d) > 3 && sinceFomc(d) > 3 },
    ]) {
      const nb = EDGES.length + 1;
      const cnt = new Array(nb).fill(0), sum = new Array(nb).fill(0), up = new Array(nb).fill(0);
      for (let i = 260; i < n - 1; i++) {
        const d = bars[i].date;
        if (!win.ok(d)) continue;
        const t = lastTwoBefore(src.s, d);
        if (!t) continue;
        const chgBp = src.implied ? ((100 - t[0]) - (100 - t[1])) * 100 : (t[0] - t[1]) * 100; // + = 인상 쪽 재가격
        if (Math.abs(chgBp) > 25) continue; // 롤오버 이상치
        let b = EDGES.findIndex((e) => chgBp < e);
        if (b < 0) b = nb - 1;
        const r = (bars[i + 1].close / bars[i].close - 1) * 100;
        cnt[b]++; sum[b] += r; if (r > 0) up[b]++;
      }
      const lab = (b: number) => b === 0 ? `<${EDGES[0]}` : b === nb - 1 ? `≥${EDGES[nb - 2]}` : `${EDGES[b - 1]}~${EDGES[b]}`;
      const cells = Array.from({ length: nb }, (_, b) =>
        `${lab(b)}bp: ${cnt[b]}일 ${cnt[b] ? (sum[b] / cnt[b] >= 0 ? "+" : "") + (sum[b] / cnt[b]).toFixed(2) : "—"}%·상승${cnt[b] ? Math.round((100 * up[b]) / cnt[b]) : 0}%`);
      console.log(`  [${win.name}]`);
      console.log(`    ${cells.join(" | ")}`);
    }
    }
  }
  console.log(`\n주: 변화 = 전일 대비 내재 정책금리 기대(+ = 인상 쪽으로 재가격). 셀 = 익일 평균수익·상승비율.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
