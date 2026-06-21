// OpenAI(ChatGPT) 호출 — SDK 없이 REST로 직접 호출(의존성/버전 리스크 회피)
// OPENAI_API_KEY 미설정 시 hasOpenAiKey()=false로 안전하게 비활성.

export function hasOpenAiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

// 사용 모델 — OPENAI_MODEL 환경변수로 교체 가능, 기본은 gpt-4o
export function openAiModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o";
}

export async function askOpenAi(
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: openAiModel(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: opts.maxTokens ?? 900,
      temperature: opts.temperature ?? 0.4,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}
