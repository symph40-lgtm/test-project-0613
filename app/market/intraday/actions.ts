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
import { fetchMarketNews, type NewsItem } from "@/lib/news/fetch";
import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";

export type MarketExplain = {
  generatedAt: string;
  moves: string;          // 핵심 등락 요약
  magnitude: "급변" | "보통" | "안정";
  driver: string;         // 가장 가능성 높은 원인
  nature: "수급·포지션성" | "매크로·이벤트성" | "혼재";
  natureReason: string;   // 그렇게 본 근거
  whatNext: string;       // 앞으로 지켜볼 것
  action: string;         // 대응
  headlines: { title: string; source: string; link: string }[];
  isFallback: boolean;
};

const EXPLAIN_SYSTEM = `당신은 한국 개인 투자자를 위한 실시간 시황 해설가입니다.
교차자산 신호(지수·금리·유가·환율·VIX)와 뉴스 헤드라인을 근거로 급등락의 원인을 추정합니다.
규칙:
1. 단정 금지("반드시", "확실히"). "~로 보입니다", "~가능성" 등 추정 표현 사용.
2. 원인을 '수급·포지션성'(일시적 매물/수급)인지 '매크로·이벤트성'(금리·지표·정책·뉴스)인지 구분해 제시.
3. 모든 판단에 위 신호/뉴스 근거를 명시. 근거 없으면 "단정 어렵다"고 말할 것.
4. 출력은 JSON만. 코드블록 금지.`;

export async function getMarketExplain(): Promise<MarketExplain> {
  const market = await fetchMarketData();
  const news = await fetchMarketNews(6);

  const pct = (v: number | null) => (v === null ? "N/A" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
  const nasdaq = market.nasdaq.changePercent;
  const sox = market.sox.changePercent;
  const kospi = market.kospi.changePercent;
  const moves = `나스닥 ${pct(nasdaq)} · 반도체SOX ${pct(sox)} · 코스피 ${pct(kospi)}`;

  // 급변 판정 (지수 ±1.5% 이상 또는 VIX 급등)
  const maxMove = Math.max(Math.abs(nasdaq ?? 0), Math.abs(sox ?? 0), Math.abs(kospi ?? 0));
  const vixSpike = (market.vix.changePercent ?? 0) > 8;
  const magnitude: MarketExplain["magnitude"] =
    maxMove >= 1.5 || vixSpike ? "급변" : maxMove >= 0.7 ? "보통" : "안정";

  const headlines = news.map((n: NewsItem) => ({ title: n.title, source: n.source, link: n.link }));

  const fallback = (): MarketExplain => {
    const rateUp = (market.treasury10y.changePercent ?? 0) > 0;
    const oilSpike = Math.abs(market.oil.changePercent ?? 0) > 3;
    let driver = "뚜렷한 단일 원인을 특정하기 어렵습니다.";
    let nature: MarketExplain["nature"] = "수급·포지션성";
    if (vixSpike) { driver = "변동성(VIX) 급등 — 위험회피 심리 확대."; nature = "매크로·이벤트성"; }
    else if (rateUp && (nasdaq ?? 0) < 0) { driver = "미국 금리 상승이 기술주에 부담을 준 것으로 보입니다."; nature = "매크로·이벤트성"; }
    else if (oilSpike) { driver = "유가 급변에 따른 인플레이션·경기 민감 반응 가능."; nature = "매크로·이벤트성"; }
    return {
      generatedAt: new Date().toISOString(),
      moves, magnitude, driver, nature,
      natureReason: "AI 분석 미사용 — 교차자산 신호 기반 추정입니다.",
      whatNext: "VIX, 미국 금리, 다음 경제지표 발표를 함께 확인하세요.",
      action: magnitude === "급변" ? "급변 구간에서는 추격 매매를 자제하고 관망이 안전합니다." : "원칙 기반 대응을 유지하세요.",
      headlines,
      isFallback: true,
    };
  };

  if (!hasAiKey()) return fallback();

  const prompt = `지금 시장이 다음과 같이 움직였습니다. 원인과 대응을 JSON으로 해설하십시오.

## 교차자산 신호 (당일 등락률)
- 나스닥100: ${pct(nasdaq)}
- 반도체 SOX: ${pct(sox)}
- 코스피: ${pct(kospi)}
- 미국채 10년물 금리: ${market.treasury10y.price ?? "N/A"}% (${pct(market.treasury10y.changePercent)})
- WTI 유가: ${pct(market.oil.changePercent)}
- 달러/원: ${pct(market.usdkrw.changePercent)}
- VIX(변동성): ${market.vix.price?.toFixed(1) ?? "N/A"} (${pct(market.vix.changePercent)})

## 최신 뉴스 헤드라인
${headlines.map((h, i) => `${i + 1}. ${h.title} (${h.source})`).join("\n") || "(수집된 헤드라인 없음)"}

다음 JSON으로만 응답:
{
  "driver": "가장 가능성 높은 원인 1~2문장 (뉴스/신호 근거 명시)",
  "nature": "수급·포지션성 | 매크로·이벤트성 | 혼재",
  "natureReason": "그렇게 본 근거 1문장",
  "whatNext": "앞으로 지켜볼 것 1~2문장 (어떤 지표/이벤트가 방향을 가를지)",
  "action": "개인 투자자 대응 1~2문장 (코칭 표현, 명령 금지)"
}`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 800,
      system: EXPLAIN_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const p = parseJsonLoose<{
      driver: string; nature: MarketExplain["nature"]; natureReason: string; whatNext: string; action: string;
    }>(text);
    return {
      generatedAt: new Date().toISOString(),
      moves, magnitude,
      driver: p.driver,
      nature: p.nature ?? "혼재",
      natureReason: p.natureReason ?? "",
      whatNext: p.whatNext ?? "",
      action: p.action ?? "",
      headlines,
      isFallback: false,
    };
  } catch {
    return fallback();
  }
}

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
