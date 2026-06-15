"use server";

import { createClient } from "@/lib/supabase/server";
import { fetchMarketData } from "@/lib/market/fetch";
import { calculateRiskScores, calculateCompositeScore, classifyStage } from "@/lib/market/risk";
import { generateBriefing } from "@/lib/ai/briefing";
import type { BriefingSnapshot } from "@/lib/market/types";

export async function getBriefing(date?: string): Promise<BriefingSnapshot | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  // 캐시 히트 확인 (1시간 TTL) — 단, 폴백 스냅샷은 재사용하지 않고 재생성
  const { data: cached } = await supabase
    .from("briefing_snapshots")
    .select("*")
    .eq("user_id", user.id)
    .eq("date", targetDate)
    .eq("is_fallback", false)
    .gte("updated_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .maybeSingle();

  if (cached) return cached as BriefingSnapshot;

  // 캐시 미스 — 실데이터 fetch
  try {
    const [marketResult, positionsResult, principlesResult] = await Promise.all([
      fetchMarketData(),
      supabase
        .from("positions")
        .select("ticker, weight, is_leverage, sector, pnl, risk_level")
        .eq("user_id", user.id),
      supabase
        .from("principles")
        .select("principle_key, is_on")
        .eq("user_id", user.id),
    ]);

    const positions = positionsResult.data ?? [];
    const principles = principlesResult.data ?? [];
    const riskScores = calculateRiskScores(marketResult);
    const composite = calculateCompositeScore(riskScores);
    const stage = classifyStage(composite);

    const { output: aiOutput, isFallback } = await generateBriefing(
      marketResult,
      riskScores,
      composite,
      positions,
      principles
    );

    const snapshot = {
      user_id: user.id,
      date: targetDate,
      market_data: marketResult,
      risk_scores: riskScores,
      risk_score: composite,
      stage,
      ai_output: aiOutput,
      is_fallback: isFallback,
    };

    const { data: upserted } = await supabase
      .from("briefing_snapshots")
      .upsert(snapshot, { onConflict: "user_id,date" })
      .select("*")
      .maybeSingle();

    return upserted as BriefingSnapshot;
  } catch {
    // 전체 실패 시 전날 스냅샷 fallback
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: fallback } = await supabase
      .from("briefing_snapshots")
      .select("*")
      .eq("user_id", user.id)
      .eq("date", yesterday)
      .maybeSingle();

    if (fallback) {
      await supabase
        .from("briefing_snapshots")
        .upsert(
          { ...fallback, date: targetDate, is_fallback: true },
          { onConflict: "user_id,date" }
        );
      return { ...(fallback as BriefingSnapshot), date: targetDate, is_fallback: true };
    }
    return null;
  }
}
