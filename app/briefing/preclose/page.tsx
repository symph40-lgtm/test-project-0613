import { getBriefing } from "../actions";
import { createClient } from "@/lib/supabase/server";
import { generatePreclose } from "@/lib/ai/briefing";
import { calculateRiskScores, calculateCompositeScore } from "@/lib/market/risk";
import PrecloseClient from "./PrecloseClient";
import type { AiPrecloseOutput, MarketData, RiskScores } from "@/lib/market/types";

export default async function PreClosePage() {
  const snapshot = await getBriefing();

  let preclose: AiPrecloseOutput | null = null;

  if (snapshot?.market_data && snapshot.risk_scores && snapshot.risk_score !== null) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const { data: positions } = await supabase
        .from("positions")
        .select("ticker, weight, is_leverage, sector")
        .eq("user_id", user.id);

      preclose = await generatePreclose(
        snapshot.market_data as MarketData,
        snapshot.risk_scores as RiskScores,
        snapshot.risk_score,
        positions ?? []
      );
    }
  }

  return <PrecloseClient snapshot={snapshot} preclose={preclose} />;
}
