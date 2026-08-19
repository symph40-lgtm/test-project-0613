// 행동 지시선 (Action Line) — 발주자 통합 지시 2026-08-12 §B.
// 행동어는 닫힌 목록만 (자유 서술 금지). 내부 판정 코드 → 행동어 매핑을 여기 한 곳에 명문화한다.
// 지시선은 로그(t2/r1/r2 jsonb의 `action` 필드)에 저장되어 그 자체가 채점 가능한 스펙이 된다 (B3).
// 꼬리표(B4): ops_settings `g1_phase` 로만 전환 — 코드·수동 편집 불가, 게이트 통과 시 발주자 절차로 변경.

import { createAdminClient } from "@/lib/supabase/admin";

export type ActionCode =
  // 방향-수단 매트릭스 (a) 확정 (발주자 8/13): 신규 숏 없음 — "매도 진입" 제거,
  // 갭하락 판정은 보유분 방어(T2_SELL_HOLDINGS) 또는 경계(T2_DOWN_ALERT)로만.
  | "T2_BUY" | "T2_SELL_HOLDINGS" | "T2_DOWN_ALERT" | "T2_LEAN" | "T2_FLAT"
  | "T2_GRADE_NOBET"   // 등급 High/Low 구간인데 트리거 조건에 막혀 베팅 없음 (등급-행동 분리, 발주자 8/18)
  | "R1_KEEP" | "R1_HALF" | "R1_EXIT_PREOPEN" | "R1_NOPOS_WATCH"
  | "R2_OPEN_BUY" | "R2_FADE_CANDIDATE" | "R2_NO_SIGNAL";

// 판정 방향 표기 규격 (발주자 용어 확정판 8/13): ▲갭상승/▼갭하락+High/Low, △▽+Lean, ─ Flat, [E] 접두.
// "상방/하방"·"기울기" 표기 금지. 화면·문자·로그 3곳 동일 규격 — 이 함수가 유일 원천.
export function gradeLabel(grade: string, dir: "UP" | "DOWN" | null, isEvent: boolean): string {
  const e = isEvent ? "[E] " : "";
  if (grade === "High" || grade === "Low") return `${e}${dir === "UP" ? "▲ 갭상승" : "▼ 갭하락"} ${grade}`;
  if (grade === "Lean" && dir) return `${e}${dir === "UP" ? "△ 갭상승" : "▽ 갭하락"} Lean`;
  return `${e}─ Flat (무방향)`;
}

export type ActionLine = { code: ActionCode; line: string; phase: "가상" | "실사용"; dir?: "UP" | "DOWN" | null }; // dir = 갭하락 분리 채점 집계 키 (발주자 8/13 §2)

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
  grade?: { grade: string; lean_dir: "UP" | "DOWN" | null; lean_score: number },
  hasHoldings = false, // log-only 기간 무보유 전제 — 가상 보유 추적 도입 시 전일 미청산분 전달
): ActionLine {
  if (v.direction === "UP")
    return { ...fmt("T2_BUY", `매수 진입 (${v.size}·NXT 지정가·19:55까지 반전 감시)`, phase), dir: "UP" };
  if (v.direction === "DOWN") {
    // (a) 현상 유지 확정 (발주자 8/13): 신규 숏 없음 — 보유분 방어 전용 / 무보유 시 경계 발표
    if (hasHoldings)
      return { ...fmt("T2_SELL_HOLDINGS", `보유분 저녁 매도 (갭하락 방어·${v.size} 상당·NXT 지정가)`, phase), dir: "DOWN" };
    return { ...fmt("T2_DOWN_ALERT", `베팅 없음 — 갭하락 경계 (${v.confidence}·score ${v.expected_residual_gap != null ? "" : ""}신규 숏 수단 없음)`, phase), dir: "DOWN" };
  }
  // 4등급제: 베팅 없는 밤에도 판단은 항상 (베팅 문턱·사이징 불변)
  const why = v.abstain_reason ?? blocked ?? "θ 미달";
  // 등급-행동 축 분리 (발주자 확정 8/18): 점수가 High/Low 구간인데 트리거 조건(DC-PM·경제성·3자)에 막힌 밤은
  // 등급을 강등하지 않고 행동만 "베팅 없음 (사유)"로 적는다. 8/18 삼전 -4.35 = "▼ 갭하락 Low · 베팅 없음 (DC-PM 미달)".
  if ((grade?.grade === "High" || grade?.grade === "Low") && grade.lean_dir)
    return { ...fmt("T2_GRADE_NOBET", `베팅 없음 — ${grade.lean_dir === "UP" ? "갭상승" : "갭하락"} ${grade.grade} (score ${grade.lean_score >= 0 ? "+" : ""}${grade.lean_score}·${why})`, phase), dir: grade.lean_dir };
  if (grade?.grade === "Lean" && grade.lean_dir)
    return { ...fmt("T2_LEAN", `베팅 없음 — ${grade.lean_dir === "UP" ? "갭상승" : "갭하락"} Lean 발표 (score ${grade.lean_score >= 0 ? "+" : ""}${grade.lean_score}·${why})`, phase), dir: grade.lean_dir };
  return { ...fmt("T2_FLAT", `베팅 없음 — ${grade?.lean_dir ? (grade.lean_dir === "UP" ? "갭상승 Lean·" : "갭하락 Lean·") : "무방향·"}${why}`, phase), dir: grade?.lean_dir ?? null };
}

// ── R1 (아침 재판 — 스펙 G1B v0.3 §5 조정 매트릭스의 행동어 사상) ──
export function r1Action(
  g1a: { direction: string; entry_px: number | null; has_position?: boolean } | null,
  expectedOpen: number | null, sigmaPct: number, fairGapPct: number | null, phase: "가상" | "실사용",
): ActionLine & { residual_sigma: number | null } {
  // 포지션 근거 (발주자 확인 8/19 §1): 갭하락 판정(DOWN)은 8/13 행동어 개정으로 '신규 숏 없음' —
  // 가상 포지션이 없으므로 R1 조정 매트릭스(유지/축소/청산)의 대상이 아니다. 종전 코드는 DOWN을 숏 보유로
  // 오계상해 '절반 축소'를 냈다 (8/19 하닉 — 소급 정정). has_position은 T2 행동 코드가 T2_BUY·T2_SELL_HOLDINGS일 때만 true.
  const hasPos = g1a?.has_position ?? (g1a?.direction === "UP"); // 구 호출부 호환: UP만 매수 포지션
  if (!g1a || !hasPos || !g1a.entry_px || !expectedOpen) {
    const opp = fairGapPct != null && sigmaPct > 0 && Math.abs(fairGapPct) >= 1.2 * sigmaPct;
    const downAlert = g1a?.direction === "DOWN" ? " · 어제 갭하락 경계(무보유)" : "";
    return { ...fmt("R1_NOPOS_WATCH", `무포지션—기회 관찰${opp ? ` (|FairGap| ≥1.2σ 잔여분 후보)` : ""}${downAlert}`, phase), residual_sigma: null };
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
