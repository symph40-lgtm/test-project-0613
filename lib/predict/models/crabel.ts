// 토비 크레이블 — 변동성 수축(NR7/NR4+IB) + 시가 돌파(ORB). 스펙 2.1절.
// 원전: Day Trading with Short Term Price Patterns and Opening Range Breakout (1990)
// Stretch = 직전 10일 min(|시가-고가|, |시가-저가|) 평균. 시가±Stretch 최초 돌파 방향이 당일 방향.

import { PREDICT_CONFIG } from "../config";
import { crabelStretch, isInsideBar, isNR } from "../indicators";
import type { DayInput, ModelOutput } from "../types";

export function runCrabel(input: DayInput): ModelOutput {
  const cfg = PREDICT_CONFIG.crabel;
  const model = "crabel" as const;
  const stretch = crabelStretch(input.dailyHistory, cfg.stretchLookback);
  if (stretch === null || input.morning.length === 0) {
    return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  }

  const nr7 = isNR(input.dailyHistory, 7);
  const nr4ib = isNR(input.dailyHistory, 4) && isInsideBar(input.dailyHistory);
  const up = input.openPx + stretch;
  const down = input.openPx - stretch;

  // 완성봉 종가 기준 최초 돌파 → 방향 후보. 이후 반대 레벨도 돌파하면 휩쏘 → 추세 없음
  let dir: "up" | "down" | null = null;
  let brokeAt: string | null = null;
  let whipsaw = false;
  for (const b of input.morning) {
    if (dir === null) {
      if (b.close > up) (dir = "up"), (brokeAt = b.time);
      else if (b.close < down) (dir = "down"), (brokeAt = b.time);
    } else if ((dir === "up" && b.close < down) || (dir === "down" && b.close > up)) {
      whipsaw = true;
      break;
    }
  }

  const contraction = nr7 ? "NR7" : nr4ib ? "NR4+IB" : null;
  if (whipsaw) {
    return { model, verdict: "none", confidence: 0.6, reason: `양방향 휩쏘 (Stretch ±${Math.round(stretch)}원 모두 돌파)` };
  }
  if (dir === null) {
    return {
      model,
      verdict: "none",
      confidence: 0.5,
      reason: `무돌파 (Stretch ±${Math.round(stretch)}원 유지)${contraction ? ` — ${contraction} 수축 상태였으나 미확장` : ""}`,
    };
  }
  let conf: number = cfg.baseConf;
  if (nr7) conf += cfg.nr7Bonus;
  else if (nr4ib) conf += cfg.nr4ibBonus;
  if (brokeAt !== null && brokeAt < cfg.earlyCutoff) conf += cfg.earlyBonus;
  conf = Math.min(cfg.maxConf, conf);
  return {
    model,
    verdict: dir === "up" ? "leverage" : "inverse",
    confidence: Number(conf.toFixed(2)),
    reason: `${brokeAt} 시가${dir === "up" ? "+" : "-"}Stretch(${Math.round(stretch)}원) 돌파${contraction ? ` · 전일 ${contraction} 수축` : ""}`,
  };
}
