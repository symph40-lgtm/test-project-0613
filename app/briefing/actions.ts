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

  // 시세·위험점수는 항상 최신으로 — 캐시는 (비싼) AI 텍스트에만 적용한다.
  // 과거에는 스냅샷 전체를 1시간 재사용해 주요 지표가 최대 1시간 stale했음.
  try {
    const marketResult = await fetchMarketData();
    const riskScores = calculateRiskScores(marketResult);
    const composite = calculateCompositeScore(riskScores);
    const stage = classifyStage(composite);

    // AI 텍스트 캐시 히트 확인 (1시간 TTL) — 폴백 스냅샷은 재사용하지 않음
    const { data: cached } = await supabase
      .from("briefing_snapshots")
      .select("*")
      .eq("user_id", user.id)
      .eq("date", targetDate)
      .eq("is_fallback", false)
      .gte("updated_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .maybeSingle();

    // AI 출력만 재사용하고 시세·위험점수·단계는 방금 조회한 최신값으로 덮어쓴다
    if (cached?.ai_output) {
      return {
        ...(cached as BriefingSnapshot),
        market_data: marketResult,
        risk_scores: riskScores,
        risk_score: composite,
        stage,
      };
    }

    // 캐시 미스 — AI 생성에 필요한 포지션·원칙 조회
    const [positionsResult, principlesResult] = await Promise.all([
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
