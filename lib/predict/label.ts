// 실제 추세 라벨 — 그날 공식 일봉(OHLC)으로 장 마감 후 확정. 스펙 1.1절.

import { PREDICT_CONFIG } from "./config";
import type { DayLabelResult, PredictDailyBar } from "./types";

export function labelDay(bar: PredictDailyBar): DayLabelResult {
  const { trendMinPct, posUp, posDown } = PREDICT_CONFIG.label;
  const rOC = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0;
  const range = bar.high - bar.low;
  const pos = range > 0 ? (bar.close - bar.low) / range : 0.5;
  let label: DayLabelResult["label"] = "none";
  if (rOC >= trendMinPct && pos >= posUp) label = "leverage";
  else if (rOC <= -trendMinPct && pos <= posDown) label = "inverse";
  return { label, rOC: Number(rOC.toFixed(2)), pos: Number(pos.toFixed(2)) };
}
