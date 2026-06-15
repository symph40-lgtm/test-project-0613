import { NextResponse } from "next/server";

// AI 키가 실행 중인 서버에 실제로 로드됐는지 확인하는 진단 엔드포인트
// 브라우저에서 http://localhost:3000/api/debug/ai 접속
export async function GET() {
  // 진단용 — 운영 환경에서는 비활성
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  const hasKey = Boolean(key);

  if (!hasKey) {
    return NextResponse.json({
      hasAnthropicKey: false,
      message:
        "실행 중인 서버가 ANTHROPIC_API_KEY를 읽지 못했습니다. .env.local에 키를 넣고 서버를 완전히 종료(Ctrl+C) 후 npm run dev로 재시작하세요.",
    });
  }

  // 실제로 호출되는지 가벼운 핑 (5토큰)
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    return NextResponse.json({
      hasAnthropicKey: true,
      keyPreview: `${key!.slice(0, 12)}…`,
      apiStatus: res.status,
      apiOk: res.ok,
      message: res.ok
        ? "정상입니다. AI 분석이 작동해야 합니다. 브리핑 스냅샷이 캐시돼 있으면 삭제 후 새로고침하세요."
        : "키는 있으나 API 호출이 실패했습니다. 키 유효성/잔액을 확인하세요.",
    });
  } catch (e) {
    return NextResponse.json({
      hasAnthropicKey: true,
      apiOk: false,
      error: e instanceof Error ? e.message : "unknown",
    });
  }
}
