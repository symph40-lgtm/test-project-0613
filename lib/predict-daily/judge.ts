// 일봉 스윙 판정 (순수 함수) — 미너비니 판정자 + 10Y 게이트 + 이벤트 감산.
// 근거: docs/predict-daily-spec.md 5-3(확정 운영안 v0.2)·6장 실측.

import { PREDICT_DAILY_CONFIG as CFG } from "./config";
import { MODELS } from "./models";
import type { DailyBar, DailyJudgment, MacroSnap, Stance } from "./types";

// 매월 첫 금요일 = NFP 발표일 근사 (그날 밤 21:30 KST 발표 — 마감 판정에 감산)
export function isFirstFriday(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getUTCDay() === 5 && d.getUTCDate() <= 7;
}

export function todayEvent(dateStr: string): string | null {
  const hit = CFG.events.find((e) => e.date === dateStr);
  if (hit) return hit.label;
  if (isFirstFriday(dateStr)) return "NFP(첫 금요일)";
  return null;
}

// bars의 마지막 봉 시점 기준 판정. macro는 null이면 게이트 생략(수집 실패 폴백).
export function judgeDaily(bars: DailyBar[], macro: MacroSnap | null): DailyJudgment {
  const i = bars.length - 1;
  const modelStances: Record<string, Stance> = {};
  for (const m of MODELS) modelStances[m.id] = m.run(bars)[i];

  const stance = modelStances["minervini"];
  const baseExposure = stance === "long" ? 1 : 0; // 이진 (스펙 5-3 확정)
  let exposure = baseExposure;
  const gates: string[] = [];

  if (exposure > 0 && macro?.y10Chg != null && macro.y10Chg >= CFG.macroGate.y10SpikePp) {
    exposure *= CFG.macroGate.factor;
    gates.push(`10Y급등(+${macro.y10Chg.toFixed(2)}%p)`);
  }
  if (exposure > 0 && macro?.dxyChg != null && macro.dxyChg >= CFG.macroGate.dxySpikePct) {
    exposure *= CFG.macroGate.factor;
    gates.push(`달러급등(+${macro.dxyChg.toFixed(1)}%)`);
  }
  const event = todayEvent(bars[i].date);
  if (exposure > 0 && event) {
    exposure *= CFG.eventFactor;
    gates.push(`이벤트:${event}`);
  }

  const closePx = bars[i].close;
  return {
    stance,
    baseExposure,
    exposure,
    gates,
    stopPx: stance === "long" ? Math.floor((closePx * (1 - CFG.stopPct)) / 10) * 10 : null,
    closePx,
    modelStances,
  };
}

// 과거 구간 백필용 — j 인덱스까지 자른 시계열로 당시 판정 재현 (매크로 게이트만 소급 생략 — 이벤트는 결정론적이라 적용됨)
export function judgeAt(bars: DailyBar[], j: number): DailyJudgment {
  return judgeDaily(bars.slice(0, j + 1), null);
}
