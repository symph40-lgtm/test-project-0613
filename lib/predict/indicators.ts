// 대가 모델 공용 지표 — 순수 함수, 외부 의존성 없음.

import type { PredictDailyBar, MinuteBar } from "./types";

export function sma(values: number[], len: number): number | null {
  if (values.length < len) return null;
  const s = values.slice(-len);
  return s.reduce((a, b) => a + b, 0) / len;
}

// ATR(n) — % 단위 (종가 대비). True Range에 전일 종가 갭 포함.
export function atrPct(bars: PredictDailyBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    trs.push((tr / b.close) * 100);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// 직전 n일 평균 일중폭 (원 단위) — 피셔 오프셋용
export function avgRange(bars: PredictDailyBar[], n = 10): number | null {
  if (bars.length < n) return null;
  const s = bars.slice(-n);
  return s.reduce((a, b) => a + (b.high - b.low), 0) / n;
}

// 고변동일 판별 (2026-07-25, 하닉 트레일 반전 전용): 오늘 진입 시점의 vol10(10일 평균폭 / 전일
// 종가 %)이 과거 60거래일 vol10의 추적 66.7분위 이상인가. 경계 선견 없음 — 완결 일봉만 사용.
export function isHighVolDay(complete: PredictDailyBar[]): boolean {
  if (complete.length < 75) return false;
  const vols: number[] = [];
  for (let j = complete.length - 60; j < complete.length; j++) {
    const r = avgRange(complete.slice(0, j), 10);
    const prev = complete[j - 1];
    if (r !== null && prev) vols.push((r / prev.close) * 100);
  }
  const rToday = avgRange(complete, 10);
  const last = complete[complete.length - 1];
  if (vols.length < 40 || rToday === null || !last) return false;
  const sorted = [...vols].sort((a, b) => a - b);
  return (rToday / last.close) * 100 >= sorted[Math.floor((2 * sorted.length) / 3)];
}

// NR(n): 전일 레인지가 직전 n일 중 최소인가 (ext-modules 1.2와 동일 정의)
export function isNR(bars: PredictDailyBar[], n: number): boolean {
  if (bars.length < n) return false;
  const s = bars.slice(-n);
  const last = s[s.length - 1];
  const lastRange = last.high - last.low;
  return s.every((b) => b.high - b.low >= lastRange);
}

// 인사이드바: 전일이 전전일 레인지 안
export function isInsideBar(bars: PredictDailyBar[]): boolean {
  if (bars.length < 2) return false;
  const a = bars[bars.length - 2];
  const b = bars[bars.length - 1];
  return b.high < a.high && b.low > a.low;
}

// 크레이블 Stretch: 직전 n일 min(|시가-고가|, |시가-저가|) 평균 (원 단위)
export function crabelStretch(bars: PredictDailyBar[], n = 10): number | null {
  if (bars.length < n) return null;
  const s = bars.slice(-n);
  return s.reduce((a, b) => a + Math.min(Math.abs(b.open - b.high), Math.abs(b.open - b.low)), 0) / n;
}

export function minuteAtOrBefore(bars: MinuteBar[], hhmm: string): MinuteBar | null {
  let found: MinuteBar | null = null;
  for (const b of bars) {
    if (b.time <= hhmm) found = b;
    else break;
  }
  return found;
}

export function hi(bars: MinuteBar[]): number {
  return Math.max(...bars.map((b) => b.high));
}
export function lo(bars: MinuteBar[]): number {
  return Math.min(...bars.map((b) => b.low));
}
