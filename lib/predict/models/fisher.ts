// 마크 피셔 — ACD: 시초 레인지(OR) ± 오프셋의 A지점 확인, 반대편 C지점 철회. 스펙 2.3절.
// 원전: The Logical Trader. A 확인 = 레벨 밖 유지 시간(OR의 절반), C = 확인 후 반대 이탈 → 판정 전환.

import { PREDICT_CONFIG } from "../config";
import { avgRange } from "../indicators";
import type { DayInput, ModelOutput } from "../types";

// 파라미터 오버라이드 (변동성 레짐 튜닝 검증용 — 운영은 기본값 고정, 스펙 2.3절)
export type FisherCfg = {
  orMinutes?: number;
  offsetRangeRatio?: number;
  confirmMinutes?: number;
  reversalMinutes?: number;
  earlyConfirmBy?: string;
  // 강돌파 즉시확인 (2026-07-22 사용자 제안): A선을 이 비율×10일평균폭 이상 크게 돌파한 종가는
  // 확인봉을 즉시 충족 처리. 0 = 비활성. 검증: 0.10에서 220일 +74.8→+84.6%p·최근 구간 중립.
  strongBreakRatio?: number;
  // 트레일 반전 (2026-07-25 사용자 승인 — 하닉 고변동일 스트림 전용): 방향 확인 후 극값(종가)에서
  // 이 비율×10일평균폭 되돌림이 trailConfirmMinutes봉 연속 유지되면 반대편 A선(C지점) 없이도 전환.
  // 고정 OR 앵커의 전환 지연(멀리 갔다 돌아오는 날) 해소 — C반전과 병행, 먼저 오는 쪽. 0 = 비활성.
  trailRangeRatio?: number;
  trailConfirmMinutes?: number;
  // 장초반 크기 배수 (사용자 제안·승인 2026-07-29 — docs/early-vol-policy.md): earlyVolUntil 이전
  // 봉은 오프셋·강돌파를 ×earlyVolMult로 넓힘 — 시간 기준(확인·반전봉)은 불변. 1/"" = 비활성.
  earlyVolMult?: number;
  earlyVolUntil?: string;
};

export function runFisher(input: DayInput, cfgOverride?: FisherCfg): ModelOutput {
  const cfg: Required<FisherCfg> = { ...PREDICT_CONFIG.fisher, ...cfgOverride };
  const model = "fisher" as const;
  const range10 = avgRange(input.dailyHistory, 10);
  if (range10 === null || input.morning.length < cfg.orMinutes + cfg.confirmMinutes) {
    return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  }

  const or = input.morning.slice(0, cfg.orMinutes);
  const orHigh = Math.max(...or.map((b) => b.high));
  const orLow = Math.min(...or.map((b) => b.low));
  const offset = cfg.offsetRangeRatio * range10;
  const aUp = orHigh + offset;
  const aDown = orLow - offset;
  // 장초반 크기 배수 — until 이전 봉만 A선·강돌파 문턱을 ×배수 (표시는 기본 A선 기준)
  const evMult = cfg.earlyVolMult ?? 1;
  const evUntil = cfg.earlyVolUntil ?? "";
  const early = (t: string) => evMult !== 1 && evUntil !== "" && t < evUntil;

  // OR 이후 완성봉 순회 — 연속 유지 카운트로 A 확인, 확인 후 반대편(C) 이탈이면 전환.
  // 트레일 활성 시(고변동일 하닉): 극값 되돌림 유지도 전환 경로 — C와 병행, 먼저 오는 쪽.
  const rest = input.morning.slice(cfg.orMinutes);
  const trailW = (cfg.trailRangeRatio ?? 0) > 0 ? (cfg.trailRangeRatio ?? 0) * range10 : 0;
  const trailN = cfg.trailConfirmMinutes ?? 5;
  let state: "none" | "up" | "down" = "none";
  let upRun = 0, downRun = 0, trailRun = 0, extreme = 0;
  let confirmedAt: string | null = null;
  let reversed = false;
  let viaTrail = false;
  for (const b of rest) {
    const em = early(b.time) ? evMult : 1;
    const aUpB = em === 1 ? aUp : orHigh + offset * em;
    const aDownB = em === 1 ? aDown : orLow - offset * em;
    upRun = b.close > aUpB ? upRun + 1 : 0;
    downRun = b.close < aDownB ? downRun + 1 : 0;
    if (cfg.strongBreakRatio > 0) {
      const sm = cfg.strongBreakRatio * range10 * em;
      if (b.close > aUpB + sm) upRun = Math.max(upRun, cfg.confirmMinutes, cfg.reversalMinutes);
      if (b.close < aDownB - sm) downRun = Math.max(downRun, cfg.confirmMinutes, cfg.reversalMinutes);
    }
    if (state === "none") {
      if (upRun >= cfg.confirmMinutes) { state = "up"; confirmedAt = b.time; extreme = b.close; trailRun = 0; }
      else if (downRun >= cfg.confirmMinutes) { state = "down"; confirmedAt = b.time; extreme = b.close; trailRun = 0; }
    } else if (state === "up") {
      if (trailW > 0) {
        extreme = Math.max(extreme, b.close);
        trailRun = b.close < extreme - trailW ? trailRun + 1 : 0;
      }
      if (downRun >= cfg.reversalMinutes || (trailW > 0 && trailRun >= trailN)) {
        viaTrail = downRun < cfg.reversalMinutes;
        state = "down"; confirmedAt = b.time; reversed = true; extreme = b.close; trailRun = 0;
      }
    } else {
      if (trailW > 0) {
        extreme = Math.min(extreme, b.close);
        trailRun = b.close > extreme + trailW ? trailRun + 1 : 0;
      }
      if (upRun >= cfg.reversalMinutes || (trailW > 0 && trailRun >= trailN)) {
        viaTrail = upRun < cfg.reversalMinutes;
        state = "up"; confirmedAt = b.time; reversed = true; extreme = b.close; trailRun = 0;
      }
    }
  }

  const lv = `A상 ${Math.round(aUp)}·A하 ${Math.round(aDown)} (OR ${Math.round(orLow)}~${Math.round(orHigh)}, 오프셋 ${Math.round(offset)}원)`;
  if (state === "none") {
    return { model, verdict: "none", confidence: 0.5, reason: `A지점 미확인 — ${lv}` };
  }
  const conf = reversed ? 0.6 : confirmedAt !== null && confirmedAt < cfg.earlyConfirmBy ? 0.8 : 0.7;
  const head = reversed && viaTrail
    ? `${confirmedAt} 트레일(추세) 반전 확인 (극값 ${Math.round(trailW)}원 되돌림·고변동일)`
    : `${confirmedAt} A${state === "up" ? "상" : "하"} 확인${reversed ? " (C지점 반전 후)" : ""}`;
  return {
    model,
    verdict: state === "up" ? "leverage" : "inverse",
    confidence: conf,
    reason: `${head} — ${lv}`,
  };
}
