// G1A v0.3 판정 엔진 — 스펙 §5. 순수 함수: 입력(피처+시각+컨텍스트) → 판정. 미래 정보 참조 금지.

import { G1A_CONFIG } from "./config";
import type { AbstainCheck, Direction, G1ASymbol, T2Features, T2Verdict } from "./types";

const C = G1A_CONFIG;
// s_i 표준화 (v0.2 §5.1.1): 연속 피처 → tanh(값/σ상수), [−1,+1]. σ상수는 로그 20일 후 롤링 z로 전환.
const sq = (v: number | null, scale: number): number => (v == null ? 0 : Math.tanh(v / scale));
const clip = (x: number, c: number) => Math.max(-c, Math.min(c, x));

// ── GapScore (v0.2 §5.1 이층 구조: BiasGate × Σ w_i·s_i, 그룹 캡) ──
export function gapScore(f: T2Features): { score: number; gate: number; l1: number; l2: number; l3: number; l4: number } {
  const W = C.weights, S = C.scales;
  // L1 근접대리 (T2 캡 ±3.5)
  const l1 = clip(
    W.F21 * sq(f.F21_basket, S.basketPct) +
    W.F22 * sq(f.F22_usfut, S.usfutPct) +
    W.F20 * sq(f.F20_europe, S.europePct) +
    W.F11p * sq(f.F11p_tsmc_resid, S.tsmcResidPct),
    C.caps.l1T2,
  );
  // L2 당일 캐릭터 (캡 ±2.0)
  const clv = f.F01_clv == null ? 0 : clip((f.F01_clv - 0.5) / S.clvHalfWidth, 1);
  const o1 = f.F04_o1 == null ? 0 : f.F04_o1 === "OD_up" ? 1 : f.F04_o1 === "OD_down" ? -1 : 0;
  const l2 = clip(W.F01 * clv + W.F02 * sq(f.F02_dc1, S.dc1) + W.F04 * o1 + W.F09 * (f.F09_c1 ?? 0), C.caps.l2);
  // L3 수급 (캡 ±1.5)
  const l3 = clip(W.F08 * sq(f.F08_frn_decel, S.frnDecel) + W.F05 * (f.F05_w1 ?? 0) + W.F07 * (f.F07_b1_z ?? 0), C.caps.l3);
  // L4 매크로 가산 (캡 ±1.0) — 금리↑·원화약세 = 역풍. z는 이미 표준화돼 있어 tanh(z)만.
  const l4Macro = clip(-W.F13 * sq(f.F13_rate_z, 1) - W.F14 * sq(f.F14_fx_z, 1), C.caps.l4);
  const l4 = l4Macro + clip(f.F24_news ?? 0, C.weights.F24cap);
  const sum = l1 + l2 + l3 + l4;
  // BiasGate (v0.2 §5.1.1 원 정의): 매크로 사슬 합성 z(갭 방향 기준) vs 가산부 Σ
  const zs = [f.F13_rate_z, f.F14_fx_z].filter((z): z is number => z != null);
  const macroComposite = zs.length ? zs.reduce((a, z) => a - z, 0) / zs.length : 0; // 금리↑·원화약세=하방이므로 −z
  const gate =
    Math.abs(macroComposite) < C.biasGate.neutralBand || sum === 0 ? C.biasGate.neutral
    : Math.sign(macroComposite) === Math.sign(sum) ? C.biasGate.agree
    : C.biasGate.conflict;
  return { score: sum * gate, gate, l1, l2, l3, l4 };
}

// ── T1 가상 GapScore (v0.2 §5.1.2 T1 열 — §7 스냅샷 기록 전용) ──
export type T1Inputs = {
  tsmcRaw: number | null; nqAsia: number | null;
  clv: number | null; dc1: number | null; o1: T2Features["F04_o1"];
  frnDecel: number | null; rateZ: number | null; fxZ: number | null;
};
export function gapScoreT1(t: T1Inputs): number {
  const W = C.weightsT1, S = C.scales;
  const l1 = clip(W.F11_raw * sq(t.tsmcRaw, S.tsmcRawPct) + W.F10_nq * sq(t.nqAsia, S.nqAsiaPct), C.caps.l1T1);
  const clv = t.clv == null ? 0 : clip((t.clv - 0.5) / S.clvHalfWidth, 1);
  const o1 = t.o1 == null ? 0 : t.o1 === "OD_up" ? 1 : t.o1 === "OD_down" ? -1 : 0;
  const l2 = clip(W.F01 * clv + W.F02 * sq(t.dc1, S.dc1) + W.F04 * o1, C.caps.l2);
  const l3 = clip(W.F08 * sq(t.frnDecel, S.frnDecel), C.caps.l3);
  const l4 = clip(-W.F13 * sq(t.rateZ, 1) - W.F14 * sq(t.fxZ, 1), C.caps.l4);
  const sum = l1 + l2 + l3 + l4;
  const zs = [t.rateZ, t.fxZ].filter((z): z is number => z != null);
  const comp = zs.length ? zs.reduce((a, z) => a - z, 0) / zs.length : 0;
  const gate = Math.abs(comp) < C.biasGate.neutralBand || sum === 0 ? 1.0 : Math.sign(comp) === Math.sign(sum) ? 1.25 : 0.5;
  return Math.round(sum * gate * 100) / 100;
}

