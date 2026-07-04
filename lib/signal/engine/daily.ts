// 일봉 파생 계산 — 누적 등락(L6·S1)·ATR14(A1)·NR7/NR4+IB(N1)·갭.
// bars는 오래된 것 → 최신 순. excludeToday=true면 마지막 봉이 오늘(장중 미확정)일 때 제외.

import { SIGNAL_CONFIG } from "../config";
import type { DailyBar } from "../types";

function effective(bars: DailyBar[], excludeToday: boolean, today?: string): DailyBar[] {
  if (!excludeToday || bars.length === 0) return bars;
  const t = today ?? kstToday();
  return bars[bars.length - 1].date === t ? bars.slice(0, -1) : bars;
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 직전 n일 누적 등락률 % (오늘 제외 옵션) — L6 과대낙폭·S1 과열
export function cumReturnPct(bars: DailyBar[], n: number, excludeToday = false): number | null {
  const b = effective(bars, excludeToday);
  if (b.length < n + 1) return null;
  const start = b[b.length - 1 - n].close;
  const end = b[b.length - 1].close;
  if (!isFinite(start) || start === 0) return null;
  return ((end - start) / start) * 100;
}

// 직전 1~3일 중 최악의 누적 낙폭 % — 분기1·XS1 판정용
export function worstCumDeclinePct(bars: DailyBar[], excludeToday = true): number | null {
  const vals = [1, 2, 3]
    .map((n) => cumReturnPct(bars, n, excludeToday))
    .filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return Math.min(...vals);
}

// 연속 상승 일수 (최신부터 거슬러) — S1 과열
export function consecutiveUpDays(bars: DailyBar[], excludeToday = true): number {
  const b = effective(bars, excludeToday);
  let cnt = 0;
  for (let i = b.length - 1; i > 0; i--) {
    if (b[i].close > b[i - 1].close) cnt++;
    else break;
  }
  return cnt;
}

// ATR14 (%, 종가 대비) — A1 스탑 산출
export function atr14Pct(bars: DailyBar[], excludeToday = true): number | null {
  const b = effective(bars, excludeToday);
  if (b.length < 15) return null;
  const trs: number[] = [];
  for (let i = b.length - 14; i < b.length; i++) {
    const cur = b[i], prev = b[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr / prev.close);
  }
  return (trs.reduce((s, v) => s + v, 0) / trs.length) * 100;
}

// N1 — NR7 / NR4+IB (확장기획서 1장). 전일 봉 기준.
export function nr7Flags(bars: DailyBar[], excludeToday = true): { nr7: boolean; nr4Ib: boolean } | null {
  const b = effective(bars, excludeToday);
  const lb = SIGNAL_CONFIG.ext.n1.lookback;
  if (b.length < lb + 1) return null;
  const range = (bar: DailyBar) => bar.high - bar.low;
  const last = b[b.length - 1];
  const win7 = b.slice(b.length - lb);
  const nr7 = range(last) === Math.min(...win7.map(range));
  const win4 = b.slice(b.length - SIGNAL_CONFIG.ext.n1.nr4Lookback);
  const nr4 = range(last) === Math.min(...win4.map(range));
  const prev = b[b.length - 2];
  const ib = last.high < prev.high && last.low > prev.low; // inside bar
  return { nr7, nr4Ib: nr4 && ib };
}

// 당일 갭 % — 오늘 봉(시가) vs 전일 종가. 오늘 봉이 아직 없으면 실시간 시세로 대체 계산.
export function gapPct(bars: DailyBar[], todayFirstPx?: number | null): number | null {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const today = kstToday();
  if (last.date === today) {
    const prev = bars[bars.length - 2];
    return ((last.open - prev.close) / prev.close) * 100;
  }
  // 오늘 봉 미생성 — 실시간 첫 체결가로 근사
  if (todayFirstPx != null && isFinite(todayFirstPx)) {
    return ((todayFirstPx - last.close) / last.close) * 100;
  }
  return null;
}
