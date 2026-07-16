// 린다 라쉬케 — 추세일 증거 스코어. 스펙 2.2절.
// Street Smarts의 추세일 판별 원리를 정량화: 갭 유지 · 전일 레인지 확장 · 시가/현재가 위치 · 얕은 되돌림.
// 역추세 셋업(터틀 수프)은 의도적으로 배제 — 추세추종 원칙 (2026-07-16 검토).

import { PREDICT_CONFIG } from "../config";
import { atrPct, hi, lo } from "../indicators";
import type { DayInput, ModelOutput } from "../types";

export function runRaschke(input: DayInput): ModelOutput {
  const cfg = PREDICT_CONFIG.raschke;
  const model = "raschke" as const;
  const prev = input.dailyHistory[input.dailyHistory.length - 1];
  const atr = atrPct(input.dailyHistory, 14);
  if (!prev || atr === null || input.morning.length < 10) {
    return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  }

  const last = input.morning[input.morning.length - 1].close;
  const mHigh = hi(input.morning);
  const mLow = lo(input.morning);
  const mRange = mHigh - mLow;
  const evidence: { dir: "up" | "down"; tag: string }[] = [];

  // E1 갭 유지 (미채움)
  const gapPct = ((input.openPx - prev.close) / prev.close) * 100;
  if (Math.abs(gapPct) >= cfg.gapAtrRatio * atr) {
    if (gapPct > 0 && mLow > prev.close) evidence.push({ dir: "up", tag: "갭업 유지" });
    if (gapPct < 0 && mHigh < prev.close) evidence.push({ dir: "down", tag: "갭다운 유지" });
  }

  // E2 전일 레인지 확장
  if (last > prev.high) evidence.push({ dir: "up", tag: "전일 고가 돌파" });
  if (last < prev.low) evidence.push({ dir: "down", tag: "전일 저가 이탈" });

  // E3 시가·현재가의 아침 레인지 내 위치 (추세일: 시가가 한쪽 극단, 현재가가 반대 극단)
  if (mRange > 0) {
    const openPos = (input.openPx - mLow) / mRange;
    const lastPos = (last - mLow) / mRange;
    if (openPos <= cfg.openPosMax && lastPos >= cfg.lastPosMin) evidence.push({ dir: "up", tag: "저가 시가→고가권 진행" });
    if (openPos >= 1 - cfg.openPosMax && lastPos <= 1 - cfg.lastPosMin) evidence.push({ dir: "down", tag: "고가 시가→저가권 진행" });
  }

  // E4 얕은 되돌림 — 방향 극값 이후 최대 역행이 아침 레인지의 40% 이하
  if (mRange > 0) {
    const iHigh = input.morning.findIndex((b) => b.high === mHigh);
    const iLow = input.morning.findIndex((b) => b.low === mLow);
    if (iLow < iHigh) {
      // 저점 먼저 → 상방 진행 중. 고점 이후 되돌림 확인
      const after = input.morning.slice(iHigh);
      const pull = after.length ? mHigh - Math.min(...after.map((b) => b.low)) : 0;
      if (pull <= cfg.pullbackMax * mRange && last > input.openPx) evidence.push({ dir: "up", tag: "얕은 되돌림" });
    } else if (iHigh < iLow) {
      const after = input.morning.slice(iLow);
      const pull = after.length ? Math.max(...after.map((b) => b.high)) - mLow : 0;
      if (pull <= cfg.pullbackMax * mRange && last < input.openPx) evidence.push({ dir: "down", tag: "얕은 되돌림" });
    }
  }

  const upScore = evidence.filter((e) => e.dir === "up").length;
  const downScore = evidence.filter((e) => e.dir === "down").length;
  const dir = upScore >= cfg.minScore && upScore > downScore ? "up" : downScore >= cfg.minScore && downScore > upScore ? "down" : null;

  if (dir === null) {
    const narrow = mRange > 0 && prev.close > 0 && (mRange / prev.close) * 100 < cfg.narrowRangeAtrRatio * atr;
    return {
      model,
      verdict: "none",
      confidence: narrow ? 0.65 : 0.5,
      reason: narrow ? `증거 부족 + 아침 레인지 협소(횡보 증거)` : `추세일 증거 부족 (상방 ${upScore}·하방 ${downScore})`,
    };
  }
  const score = dir === "up" ? upScore : downScore;
  const tags = evidence.filter((e) => e.dir === dir).map((e) => e.tag).join("·");
  return {
    model,
    verdict: dir === "up" ? "leverage" : "inverse",
    confidence: Number(Math.min(0.85, 0.45 + 0.15 * score).toFixed(2)),
    reason: `추세일 증거 ${score}개 (${tags})`,
  };
}
