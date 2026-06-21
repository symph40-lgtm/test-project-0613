"use server";

import { createClient } from "@/lib/supabase/server";
import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";
import { askOpenAi, hasOpenAiKey, openAiModel } from "@/lib/ai/openai";
import { clampStance, type AnswerStance, type Stance7 } from "@/lib/market/stance";

// 양쪽 AI에 공통으로 주는 '전문가/애널리스트' 시스템 프롬프트.
// 이 앱의 안전 원칙(투자권유 금지·단정 금지·코칭 언어·불확실성 명시)을 그대로 유지한다.
const EXPERT_SYSTEM = `당신은 한국 개인 투자자를 돕는 베테랑 주식 애널리스트입니다.
거시경제·산업 업황·기업 펀더멘털·수급·기술적 분석을 종합해 전문가 수준으로 깊이 있게 답합니다.
반드시 지킬 규칙:
1. 투자 권유·매수/매도 직접 명령 금지. "검토해볼 수 있습니다", "~가능성이 있습니다" 등 가능성·코칭 표현을 사용한다.
2. 단정 금지. 강세 시나리오와 약세 시나리오, 핵심 리스크를 함께 제시한다.
3. 최신 실적·가격·날짜 등 모르는 수치는 추측해 지어내지 말고 "직접 확인이 필요합니다"라고 명시한다.
4. 논리적 근거를 제시하고, 답변 끝에 '핵심 리스크'와 '직접 확인할 것'을 짧게 정리한다.
5. 한국어로 명확하게 답한다.`;

export type ExpertAnswers = {
  id: string | null;
  question: string;
  claude: { text: string; model: string } | null;
  openai: { text: string; model: string } | null;
  claudeError: string | null;
  openaiError: string | null;
  createdAt: string;
};

const errMsg = (e: unknown) =>
  String((e as { message?: string })?.message ?? e).slice(0, 160);

