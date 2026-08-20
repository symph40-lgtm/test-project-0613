// T2+ v2 챌린저 — T2 재정의: 야간선물 기준점(수용) + 잔여 drift 방향 예측 (발주 D 2026-08-20)
// 본판정 T2 무접촉. 기존 T2+ 섀도(v1)를 v2로 대체 — 구판 기록(t2.shadow)은 보존·분리 집계, 신규는 t2.shadow_v2.
// 사전 등록: g1br/challengers/t2plus_v2.md (등록 시점 상수 고정 — 변경은 재등록)
//
// 원칙 (발주 D §2): 예측부 입력은 변화율·기울기·일관성만 — **레벨 절대 금지**
// (이중계상 + 구판 금리 항 OOS 유해 전례). fx 챌린저(I2)와 역할 구분: fx = R1 크기 / ⓕ = 저녁 drift 방향.

import type { G1ASymbol } from "./types";

export type DriftComponent = { key: string; vote: -1 | 0 | 1; value: number | null; note: string };
export type DriftJudge = {
  dir: "상방" | "중립" | "하방"; conf: number;         // 확신도 0~1 (동의 성분 비율)
  components: DriftComponent[];                          // 성분별 기여 로그 (절제 진단 구조 — §5)
  invalidated: string | null;                            // ⓔ 이벤트 무효화 사유
};
export type ShadowV2 = {
  t: string; base_pct: number; beta: number; base_stock_pct: number;
  drift: DriftJudge; adj_pct: number; expected_gap_pct: number;
  confidence_vol: number | null;                         // 저녁 거래량 20일 평균 배율 (축적 20일 전 null — 강등 미적용 명기)
  grade: string; sigma_used: number;
};

// 등록 상수 (사전 등록 고정)
export const V2 = {
  DRIFT_CAP_SIGMA: 0.5,          // 조정 상한 ±0.5σ (발주 D §3)
  CONF_FULL_ADJ_PCT: 0.6,        // 확신도 1.0일 때 조정폭 (지수 %) — cap과 함께 적용
  VOTE_MIN: 2,                   // 방향 선언 최소 동의 성분 수
  BASKET_ACCEL_MIN: 0.15,        // ⓐ 마지막 30분 변화율 유의 문턱 (%)
  MACRO_MIN: { tnx_bp: 2, fx_pct: 0.15, wti_pct: 0.5 }, // ⓕ 유의 문턱 (17:00~19:35 변화)
} as const;

