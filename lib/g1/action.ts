// 행동 지시선 (Action Line) — 발주자 통합 지시 2026-08-12 §B.
// 행동어는 닫힌 목록만 (자유 서술 금지). 내부 판정 코드 → 행동어 매핑을 여기 한 곳에 명문화한다.
// 지시선은 로그(t2/r1/r2 jsonb의 `action` 필드)에 저장되어 그 자체가 채점 가능한 스펙이 된다 (B3).
// 꼬리표(B4): ops_settings `g1_phase` 로만 전환 — 코드·수동 편집 불가, 게이트 통과 시 발주자 절차로 변경.

import { createAdminClient } from "@/lib/supabase/admin";

export type ActionCode =
  | "T2_BUY" | "T2_SELL" | "T2_HOLD_OFF"
  | "R1_KEEP" | "R1_HALF" | "R1_EXIT_PREOPEN" | "R1_NOPOS_WATCH"
  | "R2_OPEN_BUY" | "R2_FADE_CANDIDATE" | "R2_NO_SIGNAL";

export type ActionLine = { code: ActionCode; line: string; phase: "가상" | "실사용" };

// B4: 단계 꼬리표 — 기본 "가상". 게이트 전환은 ops_settings.g1_phase = {"r1":"live"} 식으로만.
export async function phaseTag(step: "t2" | "r1" | "r2"): Promise<"가상" | "실사용"> {
  try {
    const { data } = await createAdminClient().from("ops_settings").select("value").eq("key", "g1_phase").maybeSingle();
    const v = (data?.value ?? {}) as Record<string, string>;
    return v[step] === "live" ? "실사용" : "가상";
  } catch { return "가상"; }
}

const fmt = (code: ActionCode, body: string, phase: "가상" | "실사용"): ActionLine => ({
  code, phase, line: `▶ 행동: ${body} — ${phase}`,
});

// ── T2 (저녁 결정) ──
export function t2Action(
  v: { direction: string; confidence: string | null; size: string; abstain_reason: string | null; expected_residual_gap: number | null },
  blocked: string | null, phase: "가상" | "실사용",
): ActionLine {
  if (v.direction === "UP")
    return fmt("T2_BUY", `매수 진입 (${v.size}·NXT 지정가·19:55까지 반전 감시)`, phase);
  if (v.direction === "DOWN")
    return fmt("T2_SELL", `매도 진입 (${v.size}·NXT 지정가·19:55까지 반전 감시)`, phase);
  return fmt("T2_HOLD_OFF", `베팅 보류(${v.abstain_reason ?? blocked ?? "θ 미달"})`, phase);
}

// ── R1 (아침 재판 — 스펙 G1B v0.3 §5 조정 매트릭스의 행동어 사상) ──
export function r1Action(
  g1a: { direction: string; entry_px: number | null } | null,
  expectedOpen: number | null, sigmaPct: number, fairGapPct: number | null, phase: "가상" | "실사용",
): ActionLine & { residual_sigma: number | null } {
  if (!g1a || g1a.direction === "NEUTRAL" || !g1a.entry_px || !expectedOpen) {
    const opp = fairGapPct != null && sigmaPct > 0 && Math.abs(fairGapPct) >= 1.2 * sigmaPct;
    return { ...fmt("R1_NOPOS_WATCH", `무포지션—기회 관찰${opp ? ` (|FairGap| ≥1.2σ 잔여분 후보)` : ""}`, phase), residual_sigma: null };
  }
  const residPct = (expectedOpen / g1a.entry_px - 1) * 100 * (g1a.direction === "UP" ? 1 : -1);
  const rs = sigmaPct > 0 ? Math.round((residPct / sigmaPct) * 100) / 100 : null;
  if (rs == null) return { ...fmt("R1_NOPOS_WATCH", "무포지션—기회 관찰 (σ 미산출)", phase), residual_sigma: null };
  if (rs >= 0.2) return { ...fmt("R1_KEEP", `유지 (잔여기대 ${rs}σ·시가${rs >= 0.8 ? "+30분 내" : ""} 익절 계획)`, phase), residual_sigma: rs };
  if (rs > -0.5) return { ...fmt("R1_HALF", `절반 축소 (잔여기대 ${rs}σ 무승부·시가 정리)`, phase), residual_sigma: rs };
  return { ...fmt("R1_EXIT_PREOPEN", `프리장 08:00 전량 청산 (오판 확정 ${rs}σ·물타기 금지)`, phase), residual_sigma: rs };
}

// ── R2 (시가 확인) ──
export function r2Action(
  residualSigma: number | null, expectedOpen: number | null, missing: boolean, phase: "가상" | "실사용",
): ActionLine {
  if (missing || residualSigma == null)
    return fmt("R2_NO_SIGNAL", "무신호—관망 (예상체결 관측 결측)", phase);
  if (residualSigma <= -1.2)
    return fmt("R2_OPEN_BUY", `시가 매수 후보 (목표 ${expectedOpen?.toLocaleString() ?? "이론가"}·시한 09:30)`, phase);
  if (residualSigma >= 1.2)
    return fmt("R2_FADE_CANDIDATE", "되돌림 후보 (금지조건 통과 시만 — UnderReact·재평가 랠리 점검)", phase);
  return fmt("R2_NO_SIGNAL", `무신호—관망 (잔차 ${residualSigma}σ < 1.2σ)`, phase);
}
