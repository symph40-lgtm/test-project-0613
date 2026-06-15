"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";

export type PersonalizationSettings = {
  enabled: boolean;
  excludedLogIds: string[];
};

export type InsightsData = {
  strong: string;
  weak: string;
  reinforce: string[];
} | null;

export async function getPersonalizationSettings(): Promise<PersonalizationSettings> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { enabled: true, excludedLogIds: [] };

  const { data } = await supabase
    .from("personalization_settings")
    .select("personalization_enabled, excluded_log_ids")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data) return { enabled: true, excludedLogIds: [] };
  return {
    enabled: data.personalization_enabled,
    excludedLogIds: data.excluded_log_ids ?? [],
  };
}

export async function savePersonalizationSettings(enabled: boolean): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await supabase.from("personalization_settings").upsert({
    user_id: user.id,
    personalization_enabled: enabled,
  });
}

export async function generateInsights(): Promise<InsightsData> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const settings = await getPersonalizationSettings();
  if (!settings.enabled) return null;

  const { data: logs } = await supabase
    .from("action_logs")
    .select("id, follow_level, stage, actual_action, result_day1")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(30);

  const filtered = (logs ?? []).filter(
    (r) => !settings.excludedLogIds.includes(r.id)
  );

  if (filtered.length < 3) {
    return {
      strong: "기록이 더 쌓이면 잘 맞았던 판단을 분석해드립니다.",
      weak: "",
      reinforce: [],
    };
  }

  // Rule-based fallback
  const makeRuleBased = (): InsightsData => {
    const followed = filtered.filter((r) => r.follow_level === "따름");
    const ignored = filtered.filter((r) => r.follow_level === "따르지 않음");
    const followedWin = followed.filter((r) => r.result_day1 != null && r.result_day1 > 0);
    const ignoredLoss = ignored.filter((r) => r.result_day1 != null && r.result_day1 < 0);

    const stageMap = new Map<string, number>();
    for (const r of filtered) {
      if (r.stage) {
        const prefix = r.stage.slice(0, 3);
        stageMap.set(prefix, (stageMap.get(prefix) ?? 0) + 1);
      }
    }
    const topStage = [...stageMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "변동";

    return {
      strong: followed.length > 0
        ? `안내를 따른 ${followed.length}건 중 ${followedWin.length}건이 다음날 수익을 기록했습니다.`
        : "아직 분석할 충분한 데이터가 없습니다.",
      weak: ignored.length > 0
        ? `안내를 따르지 않은 ${ignored.length}건 중 ${ignoredLoss.length}건이 손실로 이어졌습니다.`
        : "",
      reinforce: [
        `${topStage} 장세에서 가장 많은 기록이 쌓였습니다.`,
        ignored.length > followed.length
          ? "안내를 따르지 않는 경향이 있습니다. 다음 위험 상황에서 원칙을 재확인해보세요."
          : "안내를 잘 따르고 있습니다.",
      ].filter(Boolean),
    };
  };

  if (!hasAiKey()) return makeRuleBased();

  try {
    const client = getAiClient();
    const summary = filtered.map((r) =>
      `날짜: ${r.stage ?? "알 수 없음"} / 행동: ${r.actual_action} / 따름: ${r.follow_level} / 다음날 결과: ${r.result_day1 != null ? `${r.result_day1}%` : "미기록"}`
    ).join("\n");

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: `당신은 개인 투자자의 행동 기록을 분석해 인사이트를 제공하는 AI입니다.
투자 명령이나 단언 없이 코칭 언어로 답변하십시오.
반드시 JSON만 반환하고 다른 텍스트를 포함하지 마십시오.`,
      messages: [{
        role: "user",
        content: `다음 행동 기록을 분석해 개인화 인사이트를 JSON으로 반환하십시오.

기록:
${summary}

반환 형식:
{
  "strong": "잘 맞았던 판단 패턴 요약 (1~2문장)",
  "weak": "취약했던 판단 패턴 요약 (1~2문장)",
  "reinforce": ["강화할 조건 1", "강화할 조건 2"]
}`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    return parseJsonLoose<InsightsData>(text);
  } catch {
    return makeRuleBased();
  }
}

export async function deleteAllLogs(): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await supabase.from("action_logs").delete().eq("user_id", user.id);
  await supabase.from("personalization_settings").upsert({
    user_id: user.id,
    excluded_log_ids: [],
  });

  revalidatePath("/journal");
  revalidatePath("/journal/gap-report");
  revalidatePath("/journal/insights");
}
