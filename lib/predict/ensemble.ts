// 앙상블 — 모델별 리프트(우연 대비 초과 정확도)를 가중치로 한 최종 판정. 스펙 1.2·1.3절.
// 2026-07-16 개정: 정확도 → 리프트 가중. 엣지 없는 모델(리프트 ≤0)은 가중치 0으로 자동 침묵 —
// 90일 실측에서 균등가중 앙상블이 세 종목 모두 피셔 단독보다 낮았던 희석 문제의 해법.

import { PREDICT_CONFIG } from "./config";
import type { AccuracyStat, EnsembleResult, ModelId, ModelOutput, Verdict } from "./types";
import { MODEL_IDS } from "./types";

// 표본이 적을 때 1/3(3분류 우연 수준)로 수렴하는 평활 정확도
export function smoothedAccuracy(stat: AccuracyStat | undefined): number {
  const c = stat?.correct ?? 0;
  const t = stat?.total ?? 0;
  return (c + 1) / (t + 3);
}

// 우연 기준선: 모델의 판정 분포 × 라벨 분포 내적 — "그 비율로 아무렇게나 질렀어도 맞을 확률"
export function chanceBaseline(stat: AccuracyStat | undefined): number {
  const t = stat?.total ?? 0;
  if (!stat || t === 0) return 1 / 3;
  return (["leverage", "inverse", "none"] as Verdict[]).reduce(
    (s, v) => s + (stat.verdicts[v] / t) * (stat.labels[v] / t),
    0,
  );
}

// 리프트 가중치 — 우연보다 나은 만큼만 발언권. 음수(우연 이하)는 0
export function liftWeight(stat: AccuracyStat | undefined): number {
  return Math.max(smoothedAccuracy(stat) - chanceBaseline(stat), 0);
}

// 최종 판정 확정 — 피셔 단독 모드(기본)면 피셔의 판정·신뢰도가 그대로 최종.
// 앙상블은 참고 지표로 계속 산출·기록된다 (피셔 고장 감지·타 모델 복귀 근거).
export function finalizeJudgment(
  outputs: ModelOutput[],
  ens: EnsembleResult,
  primaryOverride?: ModelId, // 체크포인트별 판정자 교체 (예: 09:30 전 프리마켓 구간은 user)
): { finalVerdict: Verdict; strengthPct: number } {
  if (PREDICT_CONFIG.judgeMode === "fisher") {
    const primary = outputs.find((o) => o.model === (primaryOverride ?? PREDICT_CONFIG.primaryModel));
    if (primary) {
      return { finalVerdict: primary.verdict, strengthPct: Number((primary.confidence * 100).toFixed(1)) };
    }
  }
  return { finalVerdict: ens.finalVerdict, strengthPct: ens.strengthPct };
}

export function runEnsemble(outputs: ModelOutput[], acc: Partial<Record<ModelId, AccuracyStat>>): EnsembleResult {
  const weights = {} as Record<ModelId, number>;
  for (const id of MODEL_IDS) weights[id] = Number(liftWeight(acc[id]).toFixed(4));
  // 전 모델 리프트 0(기록 없음 포함) — 균등 가중 폴백 (가동 초기·시딩 전)
  if (MODEL_IDS.every((id) => weights[id] === 0)) for (const id of MODEL_IDS) weights[id] = 1 / 3;

  const scores: Record<Verdict, number> = { leverage: 0, inverse: 0, none: 0 };
  for (const o of outputs) scores[o.verdict] += weights[o.model] * o.confidence;

  let finalVerdict: Verdict = "none";
  for (const v of ["leverage", "inverse", "none"] as Verdict[]) {
    if (scores[v] > scores[finalVerdict]) finalVerdict = v;
  }
  const total = scores.leverage + scores.inverse + scores.none;
  const strengthPct = total > 0 ? (scores[finalVerdict] / total) * 100 : 100 / 3;
  return {
    finalVerdict,
    strengthPct: Number(strengthPct.toFixed(1)),
    scores: {
      leverage: Number(scores.leverage.toFixed(4)),
      inverse: Number(scores.inverse.toFixed(4)),
      none: Number(scores.none.toFixed(4)),
    },
    weights,
  };
}
