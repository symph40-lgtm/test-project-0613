// G1A v0.3 판정 엔진 — 스펙 §5. 순수 함수: 입력(피처+시각+컨텍스트) → 판정. 미래 정보 참조 금지.

import { G1A_CONFIG } from "./config";
import type { AbstainCheck, Direction, G1ASymbol, T2Features, T2Verdict } from "./types";

const C = G1A_CONFIG;
const sgn = (v: number | null, t: number): number => (v == null ? 0 : v >= t ? 1 : v <= -t ? -1 : 0);

// ── GapScore (§4.2) ──
export function gapScore(f: T2Features): { score: number; gate: number; l1: number; l2: number; l3: number; l4: number } {
  const W = C.weights, T = C.thresh;
  // L1 근접대리
  const l1 =
    W.F21 * sgn(f.F21_basket, T.basketPct) +
    W.F22 * sgn(f.F22_usfut, T.usfutPct) +
    W.F20 * sgn(f.F20_europe, T.europePct) +
    W.F11p * sgn(f.F11p_tsmc_resid, T.tsmcResidPct);
  // L2 당일 캐릭터
  const clv = f.F01_clv == null ? 0 : f.F01_clv >= T.clvHigh ? 1 : f.F01_clv <= T.clvLow ? -1 : 0;
  const o1 = f.F04_o1 == null ? 0 : f.F04_o1 === "OD_up" ? 1 : f.F04_o1 === "OD_down" ? -1 : 0;
  const l2 = W.F01 * clv + W.F02 * sgn(f.F02_dc1, T.dc1) + W.F04 * o1 + W.F09 * (f.F09_c1 ?? 0);
  // L3 수급
  const l3 = W.F08 * sgn(f.F08_frn_decel, T.frnDecel) + W.F05 * (f.F05_w1 ?? 0) + W.F07 * (f.F07_b1_z ?? 0);
  // L4 매크로 — 금리↑·원화약세 = 역풍 (음수 기여), 합산 캡 ±1.0 (스펙 명시)
  let l4 = -W.F13 * sgn(f.F13_rate_z, T.zAbs) - W.F14 * sgn(f.F14_fx_z, T.zAbs);
  l4 += Math.max(-C.weights.F24cap, Math.min(C.weights.F24cap, f.F24_news ?? 0));
  l4 = Math.max(-C.l4Cap, Math.min(C.l4Cap, l4));
  // BiasGate (재구성 정의 — config 주석): L2 방향 vs L1 방향
  const gate = l1 !== 0 && l2 !== 0
    ? (Math.sign(l1) === Math.sign(l2) ? C.biasGate.agree : C.biasGate.conflict)
    : C.biasGate.neutral;
  return { score: (l1 + l2 + l3 + l4) * gate, gate, l1, l2, l3, l4 };
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
    if (!ok && isFinal) return { verdict: base, blocked: `T2-F ${why} → NEUTRAL 확정` };
  }

  const abs = Math.abs(gs.score);
  const dir: Direction = gs.score > 0 ? "UP" : "DOWN";
  const dcOk = (f.F21_dcpm ?? 0) >= C.trigger.minDcPm;
  let conf: T2Verdict["confidence"] = null;
  let size: T2Verdict["size"] = "0";
  if (abs >= th.high && dcOk) { conf = "High"; size = "1/3"; }
  else if (abs >= th.low) { conf = "Low"; size = "1/6"; }
  else return { verdict: base, blocked: isFinal ? `θ 미달(${abs.toFixed(1)}<${th.low}) → NEUTRAL 확정` : `θ 미달` };

  if (liq === "downgrade" && size === "1/3") { size = "1/6"; conf = "Low"; }        // §5.4
  if (otherSymbolTriggered && size === "1/3") { size = "1/6"; conf = "Low"; }        // §5.3 합산 상한

  return {
    verdict: { ...base, direction: dir, confidence: conf, size, theta_applied: conf === "High" ? th.high : th.low },
    blocked: null,
  };
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
