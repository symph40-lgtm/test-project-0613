// 피셔F — 저문턱(오프셋 0.05·확인 4봉) 변형의 대조군 모델. 스펙 2.9절 (2026-07-21 사용자 승인).
// 배경: 7/21 조기판정 분석(scripts/predict-recent-sweep.ts) — 첫확인 진입+스탑(-1.5% 본주) 누적이
// 전체 220일/전쟁후(3/2~)/레버출시후(5/27~) 3구간 모두 현행 대비 우위. 같은 상수가 라이브 조기창
// (09:30~10:30, config.earlyOffsetRatio·earlyConfirmMinutes)에 실제 적용 중이며, 이 모델은 그 상수를
// 14:00 확정 창에 적용한 성능을 매일 채점해 레짐 변화(저문턱 열화) 감시를 담당한다.
// 조기창 자체의 실측은 체크포인트 슬롯 채점(09:30·10:00·10:30)이 담당 — 역할 분리.

import { runFisher } from "./fisher";
import type { DayInput, ModelOutput } from "../types";

export function runFisherFast(input: DayInput): ModelOutput {
  const out = runFisher(input, { offsetRangeRatio: 0.05, confirmMinutes: 4 });
  return { ...out, model: "fisherf" };
}
