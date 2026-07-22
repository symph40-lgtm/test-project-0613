// 미장 예측 판정 모델 — 순수 함수 (사용자 지정 2026-07-21 "국장과 동일한 방식" ·
// 2026-07-22 "사용자모델 제거, 피셔F/M/본 3단계로 대체" — 국장 v1.13과 동일 구조).
// 백테스트(scripts/us-predict-backtest.ts)와 라이브(predictStream.ts)가 이 모듈을 공유해
// 상수·로직 이원화를 막는다. 데이터는 야후 SOXX 5분봉 (한국 KIS 1분봉과 달리 5분 단위 —
// 봉 개수 파라미터는 전부 '5분봉 n개'로 환산).

import { runFisher } from "@/lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar, Verdict } from "@/lib/predict/types";

export type UsBar = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
export type UsModelOutput = { verdict: Verdict; confidence: number; reason: string };

export const ET_OPEN = 9 * 60 + 30;   // 09:30 ET 정규장 개장
export const ET_CLOSE = 16 * 60;      // 16:00 ET
export const ET_PRE_START = 7 * 60;   // 프리장 관찰 시작 07:00 ET (04~07시는 박봉·역예측 — 백테스트 실측)

// ── 피셔 (ACD) — 전 구간 판정자 (사용자모델은 2026-07-22 판정자에서 폐기 — 국장 v1.13 동일).
// OR = 창 시작 15분(5분봉 3개), 철회 5분(1봉). 오프셋은 한국과 동일하게 avgRange10 비율.
// 변형: 본(0.15·2봉) / 피셔F(저문턱 조기 — config.usPredict.fisherF) / 피셔M(중간확인 — .fisherM).
// 강돌파 즉시확인(strongBreakRatio)은 한국 2026-07-22 도입분 — A선을 크게 관통한 종가는 즉시 판정.
export type UsFisherOpts = {
  confirmBars?: number;      // A 확인 연속 5분봉 수 (기본 2 = 10분, 한국 8분의 근사)
  strongBreakRatio?: number; // 강돌파 즉시확인 (0 = 비활성)
  orBars?: number;           // OR 5분봉 수 (기본 3 = 15분)
};
export function runUsFisher(
  bars: UsBar[], // 창 시작부터 컷 직전까지의 완성 5분봉 (본판정 09:30 창 · 조기창 07:00 창)
  dailyHistory: PredictDailyBar[], // 전일까지 (avgRange10)
  offsetRangeRatio: number,
  opts?: UsFisherOpts,
): UsModelOutput {
  const morning: MinuteBar[] = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const out = runFisher(
    { date: "", dailyHistory, openPx: bars[0]?.open ?? 0, morning, prevDayMinutes: null },
    {
      orMinutes: opts?.orBars ?? 3,
      offsetRangeRatio,
      confirmMinutes: opts?.confirmBars ?? 2,
      reversalMinutes: 1,      // 5분봉 1개 = 5분 (한국과 동일 시간)
      earlyConfirmBy: "10:15", // 개장+45분 (한국 09:45 대응)
      strongBreakRatio: opts?.strongBreakRatio ?? 0,
    },
  );
  return { verdict: out.verdict, confidence: out.confidence, reason: out.reason };
}

// ── 라벨 — 정규장 시가→종가, SMH 변동폭 스케일 (한국 하닉 1.2%의 SMH 환산 — 백테스트 분포로 결정)
export function labelUsDay(regBars: UsBar[], trendMinPct: number, posUp = 0.65, posDown = 0.35): { label: Verdict; rOC: number; pos: number } {
  const open = regBars[0].open;
  const close = regBars[regBars.length - 1].close;
  const hi = Math.max(...regBars.map((b) => b.high));
  const lo = Math.min(...regBars.map((b) => b.low));
  const rOC = open > 0 ? ((close - open) / open) * 100 : 0;
  const pos = hi > lo ? (close - lo) / (hi - lo) : 0.5;
  let label: Verdict = "none";
  if (rOC >= trendMinPct && pos >= posUp) label = "leverage";
  else if (rOC <= -trendMinPct && pos <= posDown) label = "inverse";
  return { label, rOC: Number(rOC.toFixed(2)), pos: Number(pos.toFixed(2)) };
}

// ── 채점 경제성 — 컷 시점 진입, 16:00 종가 청산, 스탑(SMH -1.5% ≈ 2x ETF -3%) 5분봉 고저 관통
export function pnlFromCut(
  regBars: UsBar[], cutEtMin: number, verdict: Verdict, stopPct: number,
): { entry: number | null; pnl: number; stopped: boolean } {
  if (verdict === "none") return { entry: null, pnl: 0, stopped: false };
  const before = regBars.filter((b) => b.etMin + 5 <= cutEtMin);
  const entry = before.length > 0 ? before[before.length - 1].close : regBars[0]?.open;
  if (!entry) return { entry: null, pnl: 0, stopped: false };
  const after = regBars.filter((b) => b.etMin + 5 > cutEtMin);
  const dirUp = verdict === "leverage";
  for (const b of after) {
    const adverse = dirUp ? ((b.low - entry) / entry) * 100 : ((entry - b.high) / entry) * 100;
    if (adverse <= -stopPct) return { entry, pnl: -stopPct, stopped: true };
  }
  const close = regBars[regBars.length - 1].close;
  const rEC = ((close - entry) / entry) * 100;
  return { entry, pnl: Number((dirUp ? rEC : -rEC).toFixed(2)), stopped: false };
}
