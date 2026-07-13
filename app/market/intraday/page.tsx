import { createClient } from "@/lib/supabase/server";
import {
  fetchMarketData,
  fetchPositionQuotes,
  fetchTreasuryHistory,
  fetchBondEtf,
  fetchOffHoursIndex,
  fetchMainIndicators,
  effectiveQuote,
} from "@/lib/market/fetch";
import type { QuoteData } from "@/lib/market/types";
import {
  calculateRiskScores,
  calculateCompositeScore,
  classifyStage,
  stagePosture,
  intradayDropRisk,
} from "@/lib/market/risk";
import { getMarketSession } from "@/lib/market/session";
import { fetchKospi200Futures } from "@/lib/market/naver-flow";
import { scoreHolding } from "@/lib/market/holdingScore";
import { fetchAiStanceBias } from "@/lib/ai/insights";
import { fetchBondSignal } from "@/lib/market/bondSignal";
import { fetchUs2yIntraday } from "@/lib/market/rateIntraday";
import { fetchSemiAiEarnings } from "@/lib/market/earnings";
import { fetchSemiSectorNews } from "@/lib/news/fetch";
import { fetchBigtechAiNews, detectUrgentBigtechAlert } from "@/lib/market/urgentAlert";
import IntradayClient from "./_client";

// 클릭(새로고침) 시 항상 그 시점 실시간 데이터를 가져오도록 동적 렌더링
export const dynamic = "force-dynamic";

function indicator(q: QuoteData) {
  const eff = effectiveQuote(q);
  return {
    price: eff.price,
    changePercent: eff.changePercent,
    session: eff.session,
    stale: q.stale ?? false,
    sourceNote: q.sourceNote ?? null,
  };
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

  const [market, quotes, news, bondHistory, earnings, bondEtf, semiQuotes, offHours, bondSignal, kospiFut, bigtechNews, us2y] = await Promise.all([
    fetchMarketData(),
    fetchPositionQuotes(quoteInputs),
    fetchSemiSectorNews(tickers, 15),
    fetchTreasuryHistory(20),
    fetchSemiAiEarnings(),
    fetchBondEtf("TLT"),
    fetchPositionQuotes(SEMI_COMPARE),
    fetchOffHoursIndex(),
    fetchBondSignal(),
    fetchKospi200Futures(),
    fetchBigtechAiNews(12),
    fetchUs2yIntraday(),
  ]);

  const semiCompare = SEMI_COMPARE.map((s) => {
    const q = semiQuotes.find((x) => x.ticker === s.ticker);
    return {
      ticker: s.ticker,
      price: q?.price ?? null,
      changePercent: q?.changePercent ?? null,
      currency: q?.currency ?? null,
      session: q?.session ?? null,
      asOf: q?.asOf ?? null,
      stale: q?.stale ?? false,
    };
  });

  // AI 빅테크發 반도체 급등락 긴급 감지 — 빅테크 AI 뉴스 + 삼성·하이닉스 당일 ±3% 동시 성립 시 긴급 배너
  const urgentAlert = detectUrgentBigtechAlert({
    semis: semiCompare.map((s) => ({ ticker: s.ticker, changePercent: s.changePercent })),
    news: [...bigtechNews, ...news],
    threshold: 3,
  });

  // 세션 인지형 주요 지표 (나스닥·SOX는 ETF로 정규/애프터/합계 분해)
  const mainIndicators = await fetchMainIndicators(market);

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

  // 보유 종목 가중 평균 당일 등락(있는 것만)
  const hw = holdings.filter((h) => typeof h.changePercent === "number");
  const wSum = hw.reduce((a, h) => a + h.weight, 0);
  const holdingsAvg =
    hw.length > 0 && wSum > 0
      ? hw.reduce((a, h) => a + (h.changePercent as number) * h.weight, 0) / wSum
      : null;

  // 당일 실시간 급락 오버레이로 composite 보정(미국 밤사이 데이터에 가려진 '오늘의 하락' 반영)
  const riskScores = calculateRiskScores(market);
  const baseComposite = calculateCompositeScore(riskScores);
  const dropRisk = intradayDropRisk({
    kospi: market.kospi.changePercent,
    kospiFut: kospiFut && !kospiFut.stale ? kospiFut.changePercent : null,
    nasdaqFut: market.nasdaq.stale ? null : market.nasdaq.changePercent,
    holdingsAvg,
  });
  const composite = Math.max(0, Math.min(100, baseComposite + dropRisk));
  const stage = classifyStage(composite);
  const posture = stagePosture(stage, composite);

  // 당일 시장 최악 신호(코스피·코스피선물·나스닥선물·보유평균 중 가장 많이 빠진 값)
  const marketDrop = Math.min(
    ...[
      market.kospi.changePercent,
      kospiFut && !kospiFut.stale ? kospiFut.changePercent : null,
      market.nasdaq.stale ? null : market.nasdaq.changePercent,
      holdingsAvg,
    ].filter((v): v is number => typeof v === "number"),
    0,
  );

  // AI Q&A 스탠스 바이어스(reflect=true 최신) — ±2 한정 반영
  const aiStance = await fetchAiStanceBias();

  // 보유 종목별 매매 판단 — 애널리스트 6대 기준 실데이터 채점(종목마다 차등) + AI 의견 한정 반영.
  // marketDrop(당일 시장 최악 %)을 종목 점수에 직접 전달 — 급락일 감점·스탠스 상한 (2026-07-13:
  // 하닉 -16% 폭락일에 '중립(매수우위)'가 나온 오판 수정. composite 오버레이만으론 -8점이 상한이었음)
  const recs = await Promise.all(
    (positions ?? []).map((p) => {
      const q = quoteMap.get(p.ticker);
      const tickerBias = aiStance?.tickerBias?.[p.ticker];
      const aiBias = tickerBias ?? aiStance?.marketBias ?? 0;
      const aiReason = aiStance
        ? tickerBias !== undefined
          ? "종목 의견"
          : aiStance.summary
            ? `시장 의견: ${aiStance.summary}`.slice(0, 30)
            : "시장 의견"
        : null;
      return scoreHolding({
        ticker: p.ticker,
        symbol: q?.symbol ?? null,
        isLeverage: p.is_leverage,
        sector: p.sector,
        changePercent: q?.changePercent ?? null,
        marketDropPct: marketDrop,
        composite,
        soxChange: market.sox.changePercent,
        macro: {
          rateChgPct: market.treasury10y.changePercent,
          oilChgPct: market.oil.changePercent,
          dollarChgPct: market.dollarIndex.changePercent,
        },
        aiBias,
        aiReason,
      });
    }),
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
      offHours={offHours}
      kospiFut={kospiFut}
      bondSignal={bondSignal}
      mainIndicators={mainIndicators}
      composite={composite}
      stage={stage}
      posture={posture}
      session={session}
      bondHistory={bondHistory}
      bondEtf={bondEtf}
      us2y={us2y}
      semiCompare={semiCompare}
      earnings={earnings}
      holdings={holdings}
      recs={recs}
      news={news}
      urgentAlert={urgentAlert}
    />
  );
}
