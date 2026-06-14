"use server";

import { createClient } from "@/lib/supabase/server";
import { getAiClient, hasAiKey } from "@/lib/ai/client";
import { getPersonalizationSettings } from "../insights/actions";

export type MisjudgmentLog = {
  id: string;
  date: string;
  ticker: string | null;
  guidance_action: string;
  guidance_prohibition: string;
  actual_action: string;
  follow_level: string;
  result_day1: number | null;
  stage: string | null;
  briefing_snapshot_id: string | null;
};

export type MisjudgmentReport = {
  verdict: string;
  result: string;
  basisThen: string[];
  changed: string[];
  cause: string;
  nextApply: string;
};

export type MisjudgmentData = {
  log: MisjudgmentLog;
  report: MisjudgmentReport;
} | null;

export async function getMisjudgmentData(): Promise<MisjudgmentData> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const settings = await getPersonalizationSettings();

  // follow_level='따르지 않음' + result_day1 < 0, excluded 제외, 최신 1건
  const { data: logs } = await supabase
    .from("action_logs")
    .select("id, date, ticker, guidance_action, guidance_prohibition, actual_action, follow_level, result_day1, stage, briefing_snapshot_id")
    .eq("user_id", user.id)
    .eq("follow_level", "따르지 않음")
    .lt("result_day1", 0)
    .order("created_at", { ascending: false });

  const candidates = (logs ?? []).filter(
    (r) => !settings.excludedLogIds.includes(r.id)
  );

  if (candidates.length === 0) return null;

  const log = candidates[0] as MisjudgmentLog;

  // briefing_snapshot 조회 (있으면)
  let snapshotContext: { dos?: string[]; donts?: string[]; coreIssues?: string[] } | null = null;
  if (log.briefing_snapshot_id) {
    const { data: snap } = await supabase
      .from("briefing_snapshots")
      .select("ai_output")
      .eq("id", log.briefing_snapshot_id)
      .maybeSingle();
    snapshotContext = snap?.ai_output ?? null;
  }

  const report = await generateReport(log, snapshotContext);
  return { log, report };
}

async function generateReport(
  log: MisjudgmentLog,
  snapshot: { dos?: string[]; donts?: string[]; coreIssues?: string[] } | null
): Promise<MisjudgmentReport> {
  const resultText = log.result_day1 != null
    ? `다음날 ${log.result_day1 > 0 ? "+" : ""}${log.result_day1}%`
    : "결과 미기록";

  const fallback: MisjudgmentReport = {
    verdict: log.guidance_action || "방어적 대응 권장",
    result: `실제 행동: ${log.actual_action} → ${resultText}`,
    basisThen: [
      log.guidance_action ? `안내: ${log.guidance_action}` : "안내 내용 없음",
      log.stage ? `장세: ${log.stage}` : "",
    ].filter(Boolean),
    changed: [
      `안내를 따르지 않고 ${log.actual_action}하여 손실이 발생했습니다.`,
      "시장 조건이 안내 방향으로 움직였을 수 있습니다.",
    ],
    cause: `안내를 '따르지 않음'으로 ${log.actual_action}을 선택했고, 이후 손실(${resultText})이 발생했습니다.`,
    nextApply: "다음 유사 상황에서 안내를 따르는 비중을 높여보는 것이 도움이 될 수 있습니다.",
  };

  if (!hasAiKey()) return fallback;

  try {
    const client = getAiClient();
    const context = snapshot
      ? `당시 브리핑 dos: ${(snapshot.dos ?? []).join(", ")} / donts: ${(snapshot.donts ?? []).join(", ")} / 핵심 이슈: ${(snapshot.coreIssues ?? []).join(", ")}`
      : "브리핑 데이터 없음";

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      system: `당신은 투자자의 오판을 분석하는 코칭 AI입니다. 투자 명령 없이 코칭 언어로 분석하십시오. 반드시 JSON만 반환하십시오.`,
      messages: [{
        role: "user",
        content: `다음 오판 사례를 분석해 JSON으로 반환하십시오.

날짜: ${log.date}
종목: ${log.ticker ?? "전체 포지션"}
장세: ${log.stage ?? "알 수 없음"}
안내 행동: ${log.guidance_action}
안내 금지: ${log.guidance_prohibition}
실제 행동: ${log.actual_action}
따름 여부: ${log.follow_level}
다음날 결과: ${resultText}
${context}

반환 형식:
{
  "verdict": "당시 스탁가드 판단 요약 (1문장)",
  "result": "실제 결과 요약 (1문장)",
  "basisThen": ["판단 당시 근거 1", "근거 2"],
  "changed": ["이후 바뀐 변수 1", "변수 2"],
  "cause": "오판 원인 요약 (1~2문장)",
  "nextApply": "다음 판단에 반영할 점 (1~2문장)"
}`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    return JSON.parse(text) as MisjudgmentReport;
  } catch {
    return fallback;
  }
}

export async function excludeLog(logId: string): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: existing } = await supabase
    .from("personalization_settings")
    .select("excluded_log_ids")
    .eq("user_id", user.id)
    .maybeSingle();

  const currentIds: string[] = existing?.excluded_log_ids ?? [];
  if (currentIds.includes(logId)) return;

  await supabase.from("personalization_settings").upsert({
    user_id: user.id,
    excluded_log_ids: [...currentIds, logId],
  });
}
