// 보유 점수 재현 진단 — 오늘(급락일) 삼전·하닉이 왜 '보유확대/중립(매수우위)'로 나오는지
// 실데이터로 요인 분해. `npx tsx scripts/stance-repro.ts`
import { fetchMarketData, fetchPositionQuotes } from "../lib/market/fetch";
import { calculateRiskScores, calculateCompositeScore } from "../lib/market/risk";
import { intradayDropRisk } from "../lib/market/risk";
import { fetchKospi200Futures } from "../lib/market/naver-flow";
import { scoreHolding } from "../lib/market/holdingScore";

async function main() {
  const [market, quotes, kospiFut] = await Promise.all([
    fetchMarketData(),
    fetchPositionQuotes([
      { ticker: "삼성전자", symbol: "005930.KS" },
      { ticker: "SK하이닉스", symbol: "000660.KS" },
    ]),
    fetchKospi200Futures(),
  ]);
  const base = calculateCompositeScore(calculateRiskScores(market));
  const hAvg = quotes.reduce((s, q) => s + (q.changePercent ?? 0), 0) / quotes.length;
  const drop = intradayDropRisk({
    kospi: market.kospi.changePercent,
    kospiFut: kospiFut && !kospiFut.stale ? kospiFut.changePercent : null,
    nasdaqFut: market.nasdaq.stale ? null : market.nasdaq.changePercent,
    holdingsAvg: hAvg,
  });
  const composite = Math.max(0, Math.min(100, base + drop));
  console.log(`composite: base ${base} + dropRisk ${drop} = ${composite}`);
  console.log(`kospi ${market.kospi.changePercent}% · k200선물 ${kospiFut?.changePercent}%(stale=${kospiFut?.stale}) · SOX(전일) ${market.sox.changePercent}%`);

  for (const q of quotes) {
    const r = await scoreHolding({
      ticker: q.ticker,
      symbol: q.symbol ?? null,
      isLeverage: false,
      sector: "반도체",
      changePercent: q.changePercent ?? null,
      marketDropPct: Math.min(market.kospi.changePercent ?? 0, hAvg, 0),
      composite,
      soxChange: market.sox.changePercent,
      macro: {
        rateChgPct: market.treasury10y.changePercent,
        oilChgPct: market.oil.changePercent,
        dollarChgPct: market.dollarIndex.changePercent,
      },
    });
    console.log(`\n── ${q.ticker} (당일 ${q.changePercent}%) → 점수 ${r.score} · 스탠스 ${r.stance}. ${r.label}`);
    for (const f of r.factors) console.log(`  ${f.pts >= 0 ? "+" : ""}${f.pts}  ${f.label} — ${f.detail}`);
  }
}
main();
