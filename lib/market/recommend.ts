// 보유 종목별 매매 판단 (매수/보유/매도 + 3단계 강도)
// 실데이터(장세 composite, 반도체 SOX, 레버리지, 비중, 위험도) 기반 — 규칙 기반이라 항상 동작

export type HoldingInput = {
  ticker: string;
  weight: number;
  is_leverage: boolean;
  sector: string | null;
  risk_level: string | null;
  changePercent?: number | null; // 종목 당일 등락(있으면)
};

export type Recommendation = {
  ticker: string;
  direction: "매수" | "보유" | "매도";
  level: number;        // 1~3 (보유는 0)
  label: string;        // 예: "매수 2단계 · 매수 검토"
  reason: string;       // 보충 설명
};

const BUY_LABEL: Record<number, string> = {
  1: "분할 매수 검토",
  2: "매수 검토",
  3: "적극 매수 검토",
};
const SELL_LABEL: Record<number, string> = {
  1: "비중 축소 검토",
  2: "매도 검토",
  3: "적극 매도·현금화 검토",
};

export function recommendForHolding(
  h: HoldingInput,
  ctx: { composite: number; soxChange: number | null },
): Recommendation {
  const reasons: string[] = [];
  let score = 0; // 양수=매수, 음수=매도

  // 1) 장세(종합 리스크) — 낮을수록 상승 우호
  const c = ctx.composite;
  if (c <= 17) { score += 2; reasons.push(`상승장(리스크 ${c}) 우호적`); }
  else if (c <= 26) { score += 1; reasons.push(`상승장 후기(리스크 ${c})`); }
  else if (c <= 44) { reasons.push(`변동장(리스크 ${c}) 중립`); }
  else if (c <= 53) { score -= 1; reasons.push(`변동장 후기(리스크 ${c}) 경계`); }
  else if (c <= 65) { score -= 2; reasons.push(`하락장(리스크 ${c}) 방어`); }
  else { score -= 3; reasons.push(`하락장 심화(리스크 ${c})`); }

  // 2) 반도체 섹터 ↔ SOX
  const isSemi = (h.sector ?? "").includes("반도체");
  if (isSemi && ctx.soxChange !== null) {
    if (ctx.soxChange > 1.5) { score += 1; reasons.push(`반도체 강세(SOX +${ctx.soxChange.toFixed(1)}%)`); }
    else if (ctx.soxChange < -1.5) { score -= 1; reasons.push(`반도체 약세(SOX ${ctx.soxChange.toFixed(1)}%)`); }
  }

  // 3) 레버리지 — 하락 신호일 때 위험 가중
  if (h.is_leverage && score < 0) { score -= 1; reasons.push("레버리지(변동성 증폭)"); }

  // 4) 위험도
  if (h.risk_level === "취약") { score -= 1; reasons.push("위험도 취약"); }

  // 5) 고비중 + 하락 신호 → 축소
  if (h.weight >= 30 && score < 0) { score -= 1; reasons.push(`고비중 ${h.weight}%`); }

  // 6) 종목 당일 급등 시 일부 차익 관점 (과열)
  if ((h.changePercent ?? 0) > 8 && score > 0) { score -= 1; reasons.push(`당일 급등 +${h.changePercent?.toFixed(1)}%(과열 주의)`); }

  // 점수 → 방향/단계
  let direction: Recommendation["direction"];
  let level = 0;
  if (score >= 1) {
    direction = "매수";
    level = Math.min(3, score);
  } else if (score <= -1) {
    direction = "매도";
    level = Math.min(3, -score);
  } else {
    direction = "보유";
    level = 0;
  }

  const label =
    direction === "보유"
      ? "보유 유지"
      : `${direction} ${level}단계 · ${(direction === "매수" ? BUY_LABEL : SELL_LABEL)[level]}`;

  return {
    ticker: h.ticker,
    direction,
    level,
    label,
    reason: reasons.join(" · "),
  };
}
