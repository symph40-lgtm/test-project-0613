// 보유 종목별 매매 판단 (7단계 스탠스)
// 실데이터(장세 composite, 반도체 SOX, 레버리지, 비중, 위험도) 기반 — 규칙 기반이라 항상 동작.
// 선택적으로 AI Q&A 기반 바이어스(aiBias)를 '한정 폭(±2)'으로만 반영해 환각이 신호를 단독으로 뒤집지 못하게 한다.

import { type Stance7, STANCE7_META, scoreToStance7 } from "./stance";

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
  stance: Stance7;       // 1(적극매도)~10(적극매수)
  tone: "buy" | "hold" | "sell";
  label: string;         // 예: "적극 매수"
  reason: string;        // 보충 설명
  aiNote: string | null; // AI 의견 반영 설명(있을 때)
};

export function recommendForHolding(
  h: HoldingInput,
  ctx: { composite: number; soxChange: number | null; aiBias?: number; aiReason?: string | null },
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

  // 7) AI Q&A 기반 바이어스 — ±2로 한정 반영 (환각이 신호를 단독으로 뒤집지 못하게)
  let aiNote: string | null = null;
  const rawBias = ctx.aiBias ?? 0;
  if (rawBias !== 0) {
    const bias = Math.max(-2, Math.min(2, Math.round(rawBias)));
    score += bias;
    aiNote = `AI 의견 ${bias > 0 ? "+" : ""}${bias}${ctx.aiReason ? ` · ${ctx.aiReason}` : ""}`;
  }

  const stance = scoreToStance7(score);
  const meta = STANCE7_META[stance];

  return {
    ticker: h.ticker,
    stance,
    tone: meta.tone,
    label: meta.label,
    reason: reasons.join(" · "),
    aiNote,
  };
}
