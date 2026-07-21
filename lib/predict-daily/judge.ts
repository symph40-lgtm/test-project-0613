// 일봉 스윙 판정 (순수 함수) — 미너비니 판정자 + 10Y 게이트 + 이벤트 감산.
// 근거: docs/predict-daily-spec.md 5-3(확정 운영안 v0.2)·6장 실측.

import { PREDICT_DAILY_CONFIG as CFG } from "./config";
import { atr14, ema, isoWeekKey, MODELS, sma, supertrendUp } from "./models";
import type { DailyBar, DailyJudgment, MacroSnap, Stance } from "./types";

// 중장기 투표 (와인스타인·골든크로스 50/200·엘더 조류 주봉EMA13) — 각 상승 +1/하락 −1, 합 −3~+3.
// 미너비니 대비 바닥 재진입이 빠름(지연 19~22% vs 30~38%, 스펙 5-7) — 표기 + 재진입 가속에 사용.
function midTermVote(bars: DailyBar[], i: number, weinstein: Stance): number {
  const closes = bars.map((b) => b.close);
  let v = weinstein === "long" ? 1 : weinstein === "short" ? -1 : 0;
  const ma50 = sma(closes, 50)[i], ma200 = sma(closes, 200)[i];
  if (ma50 !== null && ma200 !== null) v += ma50 > ma200 ? 1 : -1;
  const weekKeys = bars.map((b) => isoWeekKey(b.date));
  const wkClose: number[] = [];
  const wkKey: string[] = [];
  for (let j = 0; j < bars.length; j++) {
    if (wkKey.length && wkKey[wkKey.length - 1] === weekKeys[j]) wkClose[wkClose.length - 1] = closes[j];
    else { wkKey.push(weekKeys[j]); wkClose.push(closes[j]); }
  }
  const wkEma = ema(wkClose, 13);
  const w = wkKey.lastIndexOf(weekKeys[i]);
  if (w >= 2 && wkEma[w - 1] !== null && wkEma[w - 2] !== null) v += wkEma[w - 1]! > wkEma[w - 2]! ? 1 : -1;
  return v;
}

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
// opts.supertrendBrake: 수퍼트렌드 하락 시 비중 상한 50% (삼전 전용 — config.symbols 참조)
export function judgeDaily(bars: DailyBar[], macro: MacroSnap | null, opts?: { supertrendBrake?: boolean }): DailyJudgment {
  const i = bars.length - 1;
  const modelStances: Record<string, Stance> = {};
  for (const m of MODELS) modelStances[m.id] = m.run(bars)[i];
  const stUp = supertrendUp(bars)[i];
  let hi52 = -Infinity;
  for (let j = Math.max(0, i - 251); j <= i; j++) hi52 = Math.max(hi52, bars[j].close);
  const dd = bars[i].close / hi52 - 1;
  // 60일 추세 t-통계 (수익률 신호대잡음 × √60) — |t|<1 = 변동장 (스펙 5-8: 5기법 중 변동 재현 최고 67~69%)
  let trendT = 0;
  if (i >= 60) {
    const rs: number[] = [];
    for (let j = i - 59; j <= i; j++) rs.push(bars[j].close / bars[j - 1].close - 1);
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rs.length);
    trendT = sd > 0 ? (mean / sd) * Math.sqrt(rs.length) : 0;
  }

  const stance = modelStances["minervini"];
  const votes = (["donchian", "wilder", "weinstein", "elder"] as const).reduce(
    (a, id) => a + (modelStances[id] === "long" ? 1 : modelStances[id] === "short" ? -1 : 0), 0);

  // 사다리 v3 (스펙 5-4·5-7): 풀보유(1.0) / 재진입 가속(0.5 — 중장기 만장일치) / 완충(0.25) / 전량 현금(0)
  const midVote = midTermVote(bars, i, modelStances["weinstein"]);
  let baseExposure = 0;
  if (stance === "long") baseExposure = votes >= CFG.ladder.strongVotes ? 1 : CFG.ladder.base;
  else if (stance === "flat") {
    if (midVote >= CFG.ladder.reentryVotes) baseExposure = CFG.ladder.reentry;
    else if (modelStances["weinstein"] === "long") baseExposure = CFG.ladder.weakHold;
  }

  let exposure = baseExposure;
  const gates: string[] = [];
  if (opts?.supertrendBrake && !stUp && exposure > CFG.brakeCap) {
    exposure = CFG.brakeCap;
    gates.push("수퍼트렌드 하락 브레이크");
  }
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
  // 손절폭: 변동성 연동 2.5×ATR14, 6~12% 클램프 (고정 -8%와 성능 동등 실측 — 종목·장세 자동 적응)
  const atr = atr14(bars)[i];
  const stopPct = atr && closePx > 0
    ? Math.min(CFG.stop.maxPct, Math.max(CFG.stop.minPct, (CFG.stop.atrMult * atr) / closePx))
    : 0.08;
  return {
    stance,
    baseExposure,
    exposure,
    votes,
    gates,
    stopPx: exposure > 0 ? Math.floor((closePx * (1 - stopPct)) / 10) * 10 : null,
    stopPct,
    closePx,
    modelStances,
    stUp,
    dd,
    midVote,
    trendT,
  };
}

// 과거 구간 백필용 — j 인덱스까지 자른 시계열로 당시 판정 재현 (매크로 게이트만 소급 생략 — 이벤트는 결정론적이라 적용됨)
export function judgeAt(bars: DailyBar[], j: number, opts?: { supertrendBrake?: boolean }): DailyJudgment {
  return judgeDaily(bars.slice(0, j + 1), null, opts);
}
