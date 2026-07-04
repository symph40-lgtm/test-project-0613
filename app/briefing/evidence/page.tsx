import { getBriefing } from "../actions";
import { createClient } from "@/lib/supabase/server";
import { fetchHoldingsFlow, toKrCode, type StockFlow } from "@/lib/market/naver-flow";
import { assessPoliticalRisk } from "@/lib/ai/political";
import { fetchMarketData } from "@/lib/market/fetch";
import { fetchKospi200Futures } from "@/lib/market/naver-flow";
import { liveRiskBundle } from "@/lib/market/risk";
import EvidenceClient from "./EvidenceClient";

export const dynamic = "force-dynamic";

export default async function EvidencePage() {
  // 유가·금리·SOX는 실시간 시세로 평가 (스냅샷은 아침 고정이라 저녁 급변 미반영)
  const [snapshot, market, kospiFut] = await Promise.all([
    getBriefing(),
    fetchMarketData(),
    fetchKospi200Futures(),
  ]);
  const political = await assessPoliticalRisk(market);
  // 현재 시점 라이브 위험 점수(한국장 마감 시 코스피는 오버나잇 선물로 대체)
  const live = liveRiskBundle(market, kospiFut);

  // 보유 한국 종목 수급(외국인·기관 순매매) 조회
  let supplyFlows: StockFlow[] = [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: positions } = await supabase
        .from("positions")
        .select("ticker, name, weight")
        .eq("user_id", user.id)
        .order("weight", { ascending: false });

      const krHoldings = (positions ?? [])
        .map((p) => {
          const code = toKrCode(p.name as string | null, p.ticker);
          return code ? { ticker: p.ticker, code } : null;
        })
        .filter((v): v is { ticker: string; code: string } => v !== null);

      if (krHoldings.length > 0) {
        supplyFlows = await fetchHoldingsFlow(krHoldings, 6);
      }
    }
  } catch {
    supplyFlows = [];
  }

  return (
    <EvidenceClient
      snapshot={snapshot}
      supplyFlows={supplyFlows}
      political={political}
      liveScores={live.scores}
      liveComposite={live.composite}
      liveProxy={live.proxy}
    />
  );
}
