import { getBriefing } from "../actions";
import { createClient } from "@/lib/supabase/server";
import { generatePreclose } from "@/lib/ai/briefing";
import { fetchMonthlyUsEvents, hasFredKey, type EconEvent } from "@/lib/calendar/fred";
import { fetchSemiAiEarnings, fetchEarningsFundamentals, type EarningsFundamentals } from "@/lib/market/earnings";
import { fetchEarningsKeyPoints, fetchIndicatorConsensus, type EarningsKeyPoint, type IndicatorConsensus } from "@/lib/ai/earningsFocus";
import { fetchHoldingsFlow, toKrCode, type StockFlow, fetchKospi200Futures } from "@/lib/market/naver-flow";
import { fetchMarketData } from "@/lib/market/fetch";
import { calculateRiskScores, calculateCompositeScore } from "@/lib/market/risk";
import { getMarketSession } from "@/lib/market/session";
import PrecloseClient from "./PrecloseClient";
import type { AiPrecloseOutput, MarketData, RiskScores } from "@/lib/market/types";

export const dynamic = "force-dynamic";

const fmtPct = (v: number | null) => (v === null ? "N/A" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

// 한국장 마감 시, 정규장 종가에 멈춘 코스피 대신 '현재 라이브 오버나잇 신호'로 방향을 대체한다.
//  우선순위: 코스피200 야간선물(라이브) → 나스닥 선물(오버나잇 선행) → (없으면) 종가.
type Effective = { kospiEff: number | null; proxyLabel: string | null; krOpen: boolean };
function effectiveKospi(m: MarketData, kospiFut: Awaited<ReturnType<typeof fetchKospi200Futures>>): Effective {
  const krOpen = getMarketSession().key === "regular" || getMarketSession().key === "closing";
  if (krOpen) return { kospiEff: m.kospi.changePercent, proxyLabel: null, krOpen };
  if (kospiFut && !kospiFut.stale && kospiFut.changePercent != null)
    return { kospiEff: kospiFut.changePercent, proxyLabel: "코스피200 야간선물", krOpen };
  if (!m.nasdaq.stale && m.nasdaq.changePercent != null)
    return { kospiEff: m.nasdaq.changePercent, proxyLabel: "나스닥 선물(오버나잇 선행)", krOpen };
  return { kospiEff: m.kospi.changePercent, proxyLabel: "정규장 종가", krOpen };
}

// 시세 기반 오늘 장 요약 — 세션 인지(한국장 마감 시 코스피는 종가로 표기, 방향은 라이브 신호 기준)
function buildMarketSummary(m: MarketData | null, eff: Effective): string {
  if (!m) return "시장 데이터를 불러오지 못했습니다.";
  const parts: string[] = [`나스닥 ${fmtPct(m.nasdaq.changePercent)}`, `반도체(SOX) ${fmtPct(m.sox.changePercent)}`];
  // 톤은 라이브 신호로 — 한국장 마감 시 정규장 코스피 종가는 톤 계산에서 제외
  const toneVals: number[] = [m.nasdaq.changePercent, m.sox.changePercent].filter(
    (v): v is number => v !== null,
  );
  if (eff.krOpen) {
    parts.push(`코스피 ${fmtPct(m.kospi.changePercent)}`);
    if (m.kospi.changePercent !== null) toneVals.push(m.kospi.changePercent);
  } else {
    parts.push(`코스피 ${fmtPct(m.kospi.changePercent)}(15:30 종가)`);
  }
  const avg = toneVals.length ? toneVals.reduce((a, b) => a + b, 0) / toneVals.length : 0;
  const tone = avg > 0.5 ? "위험자산 강세 흐름" : avg < -0.5 ? "위험자산 약세 흐름" : "혼조 흐름";
  const rate = m.treasury10y.price;
  const ratePart = rate !== null ? ` · 미국채 10Y ${rate.toFixed(2)}%` : "";
  const overnight =
    !eff.krOpen && eff.proxyLabel && eff.proxyLabel !== "정규장 종가"
      ? ` · 오버나잇 코스피 선행: ${eff.proxyLabel} ${fmtPct(eff.kospiEff)}`
      : "";
  const note = eff.krOpen ? "" : " (코스피는 정규장 종가 — 현재 방향은 미국장·선물 기준)";
  return `${parts.join(", ")}${ratePart}${overnight}. ${tone}입니다.${note}`;
}

// 지표 종류별 상회/부합/하회 영향 템플릿
function impactFor(name: string): { up: string; mid: string; down: string } {
  const n = name;
  if (n.includes("FOMC"))
    return {
      up: "매파적(긴축 신호) → 금리 상승, 기술주·레버리지 부담 확대 가능",
      mid: "시장 예상 부합 → 기존 장세 흐름 유지 가능",
      down: "비둘기적(완화 신호) → 위험자산·성장주 우호적 가능",
    };
  if (n.includes("물가") || n.includes("CPI") || n.includes("PPI") || n.includes("PCE"))
    return {
      up: "예상 상회(인플레↑) → 금리 인하 기대 후퇴, 기술주·레버리지 부담",
      mid: "예상 부합 → 기존 흐름 유지 가능",
      down: "예상 하회(인플레↓) → 금리 인하 기대, 위험자산 우호적 가능",
    };
  if (n.includes("고용"))
    return {
      up: "예상 상회(고용 견조) → 긴축 장기화 우려와 경기 호조 혼재",
      mid: "예상 부합 → 기존 흐름 유지 가능",
      down: "예상 하회(고용 둔화) → 경기 둔화 우려 부각 가능",
    };
  if (n.includes("소매"))
    return {
      up: "예상 상회(소비 견조) → 경기 긍정, 소비·경기민감주 우호 가능",
      mid: "예상 부합 → 기존 흐름 유지 가능",
      down: "예상 하회(소비 둔화) → 경기 둔화 우려 가능",
    };
  return {
    up: "예상 상회 → 위험자산에 우호적이거나 금리 부담 혼재 가능",
    mid: "예상 부합 → 기존 장세 흐름 유지 가능",
    down: "예상 하회 → 경기 둔화 우려 단기 부각 가능",
  };
}

// 가장 임박한 '예정' 중요 지표 기준 시나리오
function buildEventScenario(events: EconEvent[]) {
  const upcoming = events.filter((e) => !e.released);
  const target =
    upcoming.find((e) => e.stars >= 5) ?? upcoming.find((e) => e.stars >= 4) ?? upcoming[0];
  if (!target) return null;
  const imp = impactFor(target.name);
  return {
    eventName: target.name,
    date: target.date,
    timeKst: target.timeKst,
    scenarios: [
      { result: "예상 상회", impact: imp.up },
      { result: "예상 부합", impact: imp.mid },
      { result: "예상 하회", impact: imp.down },
    ],
  };
}

export default async function PreClosePage() {
  const [snapshot, econEvents, earnings, liveMarket, liveKospiFut] = await Promise.all([
    getBriefing(),
    fetchMonthlyUsEvents(),
    fetchSemiAiEarnings(35),
    fetchMarketData(),
    fetchKospi200Futures(),
  ]);

  // 현재 시점 라이브 리스크 — 한국장 마감 시 정규장 코스피 종가 대신 오버나잇 신호로 코스피를 대체해 재계산.
  const eff = effectiveKospi(liveMarket, liveKospiFut);
  const marketForRisk: MarketData = {
    ...liveMarket,
    kospi: { ...liveMarket.kospi, changePercent: eff.kospiEff },
  };
  const liveRisk = calculateCompositeScore(calculateRiskScores(marketForRisk));

  // 예정 실적 기업의 펀더멘털·컨센서스·거버넌스 (발표 전 매수/매도 판단용)
  const fundamentals: Record<string, EarningsFundamentals | null> = {};
  await Promise.all(
    earnings.map(async (e) => {
      fundamentals[e.symbol] = await fetchEarningsFundamentals(e.symbol);
    }),
  );

  // 기업별 '핵심 관전 포인트' — 가까운 실적부터 뉴스+컨센서스로 가장 중요한 지표·예상치 추출
  const keyPoints: Record<string, EarningsKeyPoint> = await fetchEarningsKeyPoints(
    earnings.map((e) => ({ symbol: e.symbol, name: e.name, dateKst: e.dateKst })),
    fundamentals,
    5,
  ).catch(() => ({}));

  let preclose: AiPrecloseOutput | null = null;
  let supplyFlows: StockFlow[] = [];

  if (snapshot?.market_data && snapshot.risk_scores && snapshot.risk_score !== null) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const { data: positions } = await supabase
        .from("positions")
        .select("ticker, name, weight, is_leverage, sector")
        .eq("user_id", user.id)
        .order("weight", { ascending: false });

      preclose = await generatePreclose(
        snapshot.market_data as MarketData,
        snapshot.risk_scores as RiskScores,
        snapshot.risk_score,
        positions ?? [],
      );

      // 네이버 수급(외국인·기관 순매매)
      const krHoldings = (positions ?? [])
        .map((p) => {
          const code = toKrCode(p.name as string | null, p.ticker);
          return code ? { ticker: p.ticker, code } : null;
        })
        .filter((v): v is { ticker: string; code: string } => v !== null);
      if (krHoldings.length > 0) {
        try {
          supplyFlows = await fetchHoldingsFlow(krHoldings, 6);
        } catch {
          supplyFlows = [];
        }
      }
    }
  }

  const marketSummary = buildMarketSummary(liveMarket, eff);
  const eventScenario = buildEventScenario(econEvents);
  // 가장 임박한 지표의 시장 컨센서스·예측 종합(뉴스 기반) — 예: 근원 PCE 예상치
  const eventConsensus: IndicatorConsensus | null = eventScenario
    ? await fetchIndicatorConsensus(eventScenario.eventName, eventScenario.date).catch(() => null)
    : null;

  return (
    <PrecloseClient
      snapshot={snapshot}
      preclose={preclose}
      econEvents={econEvents}
      earnings={earnings}
      fundamentals={fundamentals}
      fredConfigured={hasFredKey()}
      marketSummary={marketSummary}
      eventScenario={eventScenario}
      eventConsensus={eventConsensus}
      supplyFlows={supplyFlows}
      keyPoints={keyPoints}
      liveRisk={liveRisk}
      krOpen={eff.krOpen}
    />
  );
}
