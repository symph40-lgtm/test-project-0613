import type { MarketData, RiskScores } from "./types";

// 가중치 정의 (합계 = 1.0)
const WEIGHTS = {
  rate: 0.25,
  forex: 0.15,
  oil: 0.10,
  semiconductor: 0.30,
  supply: 0.10,
  bond: 0.10,
} as const;

// 변화율(%) → 리스크 점수 0~100 변환 헬퍼
function pctToRisk(pct: number | null, scale: number, direction: "up" | "down"): number | null {
  if (pct === null) return null;
  const signed = direction === "down" ? -pct : pct;
  // signed > 0 이면 위험, scale=% 단위로 100점 도달
  const raw = (signed / scale) * 100;
  return Math.max(0, Math.min(100, raw));
}

export function calculateRiskScores(market: MarketData): RiskScores {
  // 금리: 10Y 금리 당일 변화율. 상승폭 클수록 위험 (2% 상승 → 100점)
  const rate = pctToRisk(market.treasury10y.changePercent, 2, "up") ?? 50;

  // 환율: 달러/원 상승 클수록 위험 (2% 상승 → 100점)
  const forex = pctToRisk(market.usdkrw.changePercent, 2, "up") ?? 50;

  // 유가: 급등 or 급락 모두 위험 신호 (절대값 3% → 100점)
  const oilPct = market.oil.changePercent;
  const oil = oilPct !== null ? Math.min(100, (Math.abs(oilPct) / 3) * 100) : 50;

  // 반도체(SOX): 하락폭 클수록 위험 (3% 하락 → 100점)
  const semiconductor = pctToRisk(market.sox.changePercent, 3, "down") ?? 50;

  // 수급: S&P500 + KOSPI 평균 하락 기준 (2% 하락 → 100점)
  const supplyPcts = [market.sp500.changePercent, market.kospi.changePercent].filter(
    (v): v is number => v !== null
  );
  const supply =
    supplyPcts.length > 0
      ? Math.max(0, Math.min(100, ((-supplyPcts.reduce((a, b) => a + b, 0) / supplyPcts.length) / 2) * 100))
      : 50;

  // 채권 이동(NASDAQ 기준 역상관): 나스닥 하락 + 금리 상승 = 채권 도피 신호
  const nasdaqPct = market.nasdaq.changePercent;
  const ratePct = market.treasury10y.changePercent;
  let bond = 50;
  if (nasdaqPct !== null && ratePct !== null) {
    // 나스닥 하락(-) + 금리 상승(+) 이면 채권 이동 위험 증가
    const bondSignal = -nasdaqPct + ratePct;
    bond = Math.max(0, Math.min(100, (bondSignal / 3) * 100));
  }

  return { rate, forex, oil, semiconductor, supply, bond };
}

export function calculateCompositeScore(scores: RiskScores): number {
  const entries = Object.entries(scores) as [keyof RiskScores, number][];

  let totalWeight = 0;
  let weightedSum = 0;

  for (const [key, score] of entries) {
    const w = WEIGHTS[key];
    weightedSum += score * w;
    totalWeight += w;
  }

  if (totalWeight === 0) return 50;
  return Math.round(weightedSum / totalWeight);
}

// 복합 점수 0~100 → 9단계 문자열
// 상승장 3단계(0~26), 변동장 3단계(27~53), 하락장 3단계(54~80+)
export function classifyStage(composite: number): string {
  if (composite <= 8) return "상승장 1단계";
  if (composite <= 17) return "상승장 2단계";
  if (composite <= 26) return "상승장 3단계";
  if (composite <= 35) return "변동장 1단계";
  if (composite <= 44) return "변동장 2단계";
  if (composite <= 53) return "변동장 3단계";
  if (composite <= 65) return "하락장 1단계";
  if (composite <= 78) return "하락장 2단계";
  return "하락장 3단계";
}