// ── θ(t) (§5.3) ──
export function thetaAt(hhmm: string): { high: number; low: number } {
  for (const t of C.theta) if (hhmm < t.until) return { high: t.high, low: t.low };
  return { high: C.theta[C.theta.length - 1].high, low: C.theta[C.theta.length - 1].low };
}

// ── 예상잔여갭 (§4.1) ──
export function expectedResidualGap(symbol: G1ASymbol, rBasket: number | null, rNxt: number | null): number | null {
  if (rBasket == null) return null;
  return C.basket[symbol].betaPm * rBasket - (rNxt ?? 0);
}

export function roundTripCost(spreadPct: number | null): number {
  const c = C.cost;
  return (spreadPct ?? c.defaultSpread) + c.feesRoundTrip + c.sellTax + c.slippageBuffer;
}

// ── 판정 보류 (§5.6) — 점수보다 우선 ──
export type AbstainCtx = {
  dateKst: string;                 // 판정일 (저녁 D)
  weekday: number;                 // 0=일…5=금
  eventTonight: string | null;     // FOMC/CPI/고용/반도체 실적
  impliedMoveRatio: number | null; // 미조달 → null
  circuitBreaker: boolean;         // 당일 또는 전일 KOSPI 일중 -8%
  expiryToday: boolean;            // 선물옵션 만기일 (매월 둘째 목요일)
};

function nextDayIsKrHoliday(dateKst: string): boolean {
  const d = new Date(dateKst + "T00:00:00+09:00");
  d.setDate(d.getDate() + 1);
  const next = d.toISOString().slice(0, 10);
  return (C.abstain.krHolidays as readonly string[]).includes(next);
}

export function abstainReason(f: T2Features, ctx: AbstainCtx): AbstainCheck {
  const A = C.abstain;
  if (ctx.eventTonight) return { reason: `보류1 바이너리 이벤트 밤(${ctx.eventTonight})` };
  if (ctx.impliedMoveRatio != null && ctx.impliedMoveRatio >= 1.5) return { reason: "보류1 implied move 1.5배+" };
  if (ctx.weekday === 5) return { reason: "보류2 금요일(주말 보유 금지)" };
  if (nextDayIsKrHoliday(ctx.dateKst)) return { reason: "보류2 한국 연휴 전일" };
  if ((A.usHolidays as readonly string[]).includes(ctx.dateKst) || (A.usHalfDays as readonly string[]).includes(ctx.dateKst))
    return { reason: "보류3 미국 휴장·반일장 밤" };
  if (ctx.expiryToday) return { reason: "보류4 선물옵션 만기일 D+1 갭" };
  if ((A.msciRebalance as readonly string[]).includes(ctx.dateKst)) return { reason: "보류4 MSCI 리밸런싱일 D+1" };
  if (ctx.circuitBreaker) return { reason: "보류5 서킷브레이커 당일·익일" };
  const missing = C.coreFeatures.filter((k) => f[k as keyof T2Features] == null);
  if (missing.length >= 2) return { reason: `보류7 핵심 피처 결측 ${missing.length}개`, detail: missing.join(",") };
  return { reason: null };
}

// 선물옵션 만기 = 매월 둘째 목요일 (KST)
export function isExpiryDay(dateKst: string): boolean {
  const d = new Date(dateKst + "T00:00:00+09:00");
  if (d.getDay() !== 4) return false;
  return d.getDate() >= 8 && d.getDate() <= 14;
}

// ── 유동성 게이트 (§5.4) ──
export function liquidityGate(spreadPct: number | null): T2Verdict["liquidity"] {
  if (spreadPct == null) return "unknown"; // 호가 API 부재 — 기록만, 강등하지 않음 (log-only)
  if (spreadPct <= C.liquidity.normalMax) return "normal";
  if (spreadPct <= C.liquidity.downgradeMax) return "downgrade";
  return "hold";
}

