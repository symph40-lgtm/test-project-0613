"use server";

import { createClient } from "@/lib/supabase/server";

export type SimilarCaseData = {
  id: string;
  date: string;
  ticker: string | null;
  stage: string | null;
  guidance_action: string;
  guidance_prohibition: string;
  actual_action: string;
  follow_level: string;
  result_day1: number | null;
  overlaps: string[];
};

export async function getSimilarCase(): Promise<SimilarCaseData | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const today = new Date().toISOString().slice(0, 10);

  // 현재 최신 briefing stage 조회
  const { data: latestSnap } = await supabase
    .from("briefing_snapshots")
    .select("stage")
    .eq("user_id", user.id)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentStage = latestSnap?.stage ?? null;
  const stagePrefix = currentStage ? currentStage.slice(0, 2) : null;

  // 현재 positions ticker 목록 조회
  const { data: positions } = await supabase
    .from("positions")
    .select("ticker")
    .eq("user_id", user.id);

  const currentTickers = (positions ?? []).map((p: { ticker: string }) => p.ticker);

  // 과거 기록에서 유사 상황 매칭
  const { data: logs } = await supabase
    .from("action_logs")
    .select("id, date, ticker, stage, guidance_action, guidance_prohibition, actual_action, follow_level, result_day1")
    .eq("user_id", user.id)
    .neq("date", today)
    .order("created_at", { ascending: false });

  if (!logs || logs.length === 0) return null;

  // stage 대분류 2글자로 매칭 + ticker 매칭 점수 계산
  type LogRow = {
    id: string;
    date: string;
    ticker: string | null;
    stage: string | null;
    guidance_action: string;
    guidance_prohibition: string;
    actual_action: string;
    follow_level: string;
    result_day1: number | null;
  };

  let best: (LogRow & { score: number }) | null = null;

  for (const log of logs as LogRow[]) {
    let score = 0;
    const overlaps: string[] = [];

    if (stagePrefix && log.stage && log.stage.startsWith(stagePrefix)) {
      score += 2;
      overlaps.push(`장세 유사 (${stagePrefix})`);
    }

    if (log.ticker && currentTickers.includes(log.ticker)) {
      score += 3;
      overlaps.push(`보유 종목 (${log.ticker})`);
    }

    if (log.result_day1 != null) score += 1;

    if (score > 0 && (!best || score > best.score)) {
      best = { ...log, score };
    }
  }

  if (!best) return null;

  // overlaps 재계산 (best 기준)
  const overlaps: string[] = [];
  if (stagePrefix && best.stage && best.stage.startsWith(stagePrefix)) {
    overlaps.push(`장세 유사 (${stagePrefix})`);
  }
  if (best.ticker && currentTickers.includes(best.ticker)) {
    overlaps.push(`보유 종목 (${best.ticker})`);
  }
  if (currentStage) overlaps.push(`현재 장세: ${currentStage}`);

  return {
    id: best.id,
    date: best.date,
    ticker: best.ticker,
    stage: best.stage,
    guidance_action: best.guidance_action,
    guidance_prohibition: best.guidance_prohibition,
    actual_action: best.actual_action,
    follow_level: best.follow_level,
    result_day1: best.result_day1,
    overlaps,
  };
}
