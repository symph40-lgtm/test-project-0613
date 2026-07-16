// 애덤 그라임스 — 일봉 레짐 + 풀백 후 재개. 스펙 2.5절.
// 원전: The Art and Science of Technical Analysis. 그의 대표 매매(추세 중 눌림 후 재개)를 정량화.
// 통계 검증 사상(무작위 기준선·워크포워드)은 백테스트 하네스(scripts/predict-backtest.ts)에 구현.

import { PREDICT_CONFIG } from "../config";
import { atrPct, sma } from "../indicators";
import type { DayInput, ModelOutput } from "../types";

export function runGrimes(input: DayInput): ModelOutput {
  const cfg = PREDICT_CONFIG.grimes;
  const model = "grimes" as const;
  const bars = input.dailyHistory;
  const closes = bars.map((b) => b.close);
  const atr = atrPct(bars, 14);
  const smaNow = sma(closes, cfg.smaLen);
  const smaPast = sma(closes.slice(0, -cfg.slopeDays), cfg.smaLen);
  const prev = bars[bars.length - 1];
  if (!prev || atr === null || smaNow === null || smaPast === null || input.morning.length === 0) {
    return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  }

  const regime: "up" | "down" | null =
    prev.close > smaNow && smaNow > smaPast ? "up" : prev.close < smaNow && smaNow < smaPast ? "down" : null;
  if (regime === null) return { model, verdict: "none", confidence: 0.5, reason: "추세 레짐 없음 (SMA20 기준)" };

  // 풀백: 룩백 내 극값 이후 며칠 경과 + 전일 종가가 SMA20 근처(±1×ATR)로 회귀
  const look = bars.slice(-cfg.highLookback);
  const extremeIdx =
    regime === "up"
      ? look.reduce((mi, b, i) => (b.high > look[mi].high ? i : mi), 0)
      : look.reduce((mi, b, i) => (b.low < look[mi].low ? i : mi), 0);
  const daysSince = look.length - 1 - extremeIdx;
  const distToSma = (Math.abs(prev.close - smaNow) / prev.close) * 100;
  const pulledBack = daysSince >= cfg.pullbackMinDaysFromHigh && distToSma <= cfg.pullbackAtrDist * atr;
  if (!pulledBack) {
    return { model, verdict: "none", confidence: 0.5, reason: `${regime === "up" ? "상승" : "하락"} 레짐이나 풀백 상태 아님 (극값 후 ${daysSince}일)` };
  }

  // 트리거: 아침 현재가가 전일 극값을 넘어 추세 재개
  const last = input.morning[input.morning.length - 1].close;
  const trigger = regime === "up" ? last > prev.high : last < prev.low;
  if (!trigger) {
    return { model, verdict: "none", confidence: 0.5, reason: `풀백 대기 중 — 재개 트리거(전일 ${regime === "up" ? "고가 돌파" : "저가 이탈"}) 미발생` };
  }
  return {
    model,
    verdict: regime === "up" ? "leverage" : "inverse",
    confidence: 0.7,
    reason: `${regime === "up" ? "상승" : "하락"} 레짐 + 풀백(${daysSince}일 전 극값·SMA20 거리 ${distToSma.toFixed(1)}%) + 재개 트리거`,
  };
}
