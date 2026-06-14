"use server";

import { createClient } from "@/lib/supabase/server";

export type GapReportData = {
  total: number;
  followed: number;
  partial: number;
  ignored: number;
  winDespiteIgnore: number;
  lossDespiteIgnore: number;
  pattern: string | null;
  isSmallSample: boolean;
};

export async function getGapReport(): Promise<GapReportData> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const empty: GapReportData = {
    total: 0,
    followed: 0,
    partial: 0,
    ignored: 0,
    winDespiteIgnore: 0,
    lossDespiteIgnore: 0,
    pattern: null,
    isSmallSample: true,
  };

  if (!user) return empty;

  const { data: logs } = await supabase
    .from("action_logs")
    .select("follow_level, result_day1, stage")
    .eq("user_id", user.id);

  if (!logs || logs.length === 0) return empty;

  const total = logs.length;
  const followed = logs.filter((r) => r.follow_level === "따름").length;
  const partial = logs.filter((r) => r.follow_level === "일부 따름").length;
  const ignored = logs.filter((r) => r.follow_level === "따르지 않음").length;

  const ignoredRows = logs.filter((r) => r.follow_level === "따르지 않음");
  const winDespiteIgnore = ignoredRows.filter((r) => r.result_day1 != null && r.result_day1 > 0).length;
  const lossDespiteIgnore = ignoredRows.filter((r) => r.result_day1 != null && r.result_day1 < 0).length;

  // 반복 패턴: stage 대분류 + follow_level 조합 가장 많은 것
  const patternMap = new Map<string, number>();
  for (const r of logs) {
    const stagePrefix = r.stage ? r.stage.slice(0, 3) : "알 수 없음";
    const key = `${stagePrefix}|${r.follow_level}`;
    patternMap.set(key, (patternMap.get(key) ?? 0) + 1);
  }
  let topKey: string | null = null;
  let topCount = 0;
  for (const [k, v] of patternMap) {
    if (v > topCount) { topCount = v; topKey = k; }
  }

  let pattern: string | null = null;
  if (topKey && topCount >= 2) {
    const [stagePart, followPart] = topKey.split("|");
    pattern = `${stagePart}에서 안내를 '${followPart}'한 경우가 가장 많습니다 (${topCount}건)`;
  }

  return {
    total,
    followed,
    partial,
    ignored,
    winDespiteIgnore,
    lossDespiteIgnore,
    pattern,
    isSmallSample: total < 5,
  };
}
