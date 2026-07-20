// 미장 예측 판정 모델 — 순수 함수 (사용자 지정 2026-07-21: "국장과 동일한 방식 —
// 프리장에서는 사용자 모드, 정규장에서는 피셔 모델. SMH 변동폭에 맞는 상수로").
// 백테스트(scripts/us-predict-backtest.ts)와 라이브(predictStream.ts)가 이 모듈을 공유해
// 상수·로직 이원화를 막는다. 데이터는 야후 SMH 5분봉 (한국 KIS 1분봉과 달리 5분 단위 —
// 봉 개수 파라미터는 전부 '5분봉 n개'로 환산).
//
// 의존 원칙: 한국 user 모델(lib/predict/models/user.ts)과 동일하게 lib/signal의 순수 엔진
// (detectReversal·computeSwingStructure)을 재사용한다. 상태·DB·알림은 공유하지 않는다.

import { runFisher } from "@/lib/predict/models/fisher";
import { detectReversal, type ReversalThresholds } from "../engine/reversal";
import { computeSwingStructure } from "../engine/trend";
import type { IntradayTick } from "../types";
import type { MinuteBar, PredictDailyBar, Verdict } from "@/lib/predict/types";
import { US_SIGNAL_CONFIG } from "./config";

export type UsBar = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
export type UsModelOutput = { verdict: Verdict; confidence: number; reason: string };

export const ET_OPEN = 9 * 60 + 30;   // 09:30 ET 정규장 개장
export const ET_CLOSE = 16 * 60;      // 16:00 ET
export const ET_PRE_START = 7 * 60;   // 프리장 관찰 시작 07:00 ET (04~07시는 박봉·역예측 — 백테스트 실측)

// ── 사용자 모델 (RV1 + T6) — 프리장 체크포인트 판정자 (한국 runUser의 미국판)
// 한국 구현과 동일한 우선순위: ①RV1 최초 트리거 방향 ②무트리거면 T6 '추세' 방향 ③아니면 없음.
// 차이(의도된 것):
//  - 봉이 5분 단위라 RV1은 5분봉 조건만 사용 (1분봉 조건은 임계 ∞로 무효화 — 5분 점프를
//    1분 조건에 대면 과발화). 임계값은 판정 지수(SOXX) 실측 분위 (config.usPredict.reversal5m).
//  - RV1을 프리장 구간에도 적용한다 (rv1Premarket). 한국은 detectReversal의 세션 개장(09:00)
//    필터로 프리마켓 RV1이 사실상 비활성 — 스펙 의도("프리마켓 가격행동 RV1 트리거")와 코드가
//    어긋난 상태라, 미국은 백테스트로 우위인 쪽을 채택한다.
export type UsUserOpts = {
  rv1Premarket?: boolean;
  m5?: { single: number; sum3: number; sum5: number; sum7: number }; // RV1 5분봉 임계 오버라이드 (스윕용)
  swing?: { minAmpPct: number; tolPct: number };                     // T6 피벗 오버라이드 (스윕용)
};
export function runUsUserModel(
  bars: UsBar[], // 07:00 ET부터 컷 직전까지의 완성 5분봉
  prevClose: number,
  opts?: UsUserOpts,
): UsModelOutput {
  if (bars.length < 4 || prevClose <= 0) return { verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  const UP = US_SIGNAL_CONFIG.usPredict;
  const rv1Pre = opts?.rv1Premarket ?? UP.rv1Premarket;

  // 가상 KST 분 매핑: rv1Pre면 프리장 시작(07:00 ET)=540 — 전 구간 RV1 감지.
  // 아니면 정규장 개장(09:30 ET)=540 — 프리장 봉은 detectReversal이 거른다 (한국 코드 동작 재현).
  const base = rv1Pre ? ET_PRE_START : ET_OPEN;
  const R = opts?.m5 ?? UP.reversal5m;
  const cfg: ReversalThresholds = {
    m1Single: 99, m1Sum3: 99, m1Sum5: 99, // 1분봉 조건 무효화 (5분봉 입력)
    m5Single: R.single, m5Sum3: R.sum3, m5Sum5: R.sum5, m5Sum7: R.sum7,
    trendLookbackMin: 30,
  };
  const ticks = bars.map(
    (b) => ({ minuteOfDay: 540 + (b.etMin - base), hynixChg: ((b.close - prevClose) / prevClose) * 100 }) as unknown as IntradayTick,
  );

  // ① RV1 — 프리픽스 재생으로 최초 트리거 (라이브 폴링과 동일 효과)
  let rv: { dir: "UP" | "DOWN"; cond: string; at: string } | null = null;
  for (let i = 3; i < ticks.length; i++) {
    const hit = detectReversal(ticks.slice(0, i + 1), { cfg });
    if (hit) { rv = { dir: hit.dir, cond: hit.cond, at: bars[i].time }; break; }
  }

  // ② T6 — 산·골 스윙 구조 (피벗은 판정 지수 실측 보정 — config.usPredict.swing)
  const pts = bars.map((b) => ({ min: b.etMin, px: b.close }));
  const swing = pts.length >= 4 ? computeSwingStructure(pts, { ...(opts?.swing ?? UP.swing) }) : null;
  const swingNote = swing === null ? "스윙 데이터 부족" : `T6 ${swing.status}${swing.dir ? `(${swing.dir === "UP" ? "상승" : "하락"})` : ""}`;

  if (rv) {
    const agree = swing?.status === "추세" && swing.dir === rv.dir;
    const oppose = swing?.status === "추세" && swing.dir !== null && swing.dir !== rv.dir;
    return {
      verdict: rv.dir === "UP" ? "leverage" : "inverse",
      confidence: agree ? 0.8 : oppose ? 0.6 : 0.7,
      reason: `RV1 ${rv.at} ${rv.cond} 트리거 · ${swingNote}`,
    };
  }
  if (swing?.status === "추세" && swing.dir !== null) {
    return { verdict: swing.dir === "UP" ? "leverage" : "inverse", confidence: 0.6, reason: `RV1 무트리거 · ${swingNote} — ${swing.detail}` };
  }
  return { verdict: "none", confidence: swing?.status === "횡보" ? 0.65 : 0.5, reason: `RV1 무트리거 · ${swingNote}` };
}

// ── 피셔 (ACD) — 정규장 체크포인트 판정자. OR = 개장 15분(5분봉 3개), 확인 10분(2봉), 철회 5분(1봉).
// 오프셋은 한국과 동일하게 avgRange10 비율 — 비율값은 SMH 백테스트 실측 (config.usPredict).
export function runUsFisher(
  regBars: UsBar[], // 09:30 ET부터 컷 직전까지의 완성 5분봉
  dailyHistory: PredictDailyBar[], // 전일까지 (avgRange10)
  offsetRangeRatio: number,
): UsModelOutput {
  const morning: MinuteBar[] = regBars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const out = runFisher(
    { date: "", dailyHistory, openPx: regBars[0]?.open ?? 0, morning, prevDayMinutes: null },
    {
      orMinutes: 3,           // 5분봉 3개 = 15분 (한국 orMinutes 15와 동일 시간)
      offsetRangeRatio,
      confirmMinutes: 2,      // 5분봉 2개 = 10분 (한국 8분의 5분봉 근사)
      reversalMinutes: 1,     // 5분봉 1개 = 5분 (한국과 동일 시간)
      earlyConfirmBy: "10:15", // 개장+45분 (한국 09:45 대응)
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
