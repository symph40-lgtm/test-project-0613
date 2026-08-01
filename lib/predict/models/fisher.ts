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
  // 확인 허용 시각 (사용자 지시 2026-08-01 "프리장 판정 하지 말자"): 이 시각 이전 봉에서는 확인·전환이
  // 발생하지 않는다. 스트릭·트레일 극값 계산은 프리장부터 계속 — 프리장 추세가 지속되면 이 시각의
  // 첫 충족 봉에서 확인된다. 실측: F 프리장 첫확인 하닉 3·삼전 3건 전부 컷(합 -12.0%p). ""/미지정 = 비활성.
  confirmFromHHMM?: string;
  // 0930 OR 재박스 (사용자 제안 2026-08-01 — 8/6 반영 여부 결정 대기, 기본 비활성): 이 시각부터
  // reboxMinutes 동안의 박스가 완성되는 시점(예: "09:30"+15분 → 09:45)부터 A선 앵커를 그 박스로
  // 전환한다. 상태(확인 방향)는 승계, 연속봉 카운터는 리셋. 개장 30분 소란 이후의 안정 박스가
  // 오후 전환 감지를 살린다는 실측(F +78.5→+115.6%p 등) 근거 — 스윕 재현은 scripts/or0930-live-sweep.ts.
  reboxHHMM?: string;
  reboxMinutes?: number;
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
  // 활성 앵커 — 0930 OR 재박스 시 중간에 교체된다 (비활성이면 시초 OR 고정 = 기존과 동일)
  let curOrH = orHigh;
  let curOrL = orLow;
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
  const confirmFrom = cfg.confirmFromHHMM ?? "";
  // 재확인 수집 (사용자 지시 2026-08-01): 같은 방향 유지 중 스트릭이 리셋됐다가 다시 확인 봉수를
  // 완성하면 재확인 — 직전 확인·재확인에서 30분 이상 경과분만 (톱니 문자 폭주 방지)
  const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  const reconfirms: string[] = [];
  const transitions: { time: string; to: "up" | "down"; px: number }[] = [];
  let hadReset = false;
  let lastConfT: string | null = null;
  // 0930 OR 재박스 준비 — 박스 완성 시각 이후 첫 봉에서 앵커 교체·카운터 리셋 (상태는 승계)
  const reboxHH = cfg.reboxHHMM ?? "";
  const reboxEndMin = reboxHH !== "" ? hm(reboxHH) + (cfg.reboxMinutes ?? 15) : -1;
  let reboxed = false;
  for (const b of rest) {
    if (reboxEndMin >= 0 && !reboxed && hm(b.time) >= reboxEndMin) {
      const box = input.morning.filter((x) => hm(x.time) >= hm(reboxHH) && hm(x.time) < reboxEndMin);
      if (box.length > 0) {
        curOrH = Math.max(...box.map((x) => x.high));
        curOrL = Math.min(...box.map((x) => x.low));
        upRun = 0; downRun = 0; trailRun = 0;
      }
      reboxed = true; // 박스 결손 시 재시도 없이 시초 OR 유지 (라이브 결손 가드와 동일 태도)
    }
    const em = early(b.time) ? evMult : 1;
    const aUpB = curOrH + offset * em;
    const aDownB = curOrL - offset * em;
    upRun = b.close > aUpB ? upRun + 1 : 0;
    downRun = b.close < aDownB ? downRun + 1 : 0;
    if (cfg.strongBreakRatio > 0) {
      const sm = cfg.strongBreakRatio * range10 * em;
      if (b.close > aUpB + sm) upRun = Math.max(upRun, cfg.confirmMinutes, cfg.reversalMinutes);
      if (b.close < aDownB - sm) downRun = Math.max(downRun, cfg.confirmMinutes, cfg.reversalMinutes);
    }
    const canConfirm = confirmFrom === "" || b.time >= confirmFrom;
    if (state === "none") {
      if (!canConfirm) continue; // 프리장 확인 금지 — 스트릭은 위에서 계속 쌓인다
      if (upRun >= cfg.confirmMinutes) { state = "up"; confirmedAt = b.time; lastConfT = b.time; hadReset = false; extreme = b.close; trailRun = 0; transitions.push({ time: b.time, to: "up", px: b.close }); }
      else if (downRun >= cfg.confirmMinutes) { state = "down"; confirmedAt = b.time; lastConfT = b.time; hadReset = false; extreme = b.close; trailRun = 0; transitions.push({ time: b.time, to: "down", px: b.close }); }
    } else if (state === "up") {
      if (trailW > 0) {
        extreme = Math.max(extreme, b.close);
        trailRun = b.close < extreme - trailW ? trailRun + 1 : 0;
      }
      if (canConfirm && (downRun >= cfg.reversalMinutes || (trailW > 0 && trailRun >= trailN))) {
        viaTrail = downRun < cfg.reversalMinutes;
        state = "down"; confirmedAt = b.time; lastConfT = b.time; hadReset = false; reversed = true; extreme = b.close; trailRun = 0;
        transitions.push({ time: b.time, to: "down", px: b.close });
      } else if (upRun === 0) hadReset = true;
      else if (hadReset && canConfirm && upRun >= cfg.confirmMinutes && lastConfT !== null && hm(b.time) - hm(lastConfT) >= 30) {
        reconfirms.push(b.time); lastConfT = b.time; hadReset = false; // 같은 방향 재확인
      }
    } else {
      if (trailW > 0) {
        extreme = Math.min(extreme, b.close);
        trailRun = b.close > extreme + trailW ? trailRun + 1 : 0;
      }
      if (canConfirm && (upRun >= cfg.reversalMinutes || (trailW > 0 && trailRun >= trailN))) {
        viaTrail = upRun < cfg.reversalMinutes;
        state = "up"; confirmedAt = b.time; lastConfT = b.time; hadReset = false; reversed = true; extreme = b.close; trailRun = 0;
        transitions.push({ time: b.time, to: "up", px: b.close });
      } else if (downRun === 0) hadReset = true;
      else if (hadReset && canConfirm && downRun >= cfg.confirmMinutes && lastConfT !== null && hm(b.time) - hm(lastConfT) >= 30) {
        reconfirms.push(b.time); lastConfT = b.time; hadReset = false; // 같은 방향 재확인
      }
    }
  }

  // 표시는 활성 앵커 기준 (재박스 시 0930 박스 — 비활성이면 시초 OR와 동일)
  const lv = `A상 ${Math.round(curOrH + offset)}·A하 ${Math.round(curOrL - offset)} (OR ${Math.round(curOrL)}~${Math.round(curOrH)}, 오프셋 ${Math.round(offset)}원)`;
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
    ...(reconfirms.length ? { reconfirms } : {}),
    ...(transitions.length ? { transitions } : {}),
  };
}
