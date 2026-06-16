import { createClient } from "@/lib/supabase/server";
import {
  fetchMarketData,
  fetchPositionQuotes,
  fetchTreasuryHistory,
  fetchBondEtf,
  effectiveQuote,
} from "@/lib/market/fetch";
import type { QuoteData } from "@/lib/market/types";
import {
  calculateRiskScores,
  calculateCompositeScore,
  classifyStage,
  stagePosture,
} from "@/lib/market/risk";
import { getMarketSession } from "@/lib/market/session";
import { recommendForHolding } from "@/lib/market/recommend";
import { fetchSemiAiEarnings } from "@/lib/market/earnings";
import { fetchPositionNews } from "@/lib/news/fetch";
import IntradayClient from "./_client";

// 클릭(새로고침) 시 항상 그 시점 실시간 데이터를 가져오도록 동적 렌더링
export const dynamic = "force-dynamic";

function indicator(q: QuoteData) {
  const eff = effectiveQuote(q);
  return { price: eff.price, changePercent: eff.changePercent, session: eff.session };
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

  // 글로벌 반도체 비교군 (한국 ↔ 미국 메모리/스토리지)
  const SEMI_COMPARE = [
    { ticker: "삼성전자", symbol: "005930.KS" },
    { ticker: "SK하이닉스", symbol: "000660.KS" },
    { ticker: "마이크론 (MU)", symbol: "MU" },
    { ticker: "씨게이트 (STX)", symbol: "STX" },
    { ticker: "웨스턴디지털 (WDC)", symbol: "WDC" },
  ];

  const [market, quotes, news, bondHistory, earnings, bondEtf, semiQuotes] = await Promise.all([
    fetchMarketData(),
    fetchPositionQuotes(quoteInputs),
    fetchPositionNews(tickers),
    fetchTreasuryHistory(20),
    fetchSemiAiEarnings(),
    fetchBondEtf("TLT"),
    fetchPositionQuotes(SEMI_COMPARE),
  ]);

  const semiCompare = SEMI_COMPARE.map((s) => {
    const q = semiQuotes.find((x) => x.ticker === s.ticker);
    return {
      ticker: s.ticker,
      price: q?.price ?? null,
      changePercent: q?.changePercent ?? null,
      currency: q?.currency ?? null,
      session: q?.session ?? null,
    };
  });

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
      session: q?.session ?? null,
    };
  });

  // 보유 종목별 매매 판단 (매수/보유/매도 + 3단계)
  const recs = (positions ?? []).map((p) =>
    recommendForHolding(
      {
        ticker: p.ticker,
        weight: Number(p.weight),
        is_leverage: p.is_leverage,
        sector: p.sector,
        risk_level: p.risk_level as string | null,
        changePercent: quoteMap.get(p.ticker)?.changePercent ?? null,
      },
      { composite, soxChange: market.sox.changePercent },
    ),
  );

  return (
    <IntradayClient
      market={{
        nasdaq: indicator(market.nasdaq),
        sox: indicator(market.sox),
        kospi: indicator(market.kospi),
        usdkrw: indicator(market.usdkrw),
        oil: indicator(market.oil),
        treasury10y: indicator(market.treasury10y),
        vix: indicator(market.vix),
        fetchedAt: market.fetchedAt,
      }}
      composite={composite}
      stage={stage}
      posture={posture}
      session={session}
      bondHistory={bondHistory}
      bondEtf={bondEtf}
      semiCompare={semiCompare}
      earnings={earnings}
      holdings={holdings}
      recs={recs}
      news={news}
    />
  );
}
