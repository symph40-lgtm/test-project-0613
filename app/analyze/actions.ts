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
  // 목표가·지지/저항
  support: number | null;   // 최근 저점(지지선)
  resistance: number | null; // 최근 고점(저항선)
  upside: number | null;    // 저항까지 여력 %
  downside: number | null;  // 지지까지 하락 여지 %
  // 거래량
  volume: number | null;
  avgVolume: number | null;
  volumeRatio: number | null; // 평균 대비 배수
  // 차트 패턴
  patterns: string[];       // 골든크로스 등
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

// 특정 시점(끝에서 back번째)의 N일 이동평균
function smaAt(arr: number[], n: number, back = 0): number | null {
  const end = arr.length - back;
  if (end < n) return null;
  const s = arr.slice(end - n, end);
  return s.reduce((a, b) => a + b, 0) / n;
}

// 차트 패턴 감지 (골든/데드크로스, 52주 고점·저점 근접, 과매수/과매도)
function detectPatterns(
  closes: number[],
  price: number | null,
  rsi14: number | null,
  weekRangePos: number | null,
): string[] {
  const out: string[] = [];
  const ma5now = smaAt(closes, 5, 0), ma20now = smaAt(closes, 20, 0);
  const ma5prev = smaAt(closes, 5, 3), ma20prev = smaAt(closes, 20, 3);
  if (ma5now !== null && ma20now !== null && ma5prev !== null && ma20prev !== null) {
    if (ma5prev <= ma20prev && ma5now > ma20now) out.push("골든크로스(단기 5·20일선 상향 돌파)");
    if (ma5prev >= ma20prev && ma5now < ma20now) out.push("데드크로스(단기 5·20일선 하향 이탈)");
  }
  // 60/120(중기) 크로스
  const ma60now = smaAt(closes, 60, 0), ma120now = smaAt(closes, 120, 0);
  const ma60prev = smaAt(closes, 60, 5), ma120prev = smaAt(closes, 120, 5);
  if (ma60now !== null && ma120now !== null && ma60prev !== null && ma120prev !== null) {
    if (ma60prev <= ma120prev && ma60now > ma120now) out.push("중기 골든크로스(60·120일선)");
    if (ma60prev >= ma120prev && ma60now < ma120now) out.push("중기 데드크로스(60·120일선)");
  }
  if (rsi14 !== null) {
    if (rsi14 >= 70) out.push("RSI 과매수(단기 조정 주의)");
    if (rsi14 <= 30) out.push("RSI 과매도(단기 반등 가능)");
  }
  if (weekRangePos !== null) {
    if (weekRangePos >= 95) out.push("52주 신고가 근접");
    if (weekRangePos <= 5) out.push("52주 신저가 근접");
  }
  return out;
}