export function judgeDrift(a: {
  basketAccel30m: number | null;   // ⓐ 미 프리장 바스켓 마지막 30분 변화율 (%) — 가속/감속만
  dcNf: number | null;             // ⓑ 야간선물 흐름 일관성 (0~1) + 누적 부호
  nfCumSign: number;               //    야간선물 누적 부호 (-1/0/1)
  dcPm: number | null;             // ⓒ 프리마켓 동방향 비율 (0~1) + 바스켓 부호
  basketSign: number;
  p1Slope: number | null;          // ⓓ P1 유럽 반도체 종반 기울기 근사 (세션 변화율 %) — 명기: 종반 30분 미보유 시 세션 전체 기울기 근사
  eventTonight: string | null;     // ⓔ 밤중 발표 예정 → 방향 예측 무효화
  macro: { dTnxBp: number | null; dFxPct: number | null; dWtiPct: number | null }; // ⓕ 17:00~19:35 변화율 (레벨 금지)
}): DriftJudge {
  const comps: DriftComponent[] = [];
  const v = (key: string, vote: -1 | 0 | 1, value: number | null, note: string) => comps.push({ key, vote, value, note });

  v("ⓐ바스켓가속", a.basketAccel30m == null ? 0 : a.basketAccel30m >= V2.BASKET_ACCEL_MIN ? 1 : a.basketAccel30m <= -V2.BASKET_ACCEL_MIN ? -1 : 0,
    a.basketAccel30m, "미 프리장 마지막 30분 변화율(가속/감속만)");
  v("ⓑDC-NF", a.dcNf != null && a.dcNf >= 0.6 && a.nfCumSign !== 0 ? (a.nfCumSign as -1 | 1) : 0, a.dcNf, "야간선물 흐름 일관성 ≥60% 시 누적 방향");
  v("ⓒDC-PM", a.dcPm != null && a.dcPm >= 0.6 && a.basketSign !== 0 ? (a.basketSign as -1 | 1) : 0, a.dcPm, "프리마켓 일관성 ≥60% 시 바스켓 방향");
  v("ⓓP1기울기", a.p1Slope == null ? 0 : a.p1Slope >= 0.3 ? 1 : a.p1Slope <= -0.3 ? -1 : 0, a.p1Slope, "유럽 반도체 종반 기울기(세션 변화율 근사 — 명기)");
  // ⓕ 매크로 저녁 변화율 — 금리↑·원화약세·유가↑ = 하방 (방향 재료로만, 레벨 금지)
  const mVotes: number[] = [];
  if (a.macro.dTnxBp != null && Math.abs(a.macro.dTnxBp) >= V2.MACRO_MIN.tnx_bp) mVotes.push(-Math.sign(a.macro.dTnxBp));
  if (a.macro.dFxPct != null && Math.abs(a.macro.dFxPct) >= V2.MACRO_MIN.fx_pct) mVotes.push(-Math.sign(a.macro.dFxPct));
  if (a.macro.dWtiPct != null && Math.abs(a.macro.dWtiPct) >= V2.MACRO_MIN.wti_pct) mVotes.push(-Math.sign(a.macro.dWtiPct));
  const mSum = mVotes.reduce((x, y) => x + y, 0);
  v("ⓕ매크로Δ", mSum >= 2 ? 1 : mSum <= -2 ? -1 : 0, mSum, "10Y·달러원·WTI 17:00~19:35 변화율 합의(±2표) — fx 챌린저(R1 크기)와 역할 구분");

  if (a.eventTonight) {
    v("ⓔ이벤트", 0, null, `밤중 ${a.eventTonight} 발표 예정 — 방향 예측 무효화`);
    return { dir: "중립", conf: 0, components: comps, invalidated: a.eventTonight };
  }
  const up = comps.filter((c) => c.vote > 0).length, dn = comps.filter((c) => c.vote < 0).length;
  const net = up - dn, active = up + dn;
  const dir = net >= V2.VOTE_MIN ? "상방" : net <= -V2.VOTE_MIN ? "하방" : "중립";
  const conf = active ? Math.min(1, Math.abs(net) / 4) : 0;
  return { dir, conf, components: comps, invalidated: null };
}

export function buildShadowV2(a: {
  t: string; nfCutPct: number; beta: number; drift: DriftJudge; sigma: number;
  volRatio: number | null; thetaLow: number;
}): ShadowV2 {
  const baseStock = Math.round(a.nfCutPct * a.beta * 100) / 100;
  const rawAdj = a.drift.dir === "중립" ? 0 : (a.drift.dir === "상방" ? 1 : -1) * a.drift.conf * V2.CONF_FULL_ADJ_PCT * a.beta;
  const cap = V2.DRIFT_CAP_SIGMA * a.sigma;
  const adj = Math.round(Math.max(-cap, Math.min(cap, rawAdj)) * 100) / 100;
  const exp = Math.round((baseStock + adj) * 100) / 100;
  // 등급 — 4등급제 문법 (θ 기준은 예상갭 크기), 거래량 배율 낮으면(<0.7) 1단계 강등 (배율 미산출=강등 미적용, 명기)
  let grade = Math.abs(exp) >= a.thetaLow * 2 ? "High" : Math.abs(exp) >= a.thetaLow ? "Low" : Math.abs(exp) >= 0.5 ? "Lean" : "Flat";
  if (a.volRatio != null && a.volRatio < 0.7) grade = grade === "High" ? "Low" : grade === "Low" ? "Lean" : grade === "Lean" ? "Flat" : grade;
  return { t: a.t, base_pct: a.nfCutPct, beta: a.beta, base_stock_pct: baseStock, drift: a.drift, adj_pct: adj, expected_gap_pct: exp, confidence_vol: a.volRatio, grade, sigma_used: a.sigma };
}
