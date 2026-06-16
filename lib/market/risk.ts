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

  // 유가:
  // - 급등 = 인플레이션 압력 → 위험 (+6% → 100점)
  // - 완만한 하락 = 인플레이션 완화 → 위험 아님 (~6% 하락까지 0점)
  // - 급락(-6% 초과) = 수요 둔화·경기 침체 신호 → 위험 가산 (-12% → 100점)
  const oilPct = market.oil.changePercent;
  let oil = 50;
  if (oilPct !== null) {
    if (oilPct >= 0) {
      oil = Math.min(100, (oilPct / 6) * 100);
    } else {
      const drop = Math.abs(oilPct);
      oil = drop <= 6 ? 0 : Math.min(100, ((drop - 6) / 6) * 100);
    }
  }

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

export type StagePosture = {
  stance: string;       // 한 단어 자세 (예: 적극, 중립, 방어)
  aggressiveness: number; // 0~100 권장 공격성 (참고용)
  guidance: string;     // 한 줄 코칭 (명령 아님)
};

// 9단계별 권장 자세 — 명령이 아니라 "어느 정도 공격적/방어적 구간인지" 코칭
const STAGE_POSTURE: Record<string, StagePosture> = {
  "상승장 1단계": { stance: "적극", aggressiveness: 90, guidance: "위험 신호가 매우 낮은 구간입니다. 계획된 비중을 적극적으로 채워볼 수 있습니다." },
  "상승장 2단계": { stance: "공격적", aggressiveness: 75, guidance: "상승 우호적 구간입니다. 원칙 범위 안에서 비중 확대를 검토할 수 있으나, 추격 매수는 분할로 접근하는 것이 도움이 됩니다." },
  "상승장 3단계": { stance: "비중 유지~확대", aggressiveness: 60, guidance: "상승 흐름은 유효하나 과열 가능성도 함께 봅니다. 신규 진입은 분할, 기존 수익은 일부 관리할 수 있습니다." },
  "변동장 1단계": { stance: "중립", aggressiveness: 50, guidance: "방향성이 약한 구간입니다. 신규 비중 확대보다 현 포지션 점검이 우선될 수 있습니다." },
  "변동장 2단계": { stance: "신중", aggressiveness: 38, guidance: "변동성이 커지는 구간입니다. 레버리지·추격 매수는 보류하고 현금 여력을 확인하는 것이 도움이 됩니다." },
  "변동장 3단계": { stance: "방어 준비", aggressiveness: 28, guidance: "위험이 누적되는 구간입니다. 취약 종목 비중 축소를 검토할 수 있습니다." },
  "하락장 1단계": { stance: "방어", aggressiveness: 20, guidance: "하방 압력이 우세합니다. 레버리지 축소와 현금 비중 확대를 검토할 수 있습니다." },
  "하락장 2단계": { stance: "강한 방어", aggressiveness: 10, guidance: "하락 위험이 큽니다. 추가 매수보다 손실 관리·현금화 검토가 우선될 수 있습니다." },
  "하락장 3단계": { stance: "최대 방어", aggressiveness: 5, guidance: "위험이 매우 높은 구간입니다. 신규 진입 자제와 방어적 포지션 유지가 권장될 수 있습니다." },
};

export function stagePosture(stage: string): StagePosture {
  return (
    STAGE_POSTURE[stage] ?? {
      stance: "중립",
      aggressiveness: 50,
      guidance: "현재 조건을 점검하며 원칙 기반으로 대응하는 것이 도움이 될 수 있습니다.",
    }
  );
}
