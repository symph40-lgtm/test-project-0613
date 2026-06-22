"use server";

import YahooFinance from "yahoo-finance2";
import { getYahooSymbol } from "@/lib/positions";
import { fetchMarketData } from "@/lib/market/fetch";
import { fetchEarningsFundamentals, type EarningsFundamentals } from "@/lib/market/earnings";
import { fetchBondSignal } from "@/lib/market/bondSignal";
import { assessPoliticalRisk } from "@/lib/ai/political";
import { nextFomcDate } from "@/lib/calendar/fred";
import { toKrCode, fetchKoreanValuation } from "@/lib/market/naver-flow";
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
  // 목표가·지지/저항 (현재가에 가장 가까운 1차·2차 스윙 레벨)
  support: number | null;    // 1차 지지 (현재가 바로 아래)
  support2: number | null;   // 2차 지지
  resistance: number | null; // 1차 저항 (현재가 바로 위)
  resistance2: number | null; // 2차 저항
  upside: number | null;    // 1차 저항까지 여력 %
  downside: number | null;  // 1차 지지까지 하락 여지 %
  // 거래량
  volume: number | null;        // 당일 거래량 (장중이면 누적)
  avgVolume: number | null;     // 20일 일평균
  volumeRatio: number | null;   // 평균 대비 배수 (장중이면 경과 보정 후 종일 환산 기준)
  volumeProjected: boolean;     // 장중 경과 보정 적용 여부
  sessionElapsed: number | null; // 장 경과율 % (장중일 때)
  projectedVolume: number | null; // 종일 환산 예상 거래량
  // 차트 패턴 + 추가 기법
  patterns: string[];       // 골든크로스 등
  macd: { hist: number; state: string } | null;
  bollinger: { pctB: number; state: string } | null;
  history: { date: string; value: number }[];
  // 펀더멘털 (영업이익·ROE·컨센서스·거버넌스 — 미국 종목)
  fundamentals: EarningsFundamentals | null;
  // 매크로 컨텍스트
  politicalScore: number | null;
  politicalSummary: string | null;
  bondHeadline: string | null;
  nextFomc: string | null;
  // AI/규칙 판단
  direction: "단기 상승 우세" | "중립·관망" | "단기 하락 우세";
  confidence: "높음" | "보통" | "낮음";
  valuationText: string;
  fundamentalText: string;   // 영업이익·ROE·컨센서스 해석
  technicalText: string;
  chartText: string;         // 다양한 차트기법 종합
  macroSectorText: string;
  outlookText: string;       // 시장 전망·매크로·정치·채권 종합
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

