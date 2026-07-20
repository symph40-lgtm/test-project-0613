// 피셔W — 고변동 레짐용 광폭 오프셋(0.25) 변형의 섀도 모델. 스펙 2.3절 부기 (2026-07-20).
// 배경: ATR 11.8% 레짐(최근 60일)에서 본 피셔(0.15)의 방향적중이 54%로 열화, 스윕에서
// 오프셋 0.25가 65.8%로 최우수. 단 in-sample 격자 탐색 결과라 즉시 채택하지 않고
// 대조군으로 매일 채점만 한다 (판정·문자 무관). 사전 등록 승격 기준: 라이브 한 달에서
// 본 피셔 대비 방향적중 우위 지속 시 상수 교체 검토.

import { runFisher } from "./fisher";
import type { DayInput, ModelOutput } from "../types";

export function runFisherWide(input: DayInput): ModelOutput {
  const out = runFisher(input, { offsetRangeRatio: 0.25 });
  return { ...out, model: "fisherw" };
}
