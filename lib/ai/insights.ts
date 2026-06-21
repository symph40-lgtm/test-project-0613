import { createClient } from "@/lib/supabase/server";
import { stanceToBias, type AnswerStance, type Stance7 } from "@/lib/market/stance";

export type ReflectInsight = { question: string; answer: string; created_at: string };

// reflect=true로 저장된 전문가 Q&A를 최근순으로 가져와, 시황 해설 프롬프트에 참고로 주입한다.
// 답변은 Claude 우선, 없으면 OpenAI를 사용하고 길이를 잘라 프롬프트 비용을 제한한다.
export async function fetchReflectInsights(limit = 4): Promise<ReflectInsight[]> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("ai_consults")
      .select("question, claude_answer, openai_answer, created_at")
      .eq("user_id", user.id)
      .eq("reflect", true)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? [])
      .map((r) => ({
        question: r.question as string,
        answer: ((r.claude_answer as string | null) || (r.openai_answer as string | null) || "").slice(0, 600),
        created_at: r.created_at as string,
      }))
      .filter((r) => r.answer.length > 0);
  } catch {
    return [];
  }
}

// 매매 엔진에 반영할 'AI 스탠스 바이어스' — reflect=true & stance 있는 최신 1건.
// 시장 전반 바이어스 + 종목별 바이어스를 ±2로 한정해 반환한다.
export type AiStanceBias = {
  marketBias: number;                 // 전체 보유에 적용 (-2..+2)
  marketStance: Stance7;
  summary: string;
  tickerBias: Record<string, number>; // 종목명/티커 → 바이어스 (-2..+2)
};

export async function fetchAiStanceBias(): Promise<AiStanceBias | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase
      .from("ai_consults")
      .select("stance, created_at")
      .eq("user_id", user.id)
      .eq("reflect", true)
      .not("stance", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const stance = (data?.[0]?.stance ?? null) as AnswerStance | null;
    if (!stance?.overall) return null;
    const tickerBias: Record<string, number> = {};
    for (const t of stance.tickers ?? []) {
      if (t.ticker) tickerBias[t.ticker] = stanceToBias(t.stance);
    }
    return {
      marketBias: stanceToBias(stance.overall.stance),
      marketStance: stance.overall.stance,
      summary: stance.overall.summary ?? "",
      tickerBias,
    };
  } catch {
    return null;
  }
}

// 프롬프트에 넣을 텍스트 블록으로 직렬화 (없으면 빈 문자열)
export function formatInsightsForPrompt(insights: ReflectInsight[]): string {
  if (insights.length === 0) return "";
  const body = insights
    .map((it, i) => `${i + 1}. (질문) ${it.question}\n   (요지) ${it.answer.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
  return `\n\n## 참고: 사용자가 수집한 전문가 Q&A (AI 의견)\n${body}\n주의: 위는 AI가 생성한 의견으로 사실이 아닐 수 있습니다. 실시간 시세·지표와 충돌하면 데이터를 우선하고, 비판적으로 참고만 하십시오.`;
}
