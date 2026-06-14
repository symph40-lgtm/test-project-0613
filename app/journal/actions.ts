"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type GuidanceData = {
  snapshotId: string | null;
  action: string;
  prohibition: string;
  stage: string | null;
};

export type ActionLogInput = {
  date: string;
  ticker?: string;
  briefing_snapshot_id?: string;
  guidance_action: string;
  guidance_prohibition: string;
  actual_action: "축소" | "유지" | "추가매수" | "전량매도" | "기타";
  follow_level: "따름" | "일부 따름" | "따르지 않음";
  reason?: string;
  result_day0?: number | null;
  result_day1?: number | null;
  result_day3?: number | null;
  result_week1?: number | null;
  stage?: string;
};

export type ActionLogRow = ActionLogInput & {
  id: string;
  user_id: string;
  created_at: string;
};

export async function getTodayGuidance(): Promise<GuidanceData | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from("briefing_snapshots")
    .select("id, stage, ai_output")
    .eq("user_id", user.id)
    .eq("date", today)
    .maybeSingle();

  if (!data) return null;

  const aiOutput = data.ai_output as { dos?: string[]; donts?: string[] } | null;

  return {
    snapshotId: data.id,
    action: aiOutput?.dos?.[0] ?? "",
    prohibition: aiOutput?.donts?.[0] ?? "",
    stage: data.stage,
  };
}

export async function saveActionLog(input: ActionLogInput): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인이 필요합니다.");

  const { error } = await supabase.from("action_logs").insert({
    user_id: user.id,
    date: input.date,
    ticker: input.ticker ?? null,
    briefing_snapshot_id: input.briefing_snapshot_id ?? null,
    guidance_action: input.guidance_action,
    guidance_prohibition: input.guidance_prohibition,
    actual_action: input.actual_action,
    follow_level: input.follow_level,
    reason: input.reason ?? null,
    result_day0: input.result_day0 ?? null,
    result_day1: input.result_day1 ?? null,
    result_day3: input.result_day3 ?? null,
    result_week1: input.result_week1 ?? null,
    stage: input.stage ?? null,
  });

  if (error) throw new Error(error.message);

  redirect("/journal/gap-report");
}

export async function getActionLogs(): Promise<ActionLogRow[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("action_logs")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  return (data ?? []) as ActionLogRow[];
}
