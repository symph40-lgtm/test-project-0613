import { createClient } from "@/lib/supabase/server";
import { fetchMarketData, fetchPositionQuotes } from "@/lib/market/fetch";
import {
  calculateRiskScores,
  calculateCompositeScore,
  classifyStage,
} from "@/lib/market/risk";
import { fetchPositionNews } from "@/lib/news/fetch";
import IntradayClient from "./_client";

export const revalidate = 300; // 5분마다 재생성

export default async function IntradaySummaryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: positions } = user
    ? await supabase
        .from("positions")
        .select("ticker, name, weight, is_leverage, sector, risk_level")
        .eq("user_id", user.id)
        .order("weight", { ascending: false })
    : { data: [] };

  const tickers = (positions ?? []).map((p) => p.ticker);
  // name 컬럼에 저장된 확정 심볼을 함께 전달 (정확도)
  const quoteInputs = (positions ?? []).map((p) => ({
    ticker: p.ticker,
    symbol: p.name as string | null,
  }));

  // 시장 데이터 · 종목 시세 · 뉴스 병렬 조회
  const [market, quotes, news] = await Promise.all([
    fetchMarketData(),
    fetchPositionQuotes(quoteInputs),
    fetchPositionNews(tickers),
  ]);

  const riskScores = calculateRiskScores(market);
  const composite = calculateCompositeScore(riskScores);
  const stage = classifyStage(composite);

  // 종목별 시세를 positions에 병합
  const quoteMap = new Map(quotes.map((q) => [q.ticker, q]));
  const holdings = (positions ?? []).map((p) => {
    const q = quoteMap.get(p.ticker);
    return {
      ticker: p.ticker,
      weight: Number(p.weight),
      is_leverage: p.is_leverage,
      sector: p.sector,
      risk_level: p.risk_level as string | null,
      price: q?.price ?? null,
      changePercent: q?.changePercent ?? null,
      currency: q?.currency ?? null,
    };
  });

  return (
    <IntradayClient
      market={{
        nasdaq: market.nasdaq.changePercent,
        sox: market.sox.changePercent,
        kospi: market.kospi.changePercent,
        usdkrw: market.usdkrw.changePercent,
        oil: market.oil.changePercent,
        treasury10y: market.treasury10y.changePercent,
        fetchedAt: market.fetchedAt,
      }}
      composite={composite}
      stage={stage}
      holdings={holdings}
      news={news}
    />
  );
}
