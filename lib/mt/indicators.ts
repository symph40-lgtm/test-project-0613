// MT 순수 지표 계산 — 외부 I/O 없음. 라이브·60일 백필·3년 소급이 이 함수들을 공유한다.
// 여기 있는 함수는 전부 (bars, idx) 형태 = "그날까지만 보고" 산출한다 — 룩어헤드 차단이 목적.

import type { Bar } from "./types";

export const r2 = (v: number | null): number | null => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
export const r3 = (v: number | null): number | null => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** 0~1 정규화: x가 lo일 때 0, hi일 때 1 */
export const ramp = (x: number, lo: number, hi: number) => (hi === lo ? 0 : clamp((x - lo) / (hi - lo), 0, 1));

export function median(xs: number[]): number | null {
  const a = xs.filter((x) => isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** 일간 수익률 % (bars[i] 기준, 전일 종가 대비) */
export function ret(bars: Bar[], i: number): number | null {
  if (i < 1) return null;
  const p = bars[i - 1].close;
  return p > 0 ? ((bars[i].close - p) / p) * 100 : null;
}

/** 실현변동성 % (연율) — n일 일간 로그수익률 표준편차 × √252 */
export function realizedVol(bars: Bar[], i: number, n: number): number | null {
  if (i < n) return null;
  const rs: number[] = [];
  for (let k = i - n + 1; k <= i; k++) {
    const p = bars[k - 1]?.close, c = bars[k]?.close;
    if (!(p > 0) || !(c > 0)) return null;
    rs.push(Math.log(c / p));
  }
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  const v = rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

/** OLS 기울기(가격/일) — 최근 n일 종가 */
export function slope(bars: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  const ys = bars.slice(i - n + 1, i + 1).map((b) => b.close);
  const xm = (n - 1) / 2;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, k) => { num += (k - xm) * (y - ym); den += (k - xm) ** 2; });
  return den ? num / den : null;
}

/** 20일 기울기가 만든 % 변화 (스펙 §1.1 slope20) */
export function slopePct(bars: Bar[], i: number, n: number): number | null {
  const s = slope(bars, i, n);
  const c = bars[i]?.close;
  return s != null && c > 0 ? (s * n) / c * 100 : null;
}

export function maxHigh(bars: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  return Math.max(...bars.slice(i - n + 1, i + 1).map((b) => b.high));
}
export function minLow(bars: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  return Math.min(...bars.slice(i - n + 1, i + 1).map((b) => b.low));
}

/** bars[i]가 n일 신고가/신저가인가 (종가 기준 — 갱신 여부 판정) */
export function isNewHigh(bars: Bar[], i: number, n: number): boolean {
  if (i < n) return false;
  return bars[i].close >= Math.max(...bars.slice(i - n + 1, i + 1).map((b) => b.close));
}
export function isNewLow(bars: Bar[], i: number, n: number): boolean {
  if (i < n) return false;
  return bars[i].close <= Math.min(...bars.slice(i - n + 1, i + 1).map((b) => b.close));
}
/** 최근 lookback일 안에 n일 신고가(신저가)가 한 번이라도 났는가 */
export function recentExtreme(bars: Bar[], i: number, n: number, lookback: number, dir: "high" | "low"): 0 | 1 {
  for (let k = Math.max(n, i - lookback + 1); k <= i; k++) {
    if (dir === "high" ? isNewHigh(bars, k, n) : isNewLow(bars, k, n)) return 1;
  }
  return 0;
}

/** 상승일·하락일 평균 거래량 (창 [i-n+1, i]) */
export function volByDirection(bars: Bar[], i: number, n: number): { up: number | null; down: number | null } {
  const ups: number[] = [], downs: number[] = [];
  for (let k = Math.max(1, i - n + 1); k <= i; k++) {
    const r = ret(bars, k);
    if (r == null) continue;
    (r > 0 ? ups : r < 0 ? downs : ups).push(bars[k].volume);
  }
  return { up: mean(ups), down: mean(downs) };
}

/** CLV = (close−low)/(high−low), 창 평균 */
export function clvAvg(bars: Bar[], i: number, n: number): number | null {
  const xs: number[] = [];
  for (let k = Math.max(0, i - n + 1); k <= i; k++) {
    const b = bars[k];
    if (b.high > b.low) xs.push((b.close - b.low) / (b.high - b.low));
  }
  return mean(xs);
}

/** 단순 회귀 기울기 β (y ~ x) — 절편 포함 */
export function regressBeta(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const xm = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const ym = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let k = 0; k < n; k++) { num += (xs[k] - xm) * (ys[k] - ym); den += (xs[k] - xm) ** 2; }
  return den > 0 ? num / den : null;
}

/** 스피어만 순위상관 (IC·부품 쌍 상관용) */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const rank = (a: number[]) => {
    const idx = a.map((v, k) => ({ v, k })).sort((p, q) => p.v - q.v);
    const r = new Array(a.length).fill(0);
    for (let k = 0; k < idx.length;) {
      let j = k;
      while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
      const avg = (k + j) / 2 + 1;
      for (let t = k; t <= j; t++) r[idx[t].k] = avg;
      k = j + 1;
    }
    return r;
  };
  const rx = rank(xs.slice(0, n)), ry = rank(ys.slice(0, n));
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let k = 0; k < n; k++) { num += (rx[k] - mx) * (ry[k] - my); dx += (rx[k] - mx) ** 2; dy += (ry[k] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}
