// 리스크 규칙 R1~R8 + 확장 A1(ATR 연동 스탑) + C1(마감 증폭 — 기록·표시 전용).
// 이 수치들은 학습·확장 모듈이 무효화할 수 없다 (마스터 8.4).

import { SIGNAL_CONFIG } from "../config";
import type { BiasResult, IntradayTick, PremarketContext, RiskResult, TrendResult } from "../types";
import { atr14Pct } from "./daily";

export function computeRisk(
  ctx: PremarketContext,
  bias: BiasResult,
  trend: TrendResult | null,
  ticks: IntradayTick[],
  minuteOfDay: number,
): RiskResult {
  const R = SIGNAL_CONFIG.risk;
  const A = SIGNAL_CONFIG.ext.a1;
  const notes: string[] = [];

  // A1 — ATR14 기반 스탑 (하닉 본주 % × 상품 배수, clamp)
  const atr = atr14Pct(ctx.hynixDaily, true);
  let stopAtr: number | null = null;
  if (atr !== null) {
    const raw = A.k * (atr / 100) * SIGNAL_CONFIG.symbols.leverageMultiple;
    stopAtr = Math.min(A.maxStop, Math.max(A.minStop, raw)) * 100;
  }

  // R2 트레일링 — 약한 추세일은 타이트(-2%)
  const trailPct = trend?.grade === "약한추세" ? R.weakTrailPct : R.trailPct;

  // R5·R7 — Bias 강도 연동 비중 + 분할 진입
  const frac = bias.strength >= 3 ? "최대 비중" : bias.strength === 2 ? "최대 비중의 2/3" : bias.strength === 1 ? "최대 비중의 1/3" : "진입 보류";
  const sizeGuide = `${frac} · 분할 1/3씩(시초 확인→지지 확인→방향 확인)`;

  // 이벤트일 보수 모드 — 비중 절반
  if (ctx.events.some((e) => e.binary)) notes.push("이벤트일 — 비중 절반 또는 관망 (2.5.4)");
  notes.push(`R1 진입 즉시 시세포착 -${R.stopPct}% (트레일링은 이익 방향으로만 이동)`);
  notes.push(`R6 일일 손실 한도 계좌 -${R.dailyLossLimitPct}% — 도달 시 당일 거래 전면 중단 (계좌 미연동, 직접 확인)`);
  if (stopAtr !== null && A.stopMode === "fixed") {
    notes.push(`A1 참고: ATR 기준 권장 스탑 -${stopAtr.toFixed(1)}% (고변동장 노이즈 컷 방지 — 설정 stop_mode=atr 시 적용)`);
  }

  // C1 — 마감 리밸런싱 증폭 (14:50 판정, 기록·표시 전용, 검증 전 활성화 금지)
  const lastTick = ticks[ticks.length - 1];
  const idxMove = lastTick?.futChg ?? null;
  const closeExtendSuggested =
    minuteOfDay >= SIGNAL_CONFIG.session.closeDecideMin &&
    trend?.dc1 !== null && trend !== null && (trend.dc1 ?? 0) >= SIGNAL_CONFIG.ext.c1.dc1Min &&
    idxMove !== null && Math.abs(idxMove) >= SIGNAL_CONFIG.ext.c1.indexMoveMin * 100;
  if (closeExtendSuggested) notes.push("C1(기록): 추세일+지수 ±3% — 15:15 연기 조건 성립 (미검증, 기본 OFF)");

  return {
    stopFixedPct: R.stopPct,
    stopAtrPct: stopAtr,
    atr14Pct: atr,
    stopMode: A.stopMode,
    trailPct,
    sizeGuide,
    biasStrength: bias.strength,
    inverseCapPct: R.inverseMaxPct,
    dailyLossLimitPct: R.dailyLossLimitPct,
    closeExtendSuggested,
    notes,
  };
}
