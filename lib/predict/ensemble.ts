// 앙상블 — 모델별 누적 정확도(라플라스 평활)를 가중치로 한 최종 판정. 스펙 1.2·1.3절.

import type { AccuracyStat, EnsembleResult, ModelId, ModelOutput, Verdict } from "./types";
import { MODEL_IDS } from "./types";

// 표본이 적을 때 1/3(3분류 우연 수준)로 수렴하는 평활 정확도
export function smoothedAccuracy(stat: AccuracyStat | undefined): number {
  const c = stat?.correct ?? 0;
  const t = stat?.total ?? 0;
  return (c + 1) / (t + 3);
}

export function runEnsemble(outputs: ModelOutput[], acc: Partial<Record<ModelId, AccuracyStat>>): EnsembleResult {
  const weights = {} as Record<ModelId, number>;
  for (const id of MODEL_IDS) weights[id] = Number(smoothedAccuracy(acc[id]).toFixed(4));

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
