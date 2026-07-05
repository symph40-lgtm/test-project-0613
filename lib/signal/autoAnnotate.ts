// AI 자동 정성 주석 — 마스터 스펙 8.1의 "원인 주석(수동 입력)"을 자동화.
// 매일 반도체·시장 뉴스와 매크로 스냅샷을 Claude(haiku)에 주고 ①지배 재료 태그 ②원인 주석 1줄
// ③L7(낙폭 원인 비실적 여부) ④L8(이익 컨센서스 유지 여부)을 채운다.
// 원칙: 사용자가 직접 입력한 날(annotation_source='user')은 절대 덮어쓰지 않는다 — 사용자 판단 우선.

import { createAdminClient } from "@/lib/supabase/admin";
import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";
import { fetchSemiSectorNews } from "@/lib/news/fetch";
import { fetchMarketData } from "@/lib/market/fetch";
import { fetchDailyBars } from "./data";
import { SIGNAL_CONFIG } from "./config";

const CAUSE_TAGS = ["전쟁·지정학", "관세·규제", "실적", "수급", "소송", "AI뉴스", "매크로", "기타"];

// 실패 시 60초 폴링마다 Claude를 때리지 않도록 15분 재시도 간격
let lastAttemptMs = 0;
const RETRY_GAP_MS = 15 * 60_000;

type AiAnnotation = {
  cause_tag: string | null;
  cause_note: string | null;
  cause_non_earnings: boolean | null;
  consensus_intact: boolean | null;
  macro_surprise: "easing" | "tightening" | null;
};

export async function autoAnnotateIfNeeded(date: string): Promise<void> {
  if (!hasAiKey()) return;
  if (Date.now() - lastAttemptMs < RETRY_GAP_MS) return;

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("signal_daily_features")
    .select("annotation_source, ai_analyzed_at")
    .eq("date", date)
    .maybeSingle();
  if (row?.annotation_source === "user") return; // 사용자 입력 우선 — AI가 덮어쓰지 않음
  if (row?.ai_analyzed_at) return;               // 오늘 이미 분석함

  lastAttemptMs = Date.now();

  // 재료 수집 — 뉴스 + 매크로 + 전일 등락
  const [news, market, hynixDaily] = await Promise.all([
    fetchSemiSectorNews(["삼성전자", "SK하이닉스"], 12).catch(() => []),
    fetchMarketData().catch(() => null),
    fetchDailyBars(SIGNAL_CONFIG.symbols.hynix, 6).catch(() => []),
  ]);
  if (news.length === 0) return; // 뉴스가 없으면 다음 재시도 창에서 다시

  const prevBars = hynixDaily.slice(-4, -1);
  const moves = prevBars
    .map((b, i, arr) => (i > 0 ? (((b.close - arr[i - 1].close) / arr[i - 1].close) * 100).toFixed(1) + "%" : null))
    .filter(Boolean)
    .join(", ");

  const prompt = `너는 한국 반도체 주식(삼성전자·SK하이닉스) 단기 트레이딩 시스템의 분석 보조다.
오늘(${date})의 시장 상황을 보고, 아래 JSON만 출력해라 (다른 텍스트 금지).

## 최근 뉴스 헤드라인
${news.map((n) => `- ${n.title} (${n.source})`).join("\n")}

## 시장 상황
- 하닉 최근 일별 등락: ${moves || "데이터 없음"}
- 미 10년물 전일: ${market?.treasury10y?.changePercent?.toFixed(2) ?? "?"}% / USD/KRW 전일: ${market?.usdkrw?.changePercent?.toFixed(2) ?? "?"}%
- 나스닥 전일: ${market?.nasdaq?.changePercent?.toFixed(2) ?? "?"}% / SOX 전일: ${market?.sox?.changePercent?.toFixed(2) ?? "?"}%

## 출력 (JSON)
{
  "cause_tag": "${CAUSE_TAGS.join(" | ")}" 중 오늘 주가를 지배하는 재료 하나. 뚜렷한 재료가 없으면 null,
  "cause_note": "오늘의 지배 재료를 한 문장(80자 이내)으로. 예: '메타 AI 임대 뉴스로 하닉 급락, 펀더멘털 무관'. 뚜렷한 재료 없으면 null",
  "cause_non_earnings": 최근 하락이 있다면 그 원인이 실적·펀더멘털 훼손이 아닌 수급·지정학·소송 등 외부 요인인가? true/false. 최근 하락이 없거나 판단 불가면 null,
  "consensus_intact": 뉴스상 증권사 이익 전망(컨센서스)이 유지·상향으로 보이는가? 하향 소식이 있으면 false. 판단할 근거가 없으면 null,
  "macro_surprise": 최근 24시간 내 주요 경제지표(고용·CPI·FOMC 등)가 컨센서스 대비 크게 벗어났는가? 지표 부진·완화적 발언 등 금리인하 방향 서프라이즈면 "easing", 지표 과열·긴축 방향이면 "tightening", 큰 서프라이즈가 없으면 null. (예: NFP 컨센서스 11만인데 실제 5만 = "easing")
}

주의: 확신이 없으면 null을 써라. 추측으로 true/false를 만들지 마라.`;

  try {
    const client = getAiClient();
    const res = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const parsed = parseJsonLoose<AiAnnotation>(text);

    const tag = parsed.cause_tag && CAUSE_TAGS.includes(parsed.cause_tag) ? parsed.cause_tag : null;
    await admin.from("signal_daily_features").upsert(
      {
        date,
        cause_tag: tag,
        cause_note: typeof parsed.cause_note === "string" ? parsed.cause_note.slice(0, 300) : null,
        cause_non_earnings: typeof parsed.cause_non_earnings === "boolean" ? parsed.cause_non_earnings : null,
        consensus_intact: typeof parsed.consensus_intact === "boolean" ? parsed.consensus_intact : null,
        macro_surprise: parsed.macro_surprise === "easing" || parsed.macro_surprise === "tightening" ? parsed.macro_surprise : null,
        annotation_source: "ai",
        ai_analyzed_at: new Date().toISOString(),
      },
      { onConflict: "date" },
    );
  } catch {
    // 실패 — ai_analyzed_at 미기록이므로 15분 후 자동 재시도
  }
}