export async function askExperts(question: string): Promise<ExpertAnswers> {
  const q = question.trim();
  const createdAt = new Date().toISOString();
  if (!q) {
    return { id: null, question: q, claude: null, openai: null, claudeError: "질문을 입력하세요.", openaiError: "질문을 입력하세요.", createdAt };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 보유 종목이 있으면 맞춤 컨텍스트로 첨부 (없으면 일반 질문)
  let context = "";
  if (user) {
    const { data: positions } = await supabase
      .from("positions")
      .select("ticker, weight, sector")
      .eq("user_id", user.id)
      .order("weight", { ascending: false })
      .limit(15);
    if (positions && positions.length > 0) {
      context = `\n\n[참고: 질문자의 보유 종목] ${positions
        .map((p) => `${p.ticker}(${p.weight}%${p.sector ? `·${p.sector}` : ""})`)
        .join(", ")}`;
    }
  }
  const userMsg = `${q}${context}`;
  const claudeModel = "claude-sonnet-4-6";

  const [claudeRes, openaiRes] = await Promise.allSettled([
    hasAiKey()
      ? (async () => {
          const client = getAiClient();
          const m = await client.messages.create({
            model: claudeModel,
            max_tokens: 1200,
            system: EXPERT_SYSTEM,
            messages: [{ role: "user", content: userMsg }],
          });
          return m.content[0].type === "text" ? m.content[0].text : "";
        })()
      : Promise.reject(new Error("ANTHROPIC_API_KEY 미설정")),
    hasOpenAiKey()
      ? askOpenAi(EXPERT_SYSTEM, userMsg, { maxTokens: 1200 })
      : Promise.reject(new Error("OPENAI_API_KEY 미설정 — 설정 후 ChatGPT 답변이 표시됩니다.")),
  ]);

  const claude = claudeRes.status === "fulfilled" && claudeRes.value ? { text: claudeRes.value, model: claudeModel } : null;
  const claudeError = claudeRes.status === "rejected" ? errMsg(claudeRes.reason) : null;
  const openai = openaiRes.status === "fulfilled" && openaiRes.value ? { text: openaiRes.value, model: openAiModel() } : null;
  const openaiError = openaiRes.status === "rejected" ? errMsg(openaiRes.reason) : null;

  // 하나라도 답이 있으면 저장
  let id: string | null = null;
  if (user && (claude || openai)) {
    const { data } = await supabase
      .from("ai_consults")
      .insert({
        user_id: user.id,
        question: q,
        claude_answer: claude?.text ?? null,
        openai_answer: openai?.text ?? null,
        claude_model: claude?.model ?? null,
        openai_model: openai?.model ?? null,
      })
      .select("id")
      .single();
    id = data?.id ?? null;
  }

  return { id, question: q, claude, openai, claudeError, openaiError, createdAt };
}

export type ConsultRow = {
  id: string;
  question: string;
  claude_answer: string | null;
  openai_answer: string | null;
  claude_model: string | null;
  openai_model: string | null;
  reflect: boolean;
  stance: AnswerStance | null;
  created_at: string;
};

export async function getConsultHistory(limit = 20): Promise<ConsultRow[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("ai_consults")
    .select("id, question, claude_answer, openai_answer, claude_model, openai_model, reflect, stance, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!error) return (data ?? []) as ConsultRow[];

  // stance 컬럼(마이그레이션 012) 미적용 시 폴백 — 목록은 계속 보이게
  const { data: legacy } = await supabase
    .from("ai_consults")
    .select("id, question, claude_answer, openai_answer, claude_model, openai_model, reflect, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (legacy ?? []).map((r) => ({ ...r, stance: null })) as ConsultRow[];
}

// 저장된 Q&A 답변을 10단계 매매·위험도 스탠스로 구조화 (애널리스트 레이팅 형식)
const STANCE_SYSTEM = `당신은 주식 애널리스트입니다. 주어진 질문과 답변을 바탕으로 매매 스탠스를 10단계 레이팅으로 정리합니다.
스탠스 10단계(클수록 매수 우호): 10=적극매수, 9=매수, 8=분할매수, 7=비중확대, 6=중립(매수우위), 5=중립(매도우위), 4=비중축소, 3=분할매도, 2=매도, 1=적극매도.
규칙:
- 이것은 '명령'이 아니라 '신호 등급'입니다. 답변에 담긴 근거를 벗어나 과장하지 마십시오.
- 근거가 약하거나 양방향이면 5~6(중립)에 가깝게 보수적으로 매기십시오.
- 답변에 특정 종목이 거론되면 tickers에 종목별 스탠스를 넣고, 없으면 빈 배열로 둡니다.
- 추측으로 수치를 지어내지 마십시오. JSON만 반환합니다.`;

export async function generateStance(consultId: string): Promise<AnswerStance | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !hasAiKey()) return null;

  const { data: row } = await supabase
    .from("ai_consults")
    .select("question, claude_answer, openai_answer")
    .eq("id", consultId)
    .eq("user_id", user.id)
    .single();
  if (!row) return null;

  const answer = ((row.claude_answer as string | null) || (row.openai_answer as string | null) || "").slice(0, 3000);
  if (!answer) return null;

  const prompt = `## 질문\n${row.question}\n\n## 답변\n${answer}\n\n다음 JSON 형식으로만 응답하십시오:
{
  "overall": {
    "stance": 1~10 정수,
    "risk": "낮음|보통|높음",
    "summary": "한 줄 요지",
    "bull": ["강세 요인", "..."],
    "bear": ["약세 요인", "..."],
    "risks": ["핵심 리스크", "..."]
  },
  "tickers": [{ "ticker": "종목명/티커", "stance": 1~10, "reason": "근거 1문장" }]
}`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: STANCE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const parsed = parseJsonLoose<AnswerStance>(text);

    // 스탠스 값 안전 클램프
    const rawRisk = String(parsed.overall?.risk ?? "보통");
    const risk: AnswerStance["overall"]["risk"] = rawRisk === "낮음" || rawRisk === "높음" ? rawRisk : "보통";
    const stance: AnswerStance = {
      overall: {
        stance: clampStance(Number(parsed.overall?.stance ?? 5)),
        risk,
        summary: String(parsed.overall?.summary ?? "").slice(0, 200),
        bull: (parsed.overall?.bull ?? []).slice(0, 5).map((s) => String(s).slice(0, 120)),
        bear: (parsed.overall?.bear ?? []).slice(0, 5).map((s) => String(s).slice(0, 120)),
        risks: (parsed.overall?.risks ?? []).slice(0, 5).map((s) => String(s).slice(0, 120)),
      },
      tickers: (parsed.tickers ?? []).slice(0, 10).map((t) => ({
        ticker: String(t.ticker ?? "").slice(0, 40),
        stance: clampStance(Number(t.stance ?? 5)) as Stance7,
        reason: String(t.reason ?? "").slice(0, 150),
      })),
    };

    await supabase.from("ai_consults").update({ stance }).eq("id", consultId).eq("user_id", user.id);
    return stance;
  } catch {
    return null;
  }
}

export async function setReflect(id: string, on: boolean): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase
    .from("ai_consults")
    .update({ reflect: on })
    .eq("id", id)
    .eq("user_id", user.id);
  return !error;
}

export async function deleteConsult(id: string): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase.from("ai_consults").delete().eq("id", id).eq("user_id", user.id);
  return !error;
}