export async function analyzeStock(query: string, knownSymbol?: string | null): Promise<StockAnalysis | null> {
  const symbol = (knownSymbol?.trim() || getYahooSymbol(query) || query.trim()).toUpperCase();
  if (!symbol) return null;

  let q: Record<string, unknown>;
  let closes: number[] = [];
  let highs: number[] = [];
  let lows: number[] = [];
  let volumes: number[] = [];
  let history: { date: string; value: number }[] = [];
  try {
    q = (await yf.quote(symbol)) as Record<string, unknown>;
    const c = await yf.chart(symbol, { period1: new Date(Date.now() - 150 * 24 * 3600 * 1000), interval: "1d" });
    const pts = (c.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
    closes = pts.map((p) => p.close);
    highs = pts.map((p) => (typeof p.high === "number" ? p.high : p.close));
    lows = pts.map((p) => (typeof p.low === "number" ? p.low : p.close));
    volumes = pts.map((p) => (typeof p.volume === "number" ? p.volume : 0));
    history = pts.slice(-40).map((p) => ({
      date: (p.date instanceof Date ? p.date : new Date(p.date)).toISOString().slice(0, 10),
      value: Number(p.close.toFixed(2)),
    }));
  } catch {
    return {
      name: query, symbol, price: null, changePercent: null, currency: null,
      trailingPE: null, forwardPE: null, weekRangePos: null,
      ma20: null, ma60: null, ma200: null, rsi14: null, trend1m: null, aligned: null,
      support: null, resistance: null, upside: null, downside: null,
      volume: null, avgVolume: null, volumeRatio: null, patterns: [], history: [],
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

  // 지지/저항: 최근 60거래일 고점·저점
  const recentHigh = highs.length ? Math.max(...highs.slice(-60)) : null;
  const recentLow = lows.length ? Math.min(...lows.slice(-60)) : null;
  const resistance = recentHigh !== null ? Number(recentHigh.toFixed(2)) : null;
  const support = recentLow !== null ? Number(recentLow.toFixed(2)) : null;
  const upside = price !== null && resistance !== null && price > 0 ? Number((((resistance - price) / price) * 100).toFixed(1)) : null;
  const downside = price !== null && support !== null && price > 0 ? Number((((support - price) / price) * 100).toFixed(1)) : null;

  // 거래량: 당일 vs 20일 평균
  const volume = volumes.length ? volumes[volumes.length - 1] : null;
  const avgVolume = volumes.length >= 20 ? Math.round(volumes.slice(-20).reduce((a, b) => a + b, 0) / 20) : null;
  const volumeRatio = volume !== null && avgVolume ? Number((volume / avgVolume).toFixed(2)) : null;

  // 차트 패턴
  const patterns = detectPatterns(closes, price, rsi14, weekRangePos);

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
    rsi14, trend1m, aligned,
    support, resistance, upside, downside,
    volume, avgVolume, volumeRatio, patterns,
    history,
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
    if (patterns.some((p) => p.includes("골든크로스"))) score += 1;
    if (patterns.some((p) => p.includes("데드크로스"))) score -= 1;
    if ((volumeRatio ?? 0) >= 2 && (changePercent ?? 0) > 0) score += 1; // 대량 거래 + 상승
    if ((volumeRatio ?? 0) >= 2 && (changePercent ?? 0) < 0) score -= 1; // 대량 거래 + 하락
    const direction: StockAnalysis["direction"] = score >= 1 ? "단기 상승 우세" : score <= -1 ? "단기 하락 우세" : "중립·관망";
    return {
      ...base,
      direction,
      confidence: "낮음",
      valuationText: `PER(후행) ${trailingPE?.toFixed(1) ?? "N/A"} · 선행 ${forwardPE?.toFixed(1) ?? "N/A"} · 52주 내 위치 ${weekRangePos ?? "N/A"}%`,
      technicalText: `이동평균 ${aligned ?? "N/A"} · RSI ${rsi14 ?? "N/A"} · 추세 ${trend1m ?? "N/A"}% · ${patterns.join(", ") || "특이 패턴 없음"}`,
      macroSectorText: `현재 장세 ${stage}(리스크 ${composite}) · 반도체 SOX ${market.sox.changePercent?.toFixed(1) ?? "N/A"}%`,
      summary: `저항 ${resistance ?? "N/A"}(여력 ${upside ?? "N/A"}%) · 지지 ${support ?? "N/A"}(하락여지 ${downside ?? "N/A"}%). AI 분석 미사용 — 신호 기반 추정입니다.`,
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
- 감지된 차트 패턴: ${patterns.join(", ") || "특이 패턴 없음"}

## 지지·저항 (최근 60일)
- 저항선(고점) ${resistance ?? "N/A"} → 현재가 대비 상승 여력 ${upside ?? "N/A"}%
- 지지선(저점) ${support ?? "N/A"} → 현재가 대비 하락 여지 ${downside ?? "N/A"}%

## 거래량
- 당일 거래량 ${volume ?? "N/A"} · 20일 평균 대비 ${volumeRatio ?? "N/A"}배

## 매크로·섹터
- 시장 장세: ${stage} (종합 리스크 ${composite}/100)
- 나스닥 ${market.nasdaq.changePercent?.toFixed(2) ?? "N/A"}% · 반도체 SOX ${market.sox.changePercent?.toFixed(2) ?? "N/A"}% · 미국채 10Y ${market.treasury10y.price ?? "N/A"}% · VIX ${market.vix.price?.toFixed(1) ?? "N/A"}

규칙: 단정·명령 금지("반드시", "매수하세요" X), "~가능성/~우세" 등 추정 표현. 모든 판단에 근거 명시.

다음 JSON으로만 응답:
{
  "direction": "단기 상승 우세 | 중립·관망 | 단기 하락 우세",
  "confidence": "높음 | 보통 | 낮음",
  "valuationText": "밸류에이션 해석 1~2문장 (PER·52주 위치 근거)",
  "technicalText": "기술적 해석 1~2문장 (이평·RSI·추세·차트패턴 근거)",
  "macroSectorText": "매크로·섹터 해석 1~2문장",
  "summary": "단기 방향 종합 결론 1~2문장 (지지·저항·거래량 고려)",
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
