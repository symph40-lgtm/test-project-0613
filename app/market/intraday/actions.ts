"use server";

import { createClient } from "@/lib/supabase/server";
import { fetchMarketData } from "@/lib/market/fetch";
import {
  calculateRiskScores,
  calculateCompositeScore,
  classifyStage,
  stagePosture,
} from "@/lib/market/risk";
import { getMarketSession } from "@/lib/market/session";
import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";

export type StockCall = {
  ticker: string;
  action: "매수 검토" | "유지" | "축소 검토" | "매도 검토" | "관망";
  reason: string;
};

export type IntradayConsult = {
  generatedAt: string;
  session: string;
  stage: string;
  overall: string;
  calls: StockCall[];
  isFallback: boolean;
};

const SYSTEM = `당신은 개인 투자자를 위한 리스크 코칭 AI입니다.
다음 원칙을 지키십시오:
1. "반드시 매수/매도하세요" 같은 단정 명령 금지. "검토할 수 있습니다" 같은 코칭 표현 사용.
2. 모든 판단에 시장 데이터 근거를 명시.
3. 현재 장 세션(장중/마감후/야간 미국장)을 고려.
출력은 JSON만 반환하고 코드블록이나 다른 텍스트를 포함하지 마십시오.`;

export async function getIntradayConsult(): Promise<IntradayConsult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const session = getMarketSession();

  if (!user) {
    return {
      generatedAt: new Date().toISOString(),
      session: session.label,
      stage: "-",
      overall: "로그인이 필요합니다.",
      calls: [],
      isFallback: true,
    };
  }

  const { data: positions } = await supabase
    .from("positions")
    .select("ticker, weight, is_leverage, sector, risk_level")
    .eq("user_id", user.id)
    .order("weight", { ascending: false });

  const market = await fetchMarketData();
  const riskScores = calculateRiskScores(market);
  const composite = calculateCompositeScore(riskScores);
  const stage = classifyStage(composite);
  const posture = stagePosture(stage);
  const holdings = positions ?? [];

  // 폴백 (AI 키 없음)
  const fallback = (): IntradayConsult => ({
    generatedAt: new Date().toISOString(),
    session: session.label,
    stage,
    overall: `${stage} · 권장 자세 ${posture.stance}. ${posture.guidance}`,
    calls: holdings.map((h) => ({
      ticker: h.ticker,
      action: h.risk_level === "취약" ? "축소 검토" : "유지",
      reason: `비중 ${h.weight}%${h.is_leverage ? " · 레버리지" : ""} · 위험도 ${h.risk_level ?? "—"}`,
    })),
    isFallback: true,
  });

  if (!hasAiKey() || holdings.length === 0) return fallback();

  const prompt = `현재 시점 기준 종목별 매매 컨설팅을 JSON으로 생성하십시오.

## 장 세션
${session.label} — ${session.focus}

## 장세
${stage} / 종합 리스크 ${composite}/100 / 권장 자세 ${posture.stance}(공격성 ${posture.aggressiveness})

## 시장 (당일 등락률)
나스닥 ${market.nasdaq.changePercent?.toFixed(2) ?? "N/A"}% / 반도체SOX ${market.sox.changePercent?.toFixed(2) ?? "N/A"}% / 코스피 ${market.kospi.changePercent?.toFixed(2) ?? "N/A"}% / 달러원 ${market.usdkrw.changePercent?.toFixed(2) ?? "N/A"}% / 유가 ${market.oil.changePercent?.toFixed(2) ?? "N/A"}% / 미국채10Y ${market.treasury10y.price ?? "N/A"}%

## 보유 종목
${holdings.map((h) => `- ${h.ticker} 비중${h.weight}% ${h.is_leverage ? "[레버리지]" : ""} 섹터:${h.sector ?? "기타"} 위험도:${h.risk_level ?? "-"}`).join("\n")}

다음 JSON 형식으로만 응답하십시오:
{
  "overall": "현재 세션·장세 종합 한두 문장 (지금 무엇을 해야 하는지)",
  "calls": [
    {"ticker": "종목명", "action": "매수 검토|유지|축소 검토|매도 검토|관망", "reason": "근거 한 문장 (시장 데이터 기반)"}
  ]
}`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const parsed = parseJsonLoose<{ overall: string; calls: StockCall[] }>(text);
    return {
      generatedAt: new Date().toISOString(),
      session: session.label,
      stage,
      overall: parsed.overall,
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
      isFallback: false,
    };
  } catch {
    return fallback();
  }
}
