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
  // SOX가 stale이면 fetchMarketData에서 이미 SOXX(또는 나스닥 선물)로 changePercent를 대체해 둠.
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
  if (!market.nasdaq.stale && nasdaqPct !== null && ratePct !== null) {
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

// 당일 실시간 급락 오버레이 — 미국 밤사이 데이터(SOX·S&P)에 가려지는 '오늘의 하락'을 리스크에 반영.
// composite는 SOX 30%+S&P 등 미국 야간이 지배해, 한국·내 종목이 장중 폭락해도 낮게(상승장) 나오는 문제 보정.
// 가장 많이 빠진 실시간 신호(코스피·코스피선물·나스닥선물·보유평균)를 대표로 비선형 가산한다.
export function intradayDropRisk(opts: {
  kospi?: number | null;
  kospiFut?: number | null;
  nasdaqFut?: number | null;
  holdingsAvg?: number | null;
}): number {
  const vals = [opts.kospi, opts.kospiFut, opts.nasdaqFut, opts.holdingsAvg].filter(
    (v): v is number => typeof v === "number",
  );
  if (vals.length === 0) return 0;
  const worst = Math.min(...vals); // 가장 많이 빠진 값
  if (worst >= -0.3) return 0;     // 약보합 이내면 가산 없음
  const d = -worst;                // 하락폭(양수)
  // -1%→13, -2%→26, -3%→39, -4%→52, 상한 58
  return Math.min(58, Math.round(d * 13));
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
  "상승장 3단계": { stance: "비중 유지·일부 차익", aggressiveness: 55, guidance: "상승 후기·과열 경계 구간입니다. 추격 매수는 자제하고 신규는 분할, 기존 수익은 일부 차익 실현을 검토할 수 있습니다." },
  "변동장 1단계": { stance: "중립", aggressiveness: 50, guidance: "방향성이 약한 구간입니다. 신규 비중 확대보다 현 포지션 점검이 우선될 수 있습니다." },
  "변동장 2단계": { stance: "신중", aggressiveness: 38, guidance: "변동성이 커지는 구간입니다. 레버리지·추격 매수는 보류하고 현금 여력을 확인하는 것이 도움이 됩니다." },
  "변동장 3단계": { stance: "방어 준비", aggressiveness: 28, guidance: "위험이 누적되는 구간입니다. 취약 종목 비중 축소를 검토할 수 있습니다." },
  "하락장 1단계": { stance: "방어", aggressiveness: 20, guidance: "하방 압력이 우세합니다. 레버리지 축소와 현금 비중 확대를 검토할 수 있습니다." },
  "하락장 2단계": { stance: "강한 방어", aggressiveness: 10, guidance: "하락 위험이 큽니다. 추가 매수보다 손실 관리·현금화 검토가 우선될 수 있습니다." },
  "하락장 3단계": { stance: "최대 방어", aggressiveness: 5, guidance: "위험이 매우 높은 구간입니다. 신규 진입 자제와 방어적 포지션 유지가 권장될 수 있습니다." },
};

// 각 단계 한마디 요약 (한 단어 액션 + 톤) — 표/배지용
export type StageAction = { word: string; tone: "buy" | "hold" | "sell" };
const STAGE_ACTION: Record<string, StageAction> = {
  "상승장 1단계": { word: "적극 매수", tone: "buy" },
  "상승장 2단계": { word: "매수", tone: "buy" },
  "상승장 3단계": { word: "차익·관리", tone: "hold" }, // 상승 후기·과열 경계 → 매수 아님
  "변동장 1단계": { word: "유지", tone: "hold" },
  "변동장 2단계": { word: "주의", tone: "hold" },
  "변동장 3단계": { word: "경계", tone: "sell" },
  "하락장 1단계": { word: "방어", tone: "sell" },
  "하락장 2단계": { word: "축소·현금화", tone: "sell" },
  "하락장 3단계": { word: "위험·최대 방어", tone: "sell" },
};
export function stageAction(stage: string): StageAction {
  return STAGE_ACTION[stage] ?? { word: "유지", tone: "hold" };
}

export function stagePosture(stage: string, composite?: number): StagePosture {
  const base =
    STAGE_POSTURE[stage] ?? {
      stance: "중립",
      aggressiveness: 50,
      guidance: "현재 조건을 점검하며 원칙 기반으로 대응하는 것이 도움이 될 수 있습니다.",
    };
  // composite가 주어지면 단계 기본 공격성과 연속값(100-composite)을 블렌딩 — 리스크 오르면 공격성↓.
  // 단계 기본값을 반영해 '하락 구간인데 공격성만 높게' 나오는 모순을 방지한다.
  if (typeof composite === "number") {
    const cont = Math.max(0, Math.min(100, 100 - composite));
    const aggressiveness = Math.round(base.aggressiveness * 0.5 + cont * 0.5);
    return { ...base, aggressiveness };
  }
  return base;
}
