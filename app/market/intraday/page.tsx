import { createClient } from "@/lib/supabase/server";
import { fetchMarketData, fetchPositionQuotes, fetchTreasuryHistory } from "@/lib/market/fetch";
import {
  calculateRiskScores,
  calculateCompositeScore,
  classifyStage,
  stagePosture,
} from "@/lib/market/risk";
import { getMarketSession } from "@/lib/market/session";
import { fetchSemiAiEarnings } from "@/lib/market/earnings";
import { fetchPositionNews } from "@/lib/news/fetch";
import IntradayClient from "./_client";

// 클릭(새로고침) 시 항상 그 시점 실시간 데이터를 가져오도록 동적 렌더링
export const dynamic = "force-dynamic";

function indicator(q: { price: number | null; changePercent: number | null }) {
  return { price: q.price, changePercent: q.changePercent };
}

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
  const quoteInputs = (positions ?? []).map((p) => ({
    ticker: p.ticker,
    symbol: p.name as string | null,
  }));

  const [market, quotes, news, bondHistory, earnings] = await Promise.all([
    fetchMarketData(),
    fetchPositionQuotes(quoteInputs),
    fetchPositionNews(tickers),
    fetchTreasuryHistory(20),
    fetchSemiAiEarnings(),
  ]);

  const riskScores = calculateRiskScores(market);
  const composite = calculateCompositeScore(riskScores);
  const stage = classifyStage(composite);
  const posture = stagePosture(stage);
  const session = getMarketSession();

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
        nasdaq: indicator(market.nasdaq),
        sox: indicator(market.sox),
        kospi: indicator(market.kospi),
        usdkrw: indicator(market.usdkrw),
        oil: indicator(market.oil),
        treasury10y: indicator(market.treasury10y),
        fetchedAt: market.fetchedAt,
      }}
      composite={composite}
      stage={stage}
      posture={posture}
      session={session}
      bondHistory={bondHistory}
      earnings={earnings}
      holdings={holdings}
      news={news}
    />
  );
}
