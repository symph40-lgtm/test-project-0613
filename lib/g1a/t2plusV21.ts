// T2+ v2.1 챌린저 — v2의 drift 성분 개정판 (발주자 등재 지시 2026-08-22). 본판정 무접촉, v2와 병행 섀도.
// 사전 등록: g1br/challengers/t2plus_v2_1.md (등록 상수 = 아래 V21 — 변경은 재등록)
//   ⓐ' 바스켓 다창 기울기(30분/60분/세션 3창 중 2창 동의) + 2차 가속(감속이면 표 철회) + 갭 반표(0.5)
//   ⓓ' P1 유럽 다창(세션 변화율 + 종반 30분 비대립)
//   ⓔ' 이벤트 2등급: 1급(FOMC·CPI·고용·실적) = 무효화 / 2급(FRED ★3+ 2차 지표) = 확신도 −0.25/건
//   ⓑⓒⓕ = v2와 동일. 레벨 금지·base 수용·상한 ±0.5σ 불변.
import { V2, type DriftComponent, type DriftJudge } from "./t2plusV2";

export const V21 = {
  BASKET_R30_MIN: 0.15, BASKET_R60_MIN: 0.25, BASKET_SESS_MIN: 0.3,   // ⓐ' 3창 문턱 (%)
  GAP_MIN: 0.5, GAP_WEIGHT: 0.5,                                         // 갭 반표
  P1_SESS_MIN: 0.3, P1_R30_OPPOSE: 0.15,                                 // ⓓ'
  TIER2_PENALTY: 0.25,                                                   // ⓔ' 2급 1건당 확신도 감점
  VOTE_MIN: V2.VOTE_MIN, MACRO_MIN: V2.MACRO_MIN,
} as const;

export type BasketWindows = { r30: number | null; r60: number | null; rSess: number | null; gap: number | null; accel2: number | null };
export type P1Windows = { r30: number | null; rSess: number | null };
export type EventsTiered = { tier1: string | null; tier2: string[] };

export function judgeDriftV21(a: {
  basket: BasketWindows; dcNf: number | null; nfCumSign: number; dcPm: number | null; basketSign: number;
  p1: P1Windows; events: EventsTiered; macro: { dTnxBp: number | null; dFxPct: number | null; dWtiPct: number | null };
}): DriftJudge {
  const comps: (DriftComponent & { weight?: number })[] = [];
  const v = (key: string, vote: -1 | 0 | 1, value: number | null, note: string, weight = 1) => comps.push({ key, vote, value, note, weight });
  const sg = (x: number | null, min: number): -1 | 0 | 1 => (x == null ? 0 : x >= min ? 1 : x <= -min ? -1 : 0);

  // ⓐ' 다창 동의 + 2차 가속
  {
    const b = a.basket;
    const s30 = sg(b.r30, V21.BASKET_R30_MIN), s60 = sg(b.r60, V21.BASKET_R60_MIN), sS = sg(b.rSess, V21.BASKET_SESS_MIN);
    const ups = [s30, s60, sS].filter((s) => s > 0).length, dns = [s30, s60, sS].filter((s) => s < 0).length;
    let vote: -1 | 0 | 1 = ups >= 2 ? 1 : dns >= 2 ? -1 : 0;
    let note = `3창 30m ${b.r30 ?? "—"}/60m ${b.r60 ?? "—"}/세션 ${b.rSess ?? "—"}% (2창 동의)`;
    if (vote !== 0 && b.accel2 != null && Math.sign(b.accel2) === -vote && Math.abs(b.accel2) >= V21.BASKET_R30_MIN) { vote = 0; note += ` · 감속 ${b.accel2}% → 표 철회`; }
    v("ⓐ'바스켓다창", vote, b.r30, note);
    v("ⓐ'갭", sg(b.gap, V21.GAP_MIN), b.gap, `프리마켓 시작가 vs 전일 최종가 갭 (반표 ${V21.GAP_WEIGHT})`, V21.GAP_WEIGHT);
  }
  v("ⓑDC-NF", a.dcNf != null && a.dcNf >= 0.6 && a.nfCumSign !== 0 ? (a.nfCumSign as -1 | 1) : 0, a.dcNf, "야간선물 흐름 일관성 ≥60% 시 누적 방향");
  v("ⓒDC-PM", a.dcPm != null && a.dcPm >= 0.6 && a.basketSign !== 0 ? (a.basketSign as -1 | 1) : 0, a.dcPm, "프리마켓 일관성 ≥60% 시 바스켓 방향");
  // ⓓ' 유럽 다창: 세션 변화율이 문턱 이상이고 종반 30분이 반대로 기울지 않을 때
  {
    const sS = sg(a.p1.rSess, V21.P1_SESS_MIN);
    const oppose = sS !== 0 && a.p1.r30 != null && Math.sign(a.p1.r30) === -sS && Math.abs(a.p1.r30) >= V21.P1_R30_OPPOSE;
    v("ⓓ'P1다창", oppose ? 0 : sS, a.p1.rSess, `유럽 세션 ${a.p1.rSess ?? "—"}% · 종반30m ${a.p1.r30 ?? "—"}%${oppose ? " (종반 반대 → 기권)" : ""}`);
  }
  // ⓕ 매크로 변화율 (v2 동일)
  const mVotes: number[] = [];
  if (a.macro.dTnxBp != null && Math.abs(a.macro.dTnxBp) >= V21.MACRO_MIN.tnx_bp) mVotes.push(-Math.sign(a.macro.dTnxBp));
  if (a.macro.dFxPct != null && Math.abs(a.macro.dFxPct) >= V21.MACRO_MIN.fx_pct) mVotes.push(-Math.sign(a.macro.dFxPct));
  if (a.macro.dWtiPct != null && Math.abs(a.macro.dWtiPct) >= V21.MACRO_MIN.wti_pct) mVotes.push(-Math.sign(a.macro.dWtiPct));
  const mSum = mVotes.reduce((x, y) => x + y, 0);
  v("ⓕ매크로Δ", mSum >= 2 ? 1 : mSum <= -2 ? -1 : 0, mSum, "10Y·달러원·WTI 17:00~현재 변화율 합의(±2표)");

  // ⓔ' 1급 = 무효화
  if (a.events.tier1) {
    v("ⓔ'1급", 0, null, `밤중 ${a.events.tier1} — 방향 예측 무효화`);
    return { dir: "중립", conf: 0, components: comps, invalidated: a.events.tier1 };
  }
  const net = comps.reduce((s, c) => s + c.vote * (c.weight ?? 1), 0);
  const active = comps.filter((c) => c.vote !== 0).length;
  const dir = net >= V21.VOTE_MIN ? "상방" : net <= -V21.VOTE_MIN ? "하방" : "중립";
  let conf = active ? Math.min(1, Math.abs(net) / 4) : 0;
  if (a.events.tier2.length) {
    conf = Math.max(0, Math.round((conf - V21.TIER2_PENALTY * a.events.tier2.length) * 100) / 100);
    v("ⓔ'2급", 0, a.events.tier2.length, `2급 지표 ${a.events.tier2.join("·")} — 확신도 −${V21.TIER2_PENALTY}/건`);
  }
  return { dir: dir === "중립" ? "중립" : conf > 0 ? dir : "중립", conf, components: comps, invalidated: null };
}
