import type { MarketData, RiskScores, AiBriefingOutput, AiPrecloseOutput } from "../market/types";
import { classifyStage } from "../market/risk";
import { getAiClient, hasAiKey } from "./client";

// FR-029 리스크 코칭 언어 시스템 프롬프트
const SYSTEM_PROMPT = `당신은 개인 투자자를 위한 리스크 코칭 AI입니다.
다음 5가지 원칙을 반드시 지켜 답변하십시오:
1. 투자 명령 금지: "매수하세요", "팔아야 합니다" 같은 직접 명령은 절대 사용하지 않는다.
2. 단언 금지: "반드시", "확실히" 같은 단언 표현을 쓰지 않는다.
3. 대조 관점 제시: 강세·약세 양측 시나리오를 모두 언급한다.
4. 리스크 근거 중심: 모든 판단에 시장 데이터 근거를 명시한다.
5. 코칭 언어: "검토해볼 수 있습니다", "주의가 필요할 수 있습니다" 등 가능성·권유 표현을 사용한다.

출력은 반드시 JSON만 반환하고, 코드 블록(\`\`\`)이나 다른 텍스트를 포함하지 마십시오.`;

function makeFallbackBriefing(scores: RiskScores, composite: number): AiBriefingOutput {
  const stage = classifyStage(composite);
  const isHighRisk = composite >= 54;
  return {
    verdict: isHighRisk
      ? "리스크 지표가 높습니다. 방어적 관점 검토가 필요할 수 있습니다."
      : "시장 변동성이 있습니다. 원칙 기반 대응을 유지하는 것이 도움이 될 수 있습니다.",
    stage,
    dos: isHighRisk
      ? ["레버리지 비중 축소 검토", "현금 비중 유지", "원칙 재확인"]
      : ["포지션 현황 점검", "리스크 라인 확인"],
    donts: ["충동적 추가 매수 자제", "손실 만회 목적 대출 자제"],
    buffett:
      "좋은 기업을 공정한 가격에 사는 것이 훌륭한 기업을 비싼 가격에 사는 것보다 낫습니다. 시장 변동은 인내심 있는 투자자에게 기회가 될 수 있습니다.",
    coreIssues: ["금리 변동성", "반도체 섹터 흐름", "환율 동향"].slice(
      0,
      isHighRisk ? 3 : 2
    ),
    supplyNotes: ["실시간 수급 데이터를 가져오지 못했습니다."],
    pressureLevel: Math.min(1, composite / 80),
    situationLevel: Math.min(1, composite / 80),
    issuesDuration: [{ issue: "시장 변동성", duration: "며칠" }],
  };
}

function makeFallbackPreclose(positions: { ticker: string }[]): AiPrecloseOutput {
  return {
    todaySummary:
      "AI 분석을 사용할 수 없어 일반 가이드를 표시합니다. (ANTHROPIC_API_KEY 설정 및 서버 재시작 필요)",
    nightEvents: [
      { event: "미국 CPI·고용지표·FOMC 등 주요 경제지표 발표 여부 확인 권장", expectedTime: "22:30 전후" },
      { event: "연준 위원 발언·국채 입찰 모니터링 권장", expectedTime: "야간" },
    ],
    perStockCalls: positions.map((p) => ({
      ticker: p.ticker,
      call: "현황 유지 (AI 분석 비활성)",
    })),
    scenarios: [
      { result: "야간 미국 지표(CPI/고용 등) 예상 상회", impact: "금리 상승 → 기술주·레버리지 부담 확대 가능" },
      { result: "야간 미국 지표 예상 부합", impact: "기존 장세 흐름 유지 가능" },
      { result: "야간 미국 지표 예상 하회", impact: "경기 둔화 우려로 위험자산 단기 변동 가능" },
    ],
  };
}

