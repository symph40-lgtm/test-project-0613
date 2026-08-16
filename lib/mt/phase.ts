// 국면 판별층 S1~S4 + 박스 자동 산출 — 스펙 SPEC_MT_v04.md §1.1·§3.3
// 출처: Hamilton(1989) 국면전환 모형의 규칙 기반 근사 (완전 마르코프 추정은 표본 요구 과다로 미채택 —
// 발주서 §1.1 명시). 4국면 구획은 Weinstein Stage 1~4 · Wyckoff 4국면과 동일 골격.

import { MT_CONFIG } from "./config";
import { clamp, maxHigh, minLow, r2, r3, realizedVol, recentExtreme, slopePct } from "./indicators";
import type { Bar, BoxState, PhaseKey, PhaseState } from "./types";

/** opts.noSqueeze: 국면 점수에서 변동성 수축 항(C6 경로)을 끈다 — 부검 절제 전용, 평시 미사용 */
export function computePhase(bars: Bar[], i: number, opts?: { noSqueeze?: boolean }): PhaseState {
  const c = MT_CONFIG.phase;
  const rv20 = realizedVol(bars, i, c.rvShort);
  const rv60 = realizedVol(bars, i, c.rvLong);
  const slope20 = slopePct(bars, i, c.slopeWindow);
  // 20거래일 지평으로 환산한 잡음 — 추세(20일 % 변화)와 같은 단위로 맞춘다
  const noise20 = rv20 != null ? (rv20 / Math.sqrt(252)) * Math.sqrt(c.slopeWindow) : null;
  const z = slope20 != null && noise20 && noise20 > 0 ? clamp(slope20 / noise20, -c.zClip, c.zClip) : null;
  const flat = z != null ? 1 - Math.min(1, Math.abs(z) / 1.0) : null;
  const squeeze = rv20 != null && rv60 ? rv20 / rv60 : null;
  const hh10 = i >= c.slopeWindow ? recentExtreme(bars, i, c.slopeWindow, c.newExtremeLookback, "high") : null;
  const ll10 = i >= c.slopeWindow ? recentExtreme(bars, i, c.slopeWindow, c.newExtremeLookback, "low") : null;
  const hi60 = maxHigh(bars, i, c.posWindow), lo60 = minLow(bars, i, c.posWindow);
  const pos60 = hi60 != null && lo60 != null && hi60 > lo60 ? (bars[i].close - lo60) / (hi60 - lo60) : null;
  const prev = bars[i - c.priorWindow]?.close;
  const r60 = prev > 0 ? ((bars[i].close - prev) / prev) * 100 : null;

  const inputs = {
    slope20: r2(slope20), z: r2(z), flat: r2(flat), squeeze: r2(squeeze),
    hh10: hh10 as 0 | 1 | null, ll10: ll10 as 0 | 1 | null,
    pos60: r2(pos60), r60: r2(r60), rv20: r2(rv20), rv60: r2(rv60),
  };

  // 재료가 하나라도 없으면 균등 확률로 두고 "판정 유보"를 상위에서 읽는다 (억지 국면 단정 금지)
  if (z == null || flat == null || hh10 == null || ll10 == null || pos60 == null || r60 == null) {
    const P = { S1: 0.25, S2: 0.25, S3: 0.25, S4: 0.25 };
    return { P, top: "S1", inputs };
  }

  const sq = opts?.noSqueeze ? 0 : squeeze != null && squeeze < c.squeezeIn ? 1 : 0;
  const score: Record<PhaseKey, number> = {
    S2: 1.2 * Math.max(z, 0) + 0.8 * hh10 + 0.4 * (2 * pos60 - 1),
    S4: 1.2 * Math.max(-z, 0) + 0.8 * ll10 + 0.4 * (1 - 2 * pos60),
    S1: 1.0 * flat + 0.8 * Math.min(1, Math.max(0, -r60) / 10) + 0.6 * (1 - ll10) + 0.4 * sq,
    S3: 1.0 * flat + 0.8 * Math.min(1, Math.max(0, r60) / 10) + 0.6 * (1 - hh10) + 0.4 * sq,
  };
  const keys: PhaseKey[] = ["S1", "S2", "S3", "S4"];
  const ex = keys.map((k) => Math.exp(score[k] / c.tau));
  const sum = ex.reduce((a, b) => a + b, 0);
  const P = {} as Record<PhaseKey, number>;
  keys.forEach((k, n) => { P[k] = r3(ex[n] / sum) as number; });
  const top = keys.reduce((a, b) => (P[b] > P[a] ? b : a), "S1" as PhaseKey);
  return { P, top, inputs };
}

