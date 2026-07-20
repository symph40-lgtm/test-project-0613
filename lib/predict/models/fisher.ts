// 마크 피셔 — ACD: 시초 레인지(OR) ± 오프셋의 A지점 확인, 반대편 C지점 철회. 스펙 2.3절.
// 원전: The Logical Trader. A 확인 = 레벨 밖 유지 시간(OR의 절반), C = 확인 후 반대 이탈 → 판정 전환.

import { PREDICT_CONFIG } from "../config";
import { avgRange } from "../indicators";
import type { DayInput, ModelOutput } from "../types";

// 파라미터 오버라이드 (변동성 레짐 튜닝 검증용 — 운영은 기본값 고정, 스펙 2.3절)
export type FisherCfg = {
  orMinutes?: number;
  offsetRangeRatio?: number;
  confirmMinutes?: number;
  reversalMinutes?: number;
  earlyConfirmBy?: string;
};

export function runFisher(input: DayInput, cfgOverride?: FisherCfg): ModelOutput {
  const cfg: Required<FisherCfg> = { ...PREDICT_CONFIG.fisher, ...cfgOverride };
  const model = "fisher" as const;
  const range10 = avgRange(input.dailyHistory, 10);
  if (range10 === null || input.morning.length < cfg.orMinutes + cfg.confirmMinutes) {
    return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  }

  const or = input.morning.slice(0, cfg.orMinutes);
  const orHigh = Math.max(...or.map((b) => b.high));
  const orLow = Math.min(...or.map((b) => b.low));
  const offset = cfg.offsetRangeRatio * range10;
  const aUp = orHigh + offset;
  const aDown = orLow - offset;

  // OR 이후 완성봉 순회 — 연속 유지 카운트로 A 확인, 확인 후 반대편(C) 이탈이면 전환
  const rest = input.morning.slice(cfg.orMinutes);
  let state: "none" | "up" | "down" = "none";
  let upRun = 0, downRun = 0;
  let confirmedAt: string | null = null;
  let reversed = false;
  for (const b of rest) {
    upRun = b.close > aUp ? upRun + 1 : 0;
    downRun = b.close < aDown ? downRun + 1 : 0;
    if (state === "none") {
      if (upRun >= cfg.confirmMinutes) (state = "up"), (confirmedAt = b.time);
      else if (downRun >= cfg.confirmMinutes) (state = "down"), (confirmedAt = b.time);
    } else if (state === "up" && downRun >= cfg.reversalMinutes) {
      state = "down"; confirmedAt = b.time; reversed = true;
    } else if (state === "down" && upRun >= cfg.reversalMinutes) {
      state = "up"; confirmedAt = b.time; reversed = true;
    }
  }

  const lv = `A상 ${Math.round(aUp)}·A하 ${Math.round(aDown)} (OR ${Math.round(orLow)}~${Math.round(orHigh)}, 오프셋 ${Math.round(offset)}원)`;
  if (state === "none") {
    return { model, verdict: "none", confidence: 0.5, reason: `A지점 미확인 — ${lv}` };
  }
  const conf = reversed ? 0.6 : confirmedAt !== null && confirmedAt < cfg.earlyConfirmBy ? 0.8 : 0.7;
  return {
    model,
    verdict: state === "up" ? "leverage" : "inverse",
    confidence: conf,
    reason: `${confirmedAt} A${state === "up" ? "상" : "하"} 확인${reversed ? " (C지점 반전 후)" : ""} — ${lv}`,
  };
}