export async function generateBriefing(
  market: MarketData,
  riskScores: RiskScores,
  composite: number,
  positions: { ticker: string; weight: number; is_leverage: boolean; sector: string | null; risk_level: string }[],
  principles: { principle_key: string; is_on: boolean }[]
): Promise<{ output: AiBriefingOutput; isFallback: boolean }> {
  if (!hasAiKey()) {
    return { output: makeFallbackBriefing(riskScores, composite), isFallback: true };
  }

  const stage = classifyStage(composite);
  const activePrinciples = principles
    .filter((p) => p.is_on)
    .map((p) => p.principle_key)
    .join(", ");

  const prompt = `다음 시장 데이터를 분석해 아침 브리핑 JSON을 생성하십시오.

## 장세 판정
- 현재 단계: ${stage}
- 종합 리스크 점수: ${composite}/100

## 리스크 점수 (0~100)
- 금리 위험: ${riskScores.rate.toFixed(0)}
- 환율 위험: ${riskScores.forex.toFixed(0)}
- 유가 위험: ${riskScores.oil.toFixed(0)}
- 반도체 섹터: ${riskScores.semiconductor.toFixed(0)}
- 수급 위험: ${riskScores.supply.toFixed(0)}
- 채권 이동: ${riskScores.bond.toFixed(0)}

## 시장 데이터
- S&P500: ${market.sp500.price ?? "N/A"} (${market.sp500.changePercent?.toFixed(2) ?? "N/A"}%)
- 나스닥100: ${market.nasdaq.price ?? "N/A"} (${market.nasdaq.changePercent?.toFixed(2) ?? "N/A"}%)
- SOX(반도체): ${market.sox.price ?? "N/A"} (${market.sox.changePercent?.toFixed(2) ?? "N/A"}%)
- 코스피: ${market.kospi.price ?? "N/A"} (${market.kospi.changePercent?.toFixed(2) ?? "N/A"}%)
- 달러/원: ${market.usdkrw.price ?? "N/A"} (${market.usdkrw.changePercent?.toFixed(2) ?? "N/A"}%)
- WTI 유가: ${market.oil.price ?? "N/A"} (${market.oil.changePercent?.toFixed(2) ?? "N/A"}%)
- 미국 10년물 금리: ${market.treasury10y.price ?? "N/A"}% (${market.treasury10y.changePercent?.toFixed(2) ?? "N/A"}%)

## 사용자 포지션
${positions.map((p) => `- ${p.ticker}: 비중 ${p.weight}%, 레버리지 ${p.is_leverage ? "O" : "X"}, 섹터 ${p.sector ?? "기타"}, 리스크 ${p.risk_level}`).join("\n")}

## 활성 원칙
${activePrinciples || "없음"}

다음 JSON 형식으로만 응답하십시오 (다른 텍스트 없이):
{
  "verdict": "한 문장 종합 판단 (명령·단언 없이)",
  "stage": "${stage}",
  "dos": ["해야 할 행동 1", "해야 할 행동 2", "해야 할 행동 3"],
  "donts": ["하지 말아야 할 행동 1", "하지 말아야 할 행동 2"],
  "buffett": "버핏식 원칙 관점 한 문장 (대조 관점 포함)",
  "coreIssues": ["핵심 이슈 1", "핵심 이슈 2"],
  "supplyNotes": ["수급 요약 1", "수급 요약 2"],
  "pressureLevel": 0.0~1.0 사이 숫자,
  "situationLevel": 0.0~1.0 사이 숫자,
  "issuesDuration": [{"issue": "이슈명", "duration": "하루|며칠|이상"}]
}`;

  try {
    const client = getAiClient();
    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const parsed = JSON.parse(text) as AiBriefingOutput;
    return { output: parsed, isFallback: false };
  } catch {
    return { output: makeFallbackBriefing(riskScores, composite), isFallback: true };
  }
}

export async function generatePreclose(
  market: MarketData,
  riskScores: RiskScores,
  composite: number,
  positions: { ticker: string; weight: number; is_leverage: boolean; sector: string | null }[]
): Promise<AiPrecloseOutput> {
  if (!hasAiKey()) {
    return makeFallbackPreclose(positions);
  }

  const stage = classifyStage(composite);
  const today = new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });

  const prompt = `오늘(${today}) 마감 전 투자자 판단 JSON을 생성하십시오.

## 장세
- ${stage} / 리스크 점수 ${composite}/100
- 나스닥 ${market.nasdaq.changePercent?.toFixed(2) ?? "N/A"}% / 금리 ${market.treasury10y.price ?? "N/A"}% (${market.treasury10y.changePercent?.toFixed(2) ?? "N/A"}%)

## 포지션
${positions.map((p) => `- ${p.ticker} 비중${p.weight}% ${p.is_leverage ? "[레버]" : ""} 섹터:${p.sector ?? "기타"}`).join("\n")}

규칙:
- nightEvents의 event에는 구체적 지표명을 명시하십시오 (예: "미국 5월 CPI", "주간 신규 실업수당 청구건수", "FOMC 의사록", "엔비디아 실적").
- scenarios의 result에는 어떤 지표 기준인지 반드시 포함하십시오 (예: "미국 CPI 예상 상회"). 막연히 "상회"라고만 쓰지 마십시오.

다음 JSON 형식으로만 응답하십시오:
{
  "todaySummary": "오늘 장 흐름 한 줄 요약",
  "nightEvents": [{"event": "구체적 지표/이벤트명", "expectedTime": "예상 시각(한국시간)"}],
  "perStockCalls": [{"ticker": "티커", "call": "유지 가능|축소 검토|매도 검토|현금화 검토"}],
  "scenarios": [{"result": "지표명 + 상회/부합/하회", "impact": "예상 영향"}]
}`;

  try {
    const client = getAiClient();
    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const parsed = JSON.parse(text) as AiPrecloseOutput;
    return parsed;
  } catch {
    return makeFallbackPreclose(positions);
  }
}
