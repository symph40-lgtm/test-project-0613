// 사용자 자체 조건 모델 — RV1(분봉 모멘텀, ext-modules 9장) + T6(산·골 스윙 구조, 부록 B 2026-07-09).
// 대가 모델과 같은 라벨·같은 데이터로 사용자 고안 조건의 성능을 비교하기 위한 여섯 번째 모델.
//
// ⚠ predict↔signal 분리 원칙의 유일한 예외: lib/signal의 "순수 엔진 함수"를 그대로 재사용한다.
// 재구현하면 실제 운영 중인 사용자 조건과 미세하게 달라져 "사용자 조건 그대로 검증"이라는
// 목적이 깨지기 때문. 읽기 전용(순수 함수) import만 허용, 상태·DB·알림은 일절 공유하지 않는다.
//
// 수급 계열(T4·T5·T8 FKS200)은 과거 장중 시계열이 없어 백테스트 불가 — 이 모델에서 제외.
// 종합 규칙 (v1.0, 라이브 운영과 동일한 우선순위):
//   ① RV1 최초 트리거 방향 = 판정 (라이브 문자와 동일 — 전제 조건 없음)
//   ② RV1 무트리거 시 T6 스윙 구조가 '추세'면 그 방향
//   ③ T6 '횡보'면 추세 없음(신뢰도 상향), '미정'이면 추세 없음(보수)

import { detectReversal } from "../../signal/engine/reversal";
import { computeSwingStructure } from "../../signal/engine/trend";
import type { IntradayTick } from "../../signal/types";
import type { DayInput, ModelOutput } from "../types";

export function runUser(input: DayInput): ModelOutput {
  const model = "user" as const;
  const prevClose = input.dailyHistory[input.dailyHistory.length - 1]?.close;
  if (!prevClose || input.morning.length < 10) {
    return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  }

  const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
  // 분봉 → 의사 틱. detectReversal은 minuteOfDay·hynixChg(선택자 기본값)만 사용 — 나머지 필드 불요
  const ticks = input.morning.map(
    (b) =>
      ({
        minuteOfDay: toMin(b.time),
        hynixChg: ((b.close - prevClose) / prevClose) * 100,
      }) as unknown as IntradayTick,
  );

  // ① RV1 — 각 시점 프리픽스로 재생해 최초 트리거 탐색 (라이브의 60초 폴링과 동일 효과)
  let rv: { dir: "UP" | "DOWN"; cond: string; at: string } | null = null;
  for (let i = 5; i < ticks.length; i++) {
    const hit = detectReversal(ticks.slice(0, i + 1));
    if (hit) {
      rv = { dir: hit.dir, cond: hit.cond, at: input.morning[i].time };
      break;
    }
  }

  // ② T6 — 완성된 5분봉 종가의 산·골 스윙 구조 (엔진 기본 파라미터 그대로)
  const m5: { min: number; px: number }[] = [];
  const lastMin = toMin(input.morning[input.morning.length - 1].time);
  for (const b of input.morning) {
    const min = toMin(b.time);
    const bucket = Math.floor((min - 540) / 5);
    if (540 + (bucket + 1) * 5 > lastMin + 1) continue; // 미완성 5분봉 제외
    const pt = { min: 540 + bucket * 5, px: b.close };
    if (m5.length > 0 && m5[m5.length - 1].min === pt.min) m5[m5.length - 1] = pt;
    else m5.push(pt);
  }
  const swing = m5.length >= 4 ? computeSwingStructure(m5) : null;
  const swingNote =
    swing === null ? "스윙 데이터 부족" : `T6 ${swing.status}${swing.dir ? `(${swing.dir === "UP" ? "상승" : "하락"})` : ""}`;

  if (rv) {
    const agree = swing?.status === "추세" && swing.dir === rv.dir;
    const oppose = swing?.status === "추세" && swing.dir !== null && swing.dir !== rv.dir;
    const conf = agree ? 0.8 : oppose ? 0.6 : 0.7;
    return {
      model,
      verdict: rv.dir === "UP" ? "leverage" : "inverse",
      confidence: conf,
      reason: `RV1 ${rv.at} ${rv.cond} 트리거 · ${swingNote}`,
    };
  }
  if (swing?.status === "추세" && swing.dir !== null) {
    return {
      model,
      verdict: swing.dir === "UP" ? "leverage" : "inverse",
      confidence: 0.6,
      reason: `RV1 무트리거 · ${swingNote} — ${swing.detail}`,
    };
  }
  return {
    model,
    verdict: "none",
    confidence: swing?.status === "횡보" ? 0.65 : 0.5,
    reason: `RV1 무트리거 · ${swingNote}`,
  };
}
