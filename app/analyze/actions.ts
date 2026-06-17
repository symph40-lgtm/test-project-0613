"use server";

import YahooFinance from "yahoo-finance2";
import { getYahooSymbol } from "@/lib/positions";
import { fetchMarketData } from "@/lib/market/fetch";
import { calculateRiskScores, calculateCompositeScore, classifyStage } from "@/lib/market/risk";
import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";

const yf = new YahooFinance();

export type StockAnalysis = {
  name: string;
  symbol: string;
  price: number | null;
  changePercent: number | null;
  currency: string | null;
  // 밸류에이션
  trailingPE: number | null;
  forwardPE: number | null;
  weekRangePos: number | null; // 52주 내 위치 0~100%
  // 기술적
  ma20: number | null;
  ma60: number | null;
  ma200: number | null;
  rsi14: number | null;
  trend1m: number | null;   // 최근 1개월 추세 %
  aligned: "정배열" | "역배열" | "혼조" | null; // 이동평균 배열
  history: { date: string; value: number }[];
  // AI/규칙 판단
  direction: "단기 상승 우세" | "중립·관망" | "단기 하락 우세";
  confidence: "높음" | "보통" | "낮음";
  valuationText: string;
  technicalText: string;
  macroSectorText: string;
  summary: string;
  risks: string;
  isFallback: boolean;
  error?: string;
};

function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null;
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

function rsi(arr: number[], period = 14): number | null {
  if (arr.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  const avgGain = gain / period, avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - 100 / (1 + rs));
}

