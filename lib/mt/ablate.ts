// 절제 재채점 (부검 전용) — 발주자 지시 2026-08-16 제1부.
// ⚠ 진단 전용이다. 규칙을 바꾸지 않는다. 산출된 MtDay를 **후처리**해 특정 부품을 결측 처리하고
//    투표·톤·전환을 다시 계산할 뿐이라, 원 엔진과 값이 갈릴 여지가 없다 (재계산이 아니라 재채점).

import { MT_CONFIG } from "./config";
import type { MtDay, PhaseKey } from "./types";

const PHASES: PhaseKey[] = ["S1", "S2", "S3", "S4"];

/**
 * 상시 부품(C계열) → 그 부품을 재료로 쓰는 패널 부품 매핑.
 * 스펙 §1.3 "국면 패널이 호출하는 재료 겸용"의 실제 배선이다. 배선이 없는 C3·C5·C7은
 * **정의상 톤에 기여할 수 없다** — 절제해도 값이 변하지 않는 것이 정상이며, 그 자체가 진단 결과다.
 */
export const C_TO_PARTS: Record<string, string[]> = {
  C1: ["S1_1", "S2_4", "S3_1", "S4_2"],   // 반응비대칭
  C2: ["S1_2", "S2_2", "S3_2"],           // 거래량 비대칭
  C3: ["S2_3", "S3_4"],                   // 종반 강도 CLV — R4 배선(2026-08-16): 합성 재료 (부검 시점엔 미배선이었음)
  C4: ["S2_3", "S3_4"],                   // 폭·주도 (라이브 breadth / 소급 상대강도)
  C5: ["S1_2", "S3_2"],                   // 수급 연속 — R4 배선: 가산 재료 (60일까지만 조달)
  C6: ["S4_3"],                           // 변동성 구조 — 패널 경로. 국면 squeeze 항은 별도 패스로 측정
  C7: ["S1_4", "S3_3"],                   // 52주 고점 근접도 — R4 배선: 배율 재료
};
// ⚠ 부검(MT_AUTOPSY.md 1-0)은 R4 이전 배선(C3·C5·C7 = [])으로 산출된 것이다. 재실행 시 표가 달라지는 것이 정상.
export const C_KEYS = Object.keys(C_TO_PARTS);

/** 어떤 C에도 배선되지 않은 '가격 전용' 패널 부품 (단독 벌에서 전부 꺼진다) */
export const PRICE_ONLY_PARTS = ["S1_3", "S1_4", "S2_1", "S3_3", "S4_1"];

const ALL_PARTS = [...Object.values(C_TO_PARTS).flat(), ...PRICE_ONLY_PARTS];

export const partsForExclude = (c: string) => C_TO_PARTS[c] ?? [];
export const partsForOnly = (c: string) => ALL_PARTS.filter((p) => !(C_TO_PARTS[c] ?? []).includes(p));

/** 하루치 재채점 — disabled 부품을 결측 처리하고 투표·톤·전환 후보를 다시 계산 */
export function ablateDay(day: MtDay, disabled: string[]): MtDay {
  const off = new Set(disabled);
  const panels = {} as MtDay["panels"];
  for (const k of PHASES) {
    const src = day.panels[k];
    const parts = src.parts.map((p) => (off.has(p.key) ? { ...p, fill: null, available: false, detail: `${p.detail} [절제]` } : p));
    const avail = parts.filter((p) => p.available);
    const threshold = MT_CONFIG.vote.byAvailable[avail.length] ?? null;
    const vote = avail.filter((p) => (p.fill ?? 0) >= MT_CONFIG.vote.fillThreshold).length
      + (day.transition.votesAdjust?.[k] ?? 0);   // 역신호 가산표는 부품 절제와 무관하게 유지
    const wSum = avail.length;
    panels[k] = {
      parts, vote, threshold,
      candidate: threshold != null && vote >= threshold,
      fillAvg: wSum ? Math.round((avail.reduce((a, p) => a + (p.fill as number), 0) / wSum) * 1000) / 1000 : null,
    };
  }

  // 톤 재계산 (§3.1 동일 식)
  const T = MT_CONFIG.tone;
  const byPhase = {} as Record<PhaseKey, number>;
  let mt = 0;
  for (const k of PHASES) {
    const fill = panels[k].fillAvg ?? 0;
    const tone = T.inertia[k] + T.evidence[k] * fill;
    byPhase[k] = Math.round(tone * 1000) / 1000;
    mt += day.phase.P[k] * tone;
  }
  mt = Math.max(-1, Math.min(1, Math.round(mt * 1000) / 1000));
  const abs = Math.abs(mt);

  // 전환 후보·확정 재판정 — 원 엔진(R1: 후보 패널이 방향)과 같은 규칙
  const cands = (["S1", "S3", "S4"] as PhaseKey[]).filter((k) => panels[k].candidate).sort((a, b) => panels[b].vote - panels[a].vote);
  const candidate = cands[0] ?? null;
  const wantUp = candidate === "S1" || candidate === "S4";
  const priceOk = candidate ? (wantUp ? day.transition.priceUp : day.transition.priceDown) : false;
  const confirmed = !!candidate && priceOk && !day.transition.blockedByReverse;
  const rule = { to: (candidate === "S1" ? "S2" : candidate === "S4" ? "S1" : day.phase.top === "S2" ? "S3" : "S4") as PhaseKey };

  return {
    ...day, panels,
    tone: {
      mt, direction: mt > 0.02 ? "상승 에너지" : mt < -0.02 ? "하락 에너지" : "중립",
      strength: abs < T.strengthWeak ? "약" : abs < T.strengthStrong ? "중" : "강", byPhase,
    },
    transition: {
      ...day.transition, candidate, confirmed, priceOk,
      from: confirmed ? day.phase.top : null, to: confirmed ? rule.to : null,
    },
  };
}

export const ablateSeries = (days: MtDay[], disabled: string[]) => days.map((d) => ablateDay(d, disabled));
