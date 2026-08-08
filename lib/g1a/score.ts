// G1A 판정 엔진 — 스펙 §5. 백테스트와 라이브가 이 함수 하나를 공유한다.
// 여기서 미래 정보를 절대 참조하지 않는다: 입력은 판정 시점(15:10/19:40)까지의 피처뿐.

import { G1A_CONFIG } from "./config";
import type { FeatureSign, G1AFeatures, G1AVerdict, SizeBand } from "./types";

const T = G1A_CONFIG.thresh;
const band = (v: number | null, hi: number, lo: number): FeatureSign =>
  v == null ? null : v >= hi ? 1 : v <= lo ? -1 : 0;
const sym = (v: number | null, t: number, invert = false): FeatureSign =>
  v == null ? null : v >= t ? (invert ? -1 : 1) : v <= -t ? (invert ? 1 : -1) : 0;

const cap = (x: number, c: number) => Math.max(-c, Math.min(c, x));
const sum = (xs: FeatureSign[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

export function featureSigns(f: G1AFeatures) {
  return {
    F01: band(f.F01_clv, T.clvHigh, T.clvLow),
    F02: sym(f.F02_dc1, T.dc1),
    F04: f.F04_o1 == null ? null : f.F04_o1 === "OD_up" ? 1 : f.F04_o1 === "OD_down" ? -1 : 0,
    F08: sym(f.F08_frn_decel, T.frnDecel),
    F10: sym(f.F10_nq_asia, T.nqAsia),
    F11: sym(f.F11_tsmc, T.tsmc),
    F12: sym(f.F12_asia_idx, T.asiaIdx),
    F13: sym(f.F13_ust10y_bp, T.ust10yBp, true), // 금리 상승 = 기술주 역풍
    F14: sym(f.F14_usdkrw, T.usdkrw, true),      // 원화 약세 = 역풍
    F20: sym(f.F20_europe, 0.3),
    F21: sym(f.F21_us_pre_semi, 0.5),
  } as Record<string, FeatureSign>;
}

// §5.3 판정 보류 — 점수보다 우선하는 상위 규칙. 순서 자체가 우선순위다.
export type AbstainCtx = {
  weekday: number;              // 0=일 … 5=금
  eventTonight: string | null;  // F15
  impliedMoveRatio: number | null; // F16 (미조달이면 null)
  posExtreme: boolean | null;   // F17
  circuitBreakerToday: boolean;
  circuitBreakerYesterday: boolean;
};

export function abstainReason(f: G1AFeatures, ctx: AbstainCtx): string | null {
  if (ctx.eventTonight) return `보류1 바이너리 이벤트 밤 (${ctx.eventTonight})`;
  if (ctx.impliedMoveRatio != null && ctx.impliedMoveRatio >= 1.5) return "보류1 implied move 1.5배 초과";
  if (ctx.weekday === 5) return "보류2 금요일 (주말 보유 금지)";
  if (ctx.circuitBreakerToday || ctx.circuitBreakerYesterday) return "보류4 서킷브레이커 발동일/익일";
  const missing = G1A_CONFIG.coreFeatures.filter((k) => f[k] == null);
  if (missing.length >= 2) return `보류5 핵심 피처 결측 ${missing.length}개 (${missing.join(",")})`;
  return null;
}

// 크기 예측 — 방향과 별도 (§3 크기 구간). 변동성 압축(F03)과 글로벌 진폭으로 추정한다.
function sizeBand(f: G1AFeatures): SizeBand {
  const amp = Math.max(Math.abs(f.F10_nq_asia ?? 0), Math.abs(f.F11_tsmc ?? 0) / 2);
  const compressed = f.F03_n1 != null;
  if (amp >= 1.2 || (compressed && amp >= 0.8)) return "L";
  if (amp >= 0.6 || compressed) return "M";
  return "S";
}

export function scoreG1A(f: G1AFeatures, ctx: AbstainCtx): G1AVerdict {
  const s = featureSigns(f);
  const groups = {
    character: cap(sum([s.F01, s.F02, s.F04]), G1A_CONFIG.caps.character),
    flow: cap(sum([s.F08]), G1A_CONFIG.caps.flow),
    global: cap(sum([s.F10, s.F11, s.F12, s.F13, s.F14, s.F20, s.F21]), G1A_CONFIG.caps.global),
    positioning: 0, // F17 미조달 — 스펙상 방향 반전 요인으로만 쓰이므로 0 고정
  };
  const gapScore = groups.character + groups.flow + groups.global + groups.positioning;
  const missingCore = G1A_CONFIG.coreFeatures.filter((k) => f[k] == null);

  const reason = abstainReason(f, ctx);
  if (reason) {
    return { direction: "NEUTRAL", confidence: null, size: "0", sizeBand: null, abstainReason: reason, gapScore, groups, missingCore };
  }

  const { highAbs, lowAbs } = G1A_CONFIG.verdict;
  const dc1Up = (f.F02_dc1 ?? 0) >= T.dc1, dc1Down = (f.F02_dc1 ?? 0) <= -T.dc1;
  let direction: G1AVerdict["direction"] = "NEUTRAL";
  let confidence: G1AVerdict["confidence"] = null;
  let size: G1AVerdict["size"] = "0";
  if (gapScore >= highAbs && dc1Up) { direction = "UP"; confidence = "High"; size = "1/3"; }
  else if (gapScore >= lowAbs) { direction = "UP"; confidence = "Low"; size = "1/6"; }
  else if (gapScore <= -highAbs && dc1Down) { direction = "DOWN"; confidence = "High"; size = "1/3"; }
  else if (gapScore <= -lowAbs) { direction = "DOWN"; confidence = "Low"; size = "1/6"; }

  // §5.3-3 포지셔닝 극단 + 뉴스 동방향 → 사이징 1단계 강등 (F17 미조달이라 현재는 발동 없음)
  if (ctx.posExtreme && direction !== "NEUTRAL" && size === "1/3") { size = "1/6"; confidence = "Low"; }

  return { direction, confidence, size, sizeBand: direction === "NEUTRAL" ? null : sizeBand(f), abstainReason: null, gapScore, groups, missingCore };
}

// §3 라벨화
export function labelDirection(l1Pct: number): "UP" | "DOWN" | "FLAT" {
  const b = G1A_CONFIG.label.flatBand;
  return l1Pct >= b ? "UP" : l1Pct <= -b ? "DOWN" : "FLAT";
}
export function labelSize(l1Pct: number): SizeBand {
  const a = Math.abs(l1Pct), c = G1A_CONFIG.label;
  return a >= c.sizeL ? "L" : a >= c.sizeM ? "M" : a >= c.sizeS ? "S" : null;
}