// ── T2 평가 (§5.1 조기 트리거 / §5.2 최종) ──
export function evaluateT2(
  symbol: G1ASymbol,
  f: T2Features,
  ctx: AbstainCtx,
  hhmm: string,
  isFinal: boolean,
  otherSymbolTriggered: boolean, // §5.3 합산 익스포저
): { verdict: T2Verdict; blocked: string | null } {
  const gs = gapScore(f);
  const th = thetaAt(hhmm);
  const resid = expectedResidualGap(symbol, f.F21_basket, f.r_nxt);
  const econ = resid == null ? null : Math.abs(resid) - roundTripCost(f.spread_pct) >= C.trigger.minEconomicsPct;
  const signs = [f.F20_europe, f.F22_usfut, f.F21_basket].map((v) => (v == null ? 0 : Math.sign(v)));
  const threeWay = signs.every((s) => s !== 0) ? (signs[0] === signs[1] && signs[1] === signs[2]) : false;
  const liq = liquidityGate(f.spread_pct);

  const base: T2Verdict = {
    direction: "NEUTRAL", confidence: null, size: "0",
    abstain_reason: null, gap_score: Math.round(gs.score * 100) / 100, bias_gate: gs.gate,
    theta_applied: null, dc_pm: f.F21_dcpm, r_basket: f.F21_basket, r_nxt_pre_entry: f.r_nxt,
    expected_residual_gap: resid == null ? null : Math.round(resid * 100) / 100,
    economics_pass: econ, three_way_agree: threeWay, liquidity: liq,
  };

  // abstain 우선 (§5.6)
  const ab = abstainReason(f, ctx);
  if (ab.reason) return { verdict: { ...base, abstain_reason: ab.reason }, blocked: ab.reason };

  // §5.1 전 조건 — 미충족 사유를 blocked에 남긴다 (평가 궤적 기록용)
  const checks: [boolean, string][] = [
    [(f.F21_obs_min ?? 0) >= C.trigger.minPmObsMin && (f.F20_obs_min ?? 0) >= C.trigger.minEuObsMin, "관측 부족"],
    [(f.F21_dcpm ?? 0) >= C.trigger.minDcPm, "DC-PM 미달"],
    [Math.abs(f.F21_basket ?? 0) >= C.trigger.minBasketAbs, "크기 미달"],
    [threeWay, "3자 불일치"],
    [econ === true, "경제성 미달"],
    [liq !== "hold", "유동성 보류"],
  ];
  for (const [ok, why] of checks) {
    if (!ok && !isFinal) return { verdict: base, blocked: why };
    if (!ok && isFinal) return { verdict: base, blocked: `T2-F ${why} → Flat 확정` };
  }

  const abs = Math.abs(gs.score);
  const dir: Direction = gs.score > 0 ? "UP" : "DOWN";
  const dcOk = (f.F21_dcpm ?? 0) >= C.trigger.minDcPm;
  let conf: T2Verdict["confidence"] = null;
  let size: T2Verdict["size"] = "0";
  if (abs >= th.high && dcOk) { conf = "High"; size = "1/3"; }
  else if (abs >= th.low) { conf = "Low"; size = "1/6"; }
  else return { verdict: base, blocked: isFinal ? `θ 미달(${abs.toFixed(1)}<${th.low}) → Flat 확정` : `θ 미달` };

  if (liq === "downgrade" && size === "1/3") { size = "1/6"; conf = "Low"; }        // §5.4
  if (otherSymbolTriggered && size === "1/3") { size = "1/6"; conf = "Low"; }        // §5.3 합산 상한

  return {
    verdict: { ...base, direction: dir, confidence: conf, size, theta_applied: conf === "High" ? th.high : th.low },
    blocked: null,
  };
}

// ── T2 4등급 (발주자 8/12 "판정은 항상, 베팅은 조건부") ──
// High/Low = 기존 진입 등급 (문턱·사이징 불변 — 검증 오염 없음)
// Lean = 베팅 없음 + 방향 기울기 발표 (|score| ≥ leanMin·비무방향) / Flat = 무방향 또는 이벤트 밤
export const LEAN_MIN = 0.5; // 초기값 — Lean 채점(계기판)으로 재조정
export function t2Grade(v: { direction: string; confidence: string | null; gap_score: number; abstain_reason: string | null }):
  { grade: "High" | "Low" | "Lean" | "Flat"; lean_dir: "UP" | "DOWN" | null; lean_score: number } {
  if (v.direction === "UP" || v.direction === "DOWN")
    return { grade: v.confidence === "High" ? "High" : "Low", lean_dir: v.direction, lean_score: v.gap_score };
  const dir = v.gap_score >= LEAN_MIN ? "UP" : v.gap_score <= -LEAN_MIN ? "DOWN" : null;
  const isEvent = (v.abstain_reason ?? "").startsWith("보류1") || (v.abstain_reason ?? "").includes("이벤트");
  return { grade: dir && !isEvent ? "Lean" : "Flat", lean_dir: dir, lean_score: v.gap_score };
}

// ── 반전 감시 (§5.5) ──
export function reversalCheck(entryDir: Direction, f: T2Features): { fired: boolean; why: string | null } {
  const gs = gapScore(f);
  if (entryDir !== "NEUTRAL" && gs.score !== 0 && Math.sign(gs.score) !== (entryDir === "UP" ? 1 : -1))
    return { fired: true, why: `GapScore 부호 반전(${gs.score.toFixed(1)})` };
  if ((f.F21_dcpm ?? 1) < C.reversal.dcPmCollapse)
    return { fired: true, why: `DC-PM 붕괴(${Math.round((f.F21_dcpm ?? 0) * 100)}%)` };
  return { fired: false, why: null };
}
