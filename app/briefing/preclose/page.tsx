import { getBriefing } from "../actions";
import { createClient } from "@/lib/supabase/server";
import { generatePreclose } from "@/lib/ai/briefing";
import { fetchUpcomingUsEvents, hasFredKey, type EconEvent } from "@/lib/calendar/fred";
import { fetchHoldingsFlow, toKrCode, type StockFlow } from "@/lib/market/naver-flow";
import PrecloseClient from "./PrecloseClient";
import type { AiPrecloseOutput, MarketData, RiskScores } from "@/lib/market/types";

export const dynamic = "force-dynamic";

// 시세 기반 오늘 장 요약 (AI 없이 결정적 생성)
function buildMarketSummary(m: MarketData | null): string {
  if (!m) return "시장 데이터를 불러오지 못했습니다.";
  const parts: string[] = [];
  const push = (label: string, v: number | null) => {
    if (v !== null) parts.push(`${label} ${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
  };
  push("나스닥", m.nasdaq.changePercent);
  push("반도체(SOX)", m.sox.changePercent);
  push("코스피", m.kospi.changePercent);
  const risk = [m.nasdaq.changePercent, m.sox.changePercent, m.kospi.changePercent].filter(
    (v): v is number => v !== null,
  );
  const avg = risk.length ? risk.reduce((a, b) => a + b, 0) / risk.length : 0;
  const tone = avg > 0.5 ? "위험자산 강세 흐름" : avg < -0.5 ? "위험자산 약세 흐름" : "혼조 흐름";
  const rate = m.treasury10y.price;
  const ratePart = rate !== null ? ` · 미국채 10Y ${rate.toFixed(2)}%` : "";
  return `${parts.join(", ")}${ratePart}. ${tone}입니다.`;
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

// 가장 임박한 중요 지표 기준 시나리오
function buildEventScenario(events: EconEvent[]) {
  const target = events.find((e) => e.importance === "high") ?? events[0];
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
  const [snapshot, econEvents] = await Promise.all([getBriefing(), fetchUpcomingUsEvents(5)]);

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

  const marketSummary = buildMarketSummary((snapshot?.market_data as MarketData) ?? null);
  const eventScenario = buildEventScenario(econEvents);

  return (
    <PrecloseClient
      snapshot={snapshot}
      preclose={preclose}
      econEvents={econEvents}
      fredConfigured={hasFredKey()}
      marketSummary={marketSummary}
      eventScenario={eventScenario}
      supplyFlows={supplyFlows}
    />
  );
}
