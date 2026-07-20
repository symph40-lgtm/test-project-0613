// 러너 — 하루치 입력으로 5개 모델을 독립 실행. 모델 간 참조 없음.

import { runCrabel } from "./models/crabel";
import { runRaschke } from "./models/raschke";
import { runFisher } from "./models/fisher";
import { runDalton } from "./models/dalton";
import { runGrimes } from "./models/grimes";
import { runUser } from "./models/user";
import { runM7Proxy } from "./models/m7proxy";
import { runFisherWide } from "./models/fisherWide";
import type { DayInput, ModelOutput } from "./types";

export function runAllModels(input: DayInput): ModelOutput[] {
  return [
    runCrabel(input), runRaschke(input), runFisher(input),
    runDalton(input), runGrimes(input), runUser(input), runM7Proxy(input),
    runFisherWide(input), // 섀도 — 판정 무관, 채점만 (승격 기준: 라이브 1개월 본 피셔 우위)
  ];
}
