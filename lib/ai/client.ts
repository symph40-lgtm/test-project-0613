import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function getAiClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export function hasAiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Claude가 JSON을 ```json ... ``` 코드블록이나 부가 텍스트로 감싸 보내는 경우가 많아,
// 코드펜스를 제거하고 첫 { ~ 마지막 } 구간을 추출해 파싱한다.
export function parseJsonLoose<T>(raw: string): T {
  let text = raw.trim();

  // ```json ... ``` 또는 ``` ... ``` 코드펜스 제거
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) text = fence[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    // 객체 구간만 추출 재시도
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
      return JSON.parse(text.slice(first, last + 1)) as T;
    }
    throw new Error("JSON 파싱 실패");
  }
}