/** 창 내 최고·최저 종가 (R2 눈금 통일 — 비교 대상이 종가이므로 기준선도 종가) */
function maxClose(bars: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  return Math.max(...bars.slice(i - n + 1, i + 1).map((b) => b.close));
}
function minClose(bars: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  return Math.min(...bars.slice(i - n + 1, i + 1).map((b) => b.close));
}

/**
 * 박스 자동 산출 — 2026-08-16 재설계 패키지 (docs/mt-redesign-prereg.md §1-A R2·R3, §1-B D1)
 *   R2 상·하단 = 창 내 최고/최저 **종가**
 *   D1 20일 유효 조건 = 폭 ≤ kBox × RV20의 20일 환산 (고정 % 폐기)
 *   R3 60일 박스는 표시 병기만 — 가격 확인 기준선(confirmLevels)에서 제외
 */
export function computeBox(bars: Bar[], i: number): BoxState {
  const B = MT_CONFIG.box;
  const close = bars[i].close;
  const side = (window: number, useHL: boolean) => {
    const high = useHL ? maxHigh(bars, i, window) : maxClose(bars, i, window);
    const low = useHL ? minLow(bars, i, window) : minClose(bars, i, window);
    if (high == null || low == null || !(close > 0)) return { high: 0, low: 0, valid: false, widthPct: 0 };
    return { high, low, valid: false, widthPct: r2(((high - low) / close) * 100) as number };
  };
  const useHL = (B.basis as string) === "hl";
  const n20 = side(B.n20.window, useHL);
  const rv20 = realizedVol(bars, i, 20);
  const noise20Pct = rv20 != null ? (rv20 / Math.sqrt(252)) * Math.sqrt(20) : null;   // 20일 지평 잡음(%)
  n20.valid = n20.high > 0 && noise20Pct != null && n20.widthPct <= B.kBox * noise20Pct;
  const n60 = side(B.n60.window, useHL);
  n60.valid = n60.high > 0 && n60.widthPct <= B.n60.maxWidth * 100;   // 표시 전용
  const primary = n20.valid ? 20 : null;   // R3: 60일은 기준선 대체 후보가 아니다
  const positionPct = n20.high > n20.low ? r2(((close - n20.low) / (n20.high - n20.low)) * 100) : null;
  return { n20, n60, primary, positionPct };
}

/** 가격 확인용 상·하단 — 20일 박스가 유효하면 그것, 아니면 20일 종가 고·저 (R3 대체 순서) */
export function confirmLevels(box: BoxState, bars: Bar[], i: number): { high: number; low: number; via: string } {
  if (box.primary === 20) return { high: box.n20.high, low: box.n20.low, via: "20일 박스" };
  const useHL = (MT_CONFIG.box.basis as string) === "hl";
  const hi = (useHL ? maxHigh(bars, i, 20) : maxClose(bars, i, 20)) ?? bars[i].close;
  const lo = (useHL ? minLow(bars, i, 20) : minClose(bars, i, 20)) ?? bars[i].close;
  return { high: hi, low: lo, via: useHL ? "20일 고·저가(박스 무효)" : "20일 종가 고·저(박스 무효)" };
}