export async function analyzeStock(query: string, knownSymbol?: string | null): Promise<StockAnalysis | null> {
  const symbol = (knownSymbol?.trim() || getYahooSymbol(query) || query.trim()).toUpperCase();
  if (!symbol) return null;

  let q: Record<string, unknown>;
  let closes: number[] = [];
  let history: { date: string; value: number }[] = [];
  try {
    q = (await yf.quote(symbol)) as Record<string, unknown>;
    const c = await yf.chart(symbol, { period1: new Date(Date.now() - 150 * 24 * 3600 * 1000), interval: "1d" });
    const pts = (c.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
    closes = pts.map((p) => p.close);
    history = pts.slice(-40).map((p) => ({
      date: (p.date instanceof Date ? p.date : new Date(p.date)).toISOString().slice(0, 10),
      value: Number(p.close.toFixed(2)),
    }));
  } catch {
    return {
      name: query, symbol, price: null, changePercent: null, currency: null,
      trailingPE: null, forwardPE: null, weekRangePos: null,
      ma20: null, ma60: null, ma200: null, rsi14: null, trend1m: null, aligned: null, history: [],
      direction: "중립·관망", confidence: "낮음",
      valuationText: "", technicalText: "", macroSectorText: "", summary: "", risks: "",
      isFallback: true, error: "종목 데이터를 불러오지 못했습니다. 종목명을 확인하거나 자동완성에서 선택해 주세요.",
    };
  }

  const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
  const price = num(q.regularMarketPrice);
  const changePercent = num(q.regularMarketChangePercent);
  const trailingPE = num(q.trailingPE);
  const forwardPE = num(q.forwardPE);
  const hi = num(q.fiftyTwoWeekHigh), lo = num(q.fiftyTwoWeekLow);
  const weekRangePos =
    price !== null && hi !== null && lo !== null && hi > lo
      ? Math.round(((price - lo) / (hi - lo)) * 100)
      : null;
  const name = (q.shortName as string) || (q.longName as string) || symbol;
  const currency = (q.currency as string) ?? null;

  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma200 = num(q.twoHundredDayAverage) ?? sma(closes, 120);
  const rsi14 = rsi(closes, 14);
  const trend1m =
    closes.length >= 21 ? Number((((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100).toFixed(1)) : null;
  let aligned: StockAnalysis["aligned"] = null;
  if (price !== null && ma20 !== null && ma60 !== null) {
    if (price > ma20 && ma20 > ma60) aligned = "정배열";
    else if (price < ma20 && ma20 < ma60) aligned = "역배열";
    else aligned = "혼조";
  }

  // 매크로
  const market = await fetchMarketData();
  const riskScores = calculateRiskScores(market);
  const composite = calculateCompositeScore(riskScores);
  const stage = classifyStage(composite);

  const base = {
    name, symbol, price, changePercent, currency,
    trailingPE, forwardPE, weekRangePos,
    ma20: ma20 !== null ? Number(ma20.toFixed(2)) : null,
    ma60: ma60 !== null ? Number(ma60.toFixed(2)) : null,
    ma200: ma200 !== null ? Number(ma200.toFixed(2)) : null,
    rsi14, trend1m, aligned, history,
  };

  // 규칙 기반 폴백 판단
  const ruleBased = (): StockAnalysis => {
    let score = 0;
    if (aligned === "정배열") score += 1;
    if (aligned === "역배열") score -= 1;
    if (rsi14 !== null) { if (rsi14 >= 70) score -= 1; if (rsi14 <= 30) score += 1; }
    if ((trend1m ?? 0) > 5) score += 1;
    if ((trend1m ?? 0) < -5) score -= 1;
    if (composite >= 54) score -= 1; // 하락장
    if (composite <= 26) score += 1; // 상승장
    const direction: StockAnalysis["direction"] = score >= 1 ? "단기 상승 우세" : score <= -1 ? "단기 하락 우세" : "중립·관망";
    return {
      ...base,
      direction,
      confidence: "낮음",
      valuationText: `PER(후행) ${trailingPE?.toFixed(1) ?? "N/A"} · 선행 ${forwardPE?.toFixed(1) ?? "N/A"} · 52주 내 위치 ${weekRangePos ?? "N/A"}%`,
      technicalText: `이동평균 ${aligned ?? "N/A"} · RSI ${rsi14 ?? "N/A"} · 1개월 추세 ${trend1m ?? "N/A"}%`,
      macroSectorText: `현재 장세 ${stage}(리스크 ${composite}) · 반도체 SOX ${market.sox.changePercent?.toFixed(1) ?? "N/A"}%`,
      summary: "AI 분석 미사용 — 기술적·매크로 신호 기반 추정입니다.",
      risks: "단기 변동성·뉴스 이벤트에 따라 방향이 바뀔 수 있습니다.",
      isFallback: true,
    };
  };

  if (!hasAiKey()) return ruleBased();

  const prompt = `다음 종목의 단기(수일~수주) 방향을 분석해 JSON으로 답하십시오.

## 종목
${name} (${symbol}) · 현재가 ${price ?? "N/A"} (${changePercent?.toFixed(2) ?? "N/A"}%)

## 밸류에이션
- PER 후행 ${trailingPE?.toFixed(1) ?? "N/A"} / 선행 ${forwardPE?.toFixed(1) ?? "N/A"}
- 52주 범위 내 위치 ${weekRangePos ?? "N/A"}% (0=저점, 100=고점)

## 기술적
- 이동평균 배열: ${aligned ?? "N/A"} (현재가 ${price ?? "?"} / 20일 ${base.ma20 ?? "?"} / 60일 ${base.ma60 ?? "?"} / 200일 ${base.ma200 ?? "?"})
- RSI(14): ${rsi14 ?? "N/A"} (70+ 과매수, 30- 과매도)
- 최근 1개월 추세: ${trend1m ?? "N/A"}%

## 매크로·섹터
- 시장 장세: ${stage} (종합 리스크 ${composite}/100)
- 나스닥 ${market.nasdaq.changePercent?.toFixed(2) ?? "N/A"}% · 반도체 SOX ${market.sox.changePercent?.toFixed(2) ?? "N/A"}% · 미국채 10Y ${market.treasury10y.price ?? "N/A"}% · VIX ${market.vix.price?.toFixed(1) ?? "N/A"}

규칙: 단정·명령 금지("반드시", "매수하세요" X), "~가능성/~우세" 등 추정 표현. 모든 판단에 근거 명시.

다음 JSON으로만 응답:
{
  "direction": "단기 상승 우세 | 중립·관망 | 단기 하락 우세",
  "confidence": "높음 | 보통 | 낮음",
  "valuationText": "밸류에이션 해석 1~2문장 (PER·52주 위치 근거)",
  "technicalText": "기술적 해석 1~2문장 (이평·RSI·추세 근거)",
  "macroSectorText": "매크로·섹터 해석 1~2문장",
  "summary": "단기 방향 종합 결론 1~2문장",
  "risks": "주의할 리스크 1~2문장"
}`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: "당신은 한국 개인 투자자를 위한 주식 분석 AI입니다. 밸류에이션·기술적·매크로를 종합해 단기 방향을 추정하되, 단정/투자권유 없이 코칭 언어로 답합니다. JSON만 반환합니다.",
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const p = parseJsonLoose<{
      direction: StockAnalysis["direction"]; confidence: StockAnalysis["confidence"];
      valuationText: string; technicalText: string; macroSectorText: string; summary: string; risks: string;
    }>(text);
    return {
      ...base,
      direction: p.direction ?? "중립·관망",
      confidence: p.confidence ?? "보통",
      valuationText: p.valuationText ?? "",
      technicalText: p.technicalText ?? "",
      macroSectorText: p.macroSectorText ?? "",
      summary: p.summary ?? "",
      risks: p.risks ?? "",
      isFallback: false,
    };
  } catch {
    return ruleBased();
  }
}