function ema(arr: number[], n: number): number[] {
  if (arr.length === 0) return [];
  const k = 2 / (n + 1);
  const out: number[] = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

// MACD(12,26,9) — 히스토그램 부호·교차 상태
function macdState(closes: number[]): { hist: number; state: string } | null {
  if (closes.length < 35) return null;
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const signal = ema(macdLine, 9);
  const n = macdLine.length;
  const h = macdLine[n - 1] - signal[n - 1];
  const hPrev = macdLine[n - 2] - signal[n - 2];
  const state =
    h > 0 && hPrev <= 0 ? "골든크로스(상향 전환)"
    : h < 0 && hPrev >= 0 ? "데드크로스(하향 전환)"
    : h > 0 ? "상승 모멘텀"
    : "하락 모멘텀";
  return { hist: Number(h.toFixed(2)), state };
}

// 볼린저밴드(20,2σ) — %B 위치
function bollingerState(closes: number[], n = 20, k = 2): { pctB: number; state: string } | null {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  const mean = slice.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const upper = mean + k * sd;
  const lower = mean - k * sd;
  const price = closes[closes.length - 1];
  const pctB = upper !== lower ? (price - lower) / (upper - lower) : 0.5;
  const state =
    pctB >= 1 ? "상단 돌파(과열)"
    : pctB >= 0.8 ? "상단 근접"
    : pctB <= 0 ? "하단 이탈(과매도)"
    : pctB <= 0.2 ? "하단 근접"
    : "중심권";
  return { pctB: Number((pctB * 100).toFixed(0)), state };
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

// 미 동부 서머타임 여부
function isUsEasternDst(d: Date): boolean {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m < 2 || m > 10) return false;
  if (m > 2 && m < 10) return true;
  const firstSunday = (mon: number) => {
    const f = new Date(Date.UTC(y, mon, 1));
    return 1 + ((7 - f.getUTCDay()) % 7);
  };
  if (m === 2) return d.getUTCDate() >= firstSunday(2) + 7; // 둘째 일요일
  return d.getUTCDate() < firstSunday(10); // 11월 첫째 일요일 전
}

// 장중 경과율(0~1). 장중이 아니면 null. (UTC 기준 거래소 세션)
function sessionElapsedFraction(symbol: string, marketState: string | null): number | null {
  if (marketState !== "REGULAR") return null;
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let start: number, end: number;
  if (/\.(KS|KQ)$/.test(symbol)) {
    start = 0; end = 6 * 60 + 30; // 09:00~15:30 KST = 00:00~06:30 UTC
  } else {
    const dst = isUsEasternDst(now);
    start = dst ? 13 * 60 + 30 : 14 * 60 + 30; // 09:30 ET
    end = dst ? 20 * 60 : 21 * 60;             // 16:00 ET
  }
  if (end <= start) return null;
  const f = (utcMin - start) / (end - start);
  if (f <= 0) return null;
  return Math.min(1, f);
}

// 스윙 고/저점(피벗) 추출 — 좌우 w일보다 높/낮은 지점
function pivots(highs: number[], lows: number[], w = 4): { hi: number[]; lo: number[] } {
  const hi: number[] = [];
  const lo: number[] = [];
  for (let i = w; i < highs.length - w; i++) {
    let isHi = true;
    let isLo = true;
    for (let j = i - w; j <= i + w; j++) {
      if (highs[j] > highs[i]) isHi = false;
      if (lows[j] < lows[i]) isLo = false;
    }
    if (isHi) hi.push(highs[i]);
    if (isLo) lo.push(lows[i]);
  }
  return { hi, lo };
}

// 현재가에 가장 가까운 1차·2차 저항(위)·지지(아래) 산출
function nearestLevels(
  price: number,
  highs: number[],
  lows: number[],
  extra: number[] = [], // 추가 후보(이동평균 등) — MA도 흔한 지지·저항
): { r1: number | null; r2: number | null; s1: number | null; s2: number | null } {
  const recent = 120;
  const { hi, lo } = pivots(highs.slice(-recent), lows.slice(-recent), 4);
  const r2 = (v: number) => Number(v.toFixed(2));
  // 근접(0.5% 이내) 레벨 병합
  const dedupe = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of s) if (!out.length || Math.abs(v - out[out.length - 1]) / v > 0.005) out.push(v);
    return out;
  };
  const resAsc = dedupe([...hi, ...extra].filter((v) => v > price)); // 오름차순 → 가까운 저항부터
  const supDesc = dedupe([...lo, ...extra].filter((v) => v < price)).reverse(); // 내림차순 → 가까운 지지부터

  // 폴백: 피벗이 없으면 최근 20일 고/저
  const h20 = highs.length ? Math.max(...highs.slice(-20)) : null;
  const l20 = lows.length ? Math.min(...lows.slice(-20)) : null;
  const r1 = resAsc[0] ?? (h20 !== null && h20 > price ? h20 : null);
  const s1 = supDesc[0] ?? (l20 !== null && l20 < price ? l20 : null);
  return {
    r1: r1 !== null ? r2(r1) : null,
    r2: resAsc[1] != null ? r2(resAsc[1]) : null,
    s1: s1 !== null ? r2(s1) : null,
    s2: supDesc[1] != null ? r2(supDesc[1]) : null,
  };
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
      support: null, support2: null, resistance: null, resistance2: null, upside: null, downside: null,
      volume: null, avgVolume: null, volumeRatio: null, volumeProjected: false,
      sessionElapsed: null, projectedVolume: null, patterns: [], macd: null, bollinger: null, history: [],
      fundamentals: null, politicalScore: null, politicalSummary: null, bondHeadline: null, nextFomc: null,
      direction: "중립·관망", confidence: "낮음",
      valuationText: "", fundamentalText: "", technicalText: "", chartText: "", macroSectorText: "", outlookText: "", summary: "", risks: "",
      isFallback: true, error: "종목 데이터를 불러오지 못했습니다. 종목명을 확인하거나 자동완성에서 선택해 주세요.",
    };
  }

  const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
  const price = num(q.regularMarketPrice);
  const changePercent = num(q.regularMarketChangePercent);
  let trailingPE = num(q.trailingPE);
  let forwardPE = num(q.forwardPE);
  // 한국 종목(.KS/.KQ)은 Yahoo가 PER을 주지 않으므로 네이버에서 보완
  const krCode = toKrCode(symbol, query);
  if (krCode && (trailingPE === null || forwardPE === null)) {
    const v = await fetchKoreanValuation(krCode);
    if (v) {
      trailingPE = trailingPE ?? v.trailingPE;
      forwardPE = forwardPE ?? v.forwardPE;
    }
  }
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
  const macd = macdState(closes);
  const bollinger = bollingerState(closes);
  const trend1m =
    closes.length >= 21 ? Number((((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100).toFixed(1)) : null;
  let aligned: StockAnalysis["aligned"] = null;
  if (price !== null && ma20 !== null && ma60 !== null) {
    if (price > ma20 && ma20 > ma60) aligned = "정배열";
    else if (price < ma20 && ma20 < ma60) aligned = "역배열";
    else aligned = "혼조";
  }

  // 지지/저항: 현재가에 가장 가까운 1차·2차 스윙 레벨 (절대 최저/최고가 아니라 가까운 변곡점)
  const maLevels = [ma20, ma60, ma200].filter((v): v is number => v !== null);
  const lv = price !== null ? nearestLevels(price, highs, lows, maLevels) : { r1: null, r2: null, s1: null, s2: null };
  const resistance = lv.r1;
  const resistance2 = lv.r2;
  const support = lv.s1;
  const support2 = lv.s2;
  const upside = price !== null && resistance !== null && price > 0 ? Number((((resistance - price) / price) * 100).toFixed(1)) : null;
  const downside = price !== null && support !== null && price > 0 ? Number((((support - price) / price) * 100).toFixed(1)) : null;

  // 거래량: 당일 vs 20일 평균 (장중이면 경과 보정해 종일 환산 후 비교)
  const volume = volumes.length ? volumes[volumes.length - 1] : null;
  // 20일 평균은 '오늘(진행중)'을 제외한 직전 20영업일 기준
  const avgVolume =
    volumes.length >= 21 ? Math.round(volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20) : null;
  const frac = sessionElapsedFraction(symbol, (q.marketState as string) ?? null);
  const volumeProjected = frac !== null && frac < 0.97;
  const sessionElapsed = frac !== null ? Math.round(frac * 100) : null;
  const projectedVolume =
    volumeProjected && volume !== null && frac ? Math.round(volume / frac) : null;
  // 비교 기준: 장중이면 종일 환산치, 아니면 당일 거래량
  const compareVol = projectedVolume ?? volume;
  const volumeRatio = compareVol !== null && avgVolume ? Number((compareVol / avgVolume).toFixed(2)) : null;

  // 차트 패턴
  const patterns = detectPatterns(closes, price, rsi14, weekRangePos);

  // 종합 분석용 데이터 병렬 수집: 매크로·VIX·펀더멘털·채권시그널·정치리스크
  const market = await fetchMarketData();
  const [realVix, fundamentals, bond, political] = await Promise.all([
    yf.quote("^VIX").then((qq) => qq.regularMarketPrice ?? null).catch(() => null),
    fetchEarningsFundamentals(symbol).catch(() => null),
    fetchBondSignal().catch(() => null),
    assessPoliticalRisk(market).catch(() => null),
  ]);
  const riskScores = calculateRiskScores(market);
  const composite = calculateCompositeScore(riskScores);
  const stage = classifyStage(composite);
  const nextFomc = nextFomcDate();
  const politicalScore = political?.score ?? null;
  const politicalSummary = political?.summary ?? null;
  const bondHeadline = bond ? `${bond.stanceLabel} · ${bond.summary}` : null;

  const base = {
    name, symbol, price, changePercent, currency,
    trailingPE, forwardPE, weekRangePos,
    ma20: ma20 !== null ? Number(ma20.toFixed(2)) : null,
    ma60: ma60 !== null ? Number(ma60.toFixed(2)) : null,
    ma200: ma200 !== null ? Number(ma200.toFixed(2)) : null,
    rsi14, trend1m, aligned,
    support, support2, resistance, resistance2, upside, downside,
    volume, avgVolume, volumeRatio, volumeProjected, sessionElapsed, projectedVolume, patterns,
    macd, bollinger, history,
    fundamentals, politicalScore, politicalSummary, bondHeadline, nextFomc,
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
      fundamentalText: fundamentals ? `ROE ${fundamentals.roe != null ? (fundamentals.roe * 100).toFixed(1) + "%" : "N/A"} · 영업이익률 ${fundamentals.opMargin != null ? (fundamentals.opMargin * 100).toFixed(1) + "%" : "N/A"} · 투자의견 ${fundamentals.recKey ?? "N/A"}` : "펀더멘털 데이터 없음(미국 종목만 제공).",
      technicalText: `이동평균 ${aligned ?? "N/A"} · RSI ${rsi14 ?? "N/A"} · 추세 ${trend1m ?? "N/A"}% · ${patterns.join(", ") || "특이 패턴 없음"}`,
      chartText: `MACD ${macd?.state ?? "N/A"} · 볼린저 ${bollinger?.state ?? "N/A"}(%B ${bollinger?.pctB ?? "N/A"})`,
      macroSectorText: `현재 장세 ${stage}(리스크 ${composite}) · 반도체 SOX ${market.sox.changePercent?.toFixed(1) ?? "N/A"}%`,
      outlookText: `${bondHeadline ?? ""}${politicalSummary ? " · 정치/지정학: " + politicalSummary : ""}`,
      summary: `저항 ${resistance ?? "N/A"}(여력 ${upside ?? "N/A"}%) · 지지 ${support ?? "N/A"}(하락여지 ${downside ?? "N/A"}%). AI 분석 미사용 — 신호 기반 추정입니다.`,
      risks: "단기 변동성·뉴스 이벤트에 따라 방향이 바뀔 수 있습니다.",
      isFallback: true,
    };
  };

  if (!hasAiKey()) return ruleBased();

  const f = fundamentals;
  const pct1 = (v: number | null | undefined) => (v == null ? "N/A" : `${(v * 100).toFixed(1)}%`);
  const fundBlock = f
    ? `- 예상 매출(컨센서스) ${f.revenueEst != null ? "$" + (f.revenueEst / 1e9).toFixed(1) + "B" : "N/A"} · 추정 영업이익 ${f.opIncomeEst != null ? "$" + (f.opIncomeEst / 1e9).toFixed(1) + "B" : "N/A"}(영업이익률 ${pct1(f.opMargin)})
- ROE ${pct1(f.roe)} · 예상 EPS ${f.epsEst != null ? f.epsEst.toFixed(2) : "N/A"} · PBR ${f.pbr?.toFixed(1) ?? "N/A"} · PEG ${f.peg?.toFixed(2) ?? "N/A"}
- 투자의견 컨센서스 ${f.recKey ?? "N/A"}(${f.recMean?.toFixed(2) ?? "?"}/5, 애널 ${f.analysts ?? "?"}명) · 목표주가 대비 현재가 ${f.vsTargetPct != null ? (f.vsTargetPct >= 0 ? "+" : "") + f.vsTargetPct.toFixed(0) + "%" : "N/A"}
- 거버넌스 리스크(1=양호~10=위험): 종합 ${f.gov.overall ?? "N/A"}`
    : "- (해외 종목이 아니라 펀더멘털 데이터 없음)";

  const prompt = `다음 종목을 '여러 각도에서 종합적·포괄적으로' 분석해 단기(수일~수주) 매매 참고 결론을 JSON으로 도출하십시오. 한 가지 지표(모멘텀·이평)에만 의존하지 말고, 펀더멘털·기술적 여러 기법·매크로·금리/FOMC·정치/지정학·섹터를 모두 교차 검토하십시오.

## 종목
${name} (${symbol}) · 현재가 ${price ?? "N/A"} (${changePercent?.toFixed(2) ?? "N/A"}%)

## 밸류에이션·펀더멘털
- PER 후행 ${trailingPE?.toFixed(1) ?? "N/A"} / 선행 ${forwardPE?.toFixed(1) ?? "N/A"} · 52주 내 위치 ${weekRangePos ?? "N/A"}%
${fundBlock}

## 기술적 (여러 기법)
- 이동평균 배열: ${aligned ?? "N/A"} (현재가/20일 ${base.ma20 ?? "?"}/60일 ${base.ma60 ?? "?"}/200일 ${base.ma200 ?? "?"})
- RSI(14): ${rsi14 ?? "N/A"} · MACD: ${macd?.state ?? "N/A"}(히스토 ${macd?.hist ?? "?"}) · 볼린저밴드 %B ${bollinger?.pctB ?? "N/A"}(${bollinger?.state ?? "N/A"})
- 최근 1개월 추세 ${trend1m ?? "N/A"}% · 거래량 20일평균 대비 ${volumeRatio ?? "N/A"}배 · 패턴 ${patterns.join(", ") || "없음"}
- 1·2차 저항 ${resistance ?? "N/A"}/${resistance2 ?? "N/A"} · 1·2차 지지 ${support ?? "N/A"}/${support2 ?? "N/A"}

## 매크로·금리·FOMC·정치·섹터
- 시장 장세 ${stage}(종합 리스크 ${composite}/100) · 나스닥 ${market.nasdaq.changePercent?.toFixed(2) ?? "N/A"}% · 반도체 SOX ${market.sox.changePercent?.toFixed(2) ?? "N/A"}%${market.sox.sourceNote ? `(${market.sox.sourceNote})` : ""}
- 미국채 10Y ${market.treasury10y.price ?? "N/A"}% · VIX ${realVix?.toFixed(1) ?? "N/A"} · 유가 ${market.oil.changePercent?.toFixed(1) ?? "N/A"}% · 원/달러 ${market.usdkrw.changePercent?.toFixed(2) ?? "N/A"}%
- 채권·금리 시그널: ${bondHeadline ?? "N/A"}
- 다음 FOMC: ${nextFomc ?? "N/A"}
- 정치·지정학 리스크 ${politicalScore ?? "N/A"}/100${politicalSummary ? " — " + politicalSummary : ""}

규칙: 단정·투자권유 금지("반드시","매수하세요" X), "~가능성/~우세" 추정 표현. 각 해석에 위 데이터 근거를 구체적으로 인용. 종목 성격(섹터·해외/국내)에 맞게 어떤 요인이 더 중요한지 가중해 판단.

다음 JSON으로만 응답:
{
  "direction": "단기 상승 우세 | 중립·관망 | 단기 하락 우세",
  "confidence": "높음 | 보통 | 낮음",
  "valuationText": "밸류에이션 해석 1~2문장",
  "fundamentalText": "펀더멘털 해석 — 영업이익·ROE·컨센서스·목표주가·거버넌스 근거 1~2문장",
  "technicalText": "이평·RSI·추세 해석 1~2문장",
  "chartText": "MACD·볼린저·거래량·지지저항 등 여러 차트기법 종합 1~2문장",
  "macroSectorText": "매크로·섹터·금리·FOMC 영향 1~2문장",
  "outlookText": "정치/지정학·채권이동·시장 전망이 이 종목에 주는 함의 1~2문장",
  "summary": "위 모든 각도를 종합한 단기 매매 참고 결론 2~3문장 (어떤 요인이 결정적인지 명시)",
  "risks": "핵심 리스크·반증 시나리오 1~2문장"
}`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1600,
      system: "당신은 한국 개인 투자자를 위한 베테랑 주식 애널리스트입니다. 밸류에이션·펀더멘털·여러 기술적 기법·매크로·금리/FOMC·정치/지정학·섹터를 교차 검토해 종합적·분석적으로 단기 방향을 추정하되, 단정/투자권유 없이 코칭 언어로 답합니다. 데이터에 없는 수치를 지어내지 마십시오. JSON만 반환합니다.",
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const p = parseJsonLoose<{
      direction: StockAnalysis["direction"]; confidence: StockAnalysis["confidence"];
      valuationText: string; fundamentalText: string; technicalText: string; chartText: string;
      macroSectorText: string; outlookText: string; summary: string; risks: string;
    }>(text);
    return {
      ...base,
      direction: p.direction ?? "중립·관망",
      confidence: p.confidence ?? "보통",
      valuationText: p.valuationText ?? "",
      fundamentalText: p.fundamentalText ?? "",
      technicalText: p.technicalText ?? "",
      chartText: p.chartText ?? "",
      macroSectorText: p.macroSectorText ?? "",
      outlookText: p.outlookText ?? "",
      summary: p.summary ?? "",
      risks: p.risks ?? "",
      isFallback: false,
    };
  } catch {
    return ruleBased();
  }
}
