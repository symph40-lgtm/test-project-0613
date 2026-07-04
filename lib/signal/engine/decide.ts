// 통합 판정 — 마스터 2.5.4 일일 의사결정 트리.
// 우선순위: 하드 블록(X·XS) > 폭락 후 V반등 분기 > T-스코어(추세일) > L/S 셋업.
// 순수 함수 — 실시간(state 라우트)과 백테스트(backtest.ts)가 동일 코드를 사용한다.

import { SIGNAL_CONFIG, isExpiryBlackout } from "../config";
import type { DivergenceResult, ExtRecord, IntradayTick, Judgment, PremarketContext } from "../types";
import { computeBias } from "./bias";
import { computeTrend } from "./trend";
import { computeSetups } from "./setups";
import { computeRisk } from "./risk";
import { gapPct as calcGap, nr7Flags, worstCumDeclinePct } from "./daily";

const S = SIGNAL_CONFIG.session;

export function decide(ctx: PremarketContext, ticks: IntradayTick[], nowMinuteOfDay: number, nowIso: string): Judgment {
  const dataNotes: string[] = [];

  // ── 갭 (하닉 기준 — 유형 분류용. 갭은 필수 조건이 아님, v2.2)
  const firstHynix = ticks.find((t) => t.hynixPx !== null)?.hynixPx ?? null;
  const gap = calcGap(ctx.hynixDaily, firstHynix);

  // ── 분기 1 — 직전 1~3일 폭락 여부 (V반등 우선, XS1)
  const crashCum = worstCumDeclinePct(ctx.hynixDaily, true);
  const crashActive = crashCum !== null && crashCum <= SIGNAL_CONFIG.crashCumPct;
  const crashContext = {
    active: crashActive,
    cumPct: crashCum,
    detail: crashCum === null ? "일봉 데이터 부족" : `하닉 직전 1~3일 최대 누적 ${crashCum.toFixed(1)}% (기준 ${SIGNAL_CONFIG.crashCumPct}%)`,
  };

  // ── 축1·축2·정합성
  const bias = computeBias(ctx);
  const inSession = nowMinuteOfDay >= S.openMin;
  const trend = inSession && ticks.length > 0 ? computeTrend(ticks, gap) : null;
  const divergence = inSession ? computeDivergence(ticks, trend?.dir ?? null) : null;
  const setups = computeSetups({ ctx, bias, trend, ticks, gapPct: gap, minuteOfDay: nowMinuteOfDay, crashActive, crashCumPct: crashCum });
  const risk = computeRisk(ctx, bias, trend, ticks, nowMinuteOfDay);

  // ── 확장 모듈 기록값
  const ext = computeExt(ctx, ticks);

  // ── 페이즈
  const phase: Judgment["phase"] =
    nowMinuteOfDay < S.openMin ? "장전"
    : nowMinuteOfDay < S.observeEndMin ? "관찰"
    : nowMinuteOfDay <= S.entryEndMin ? "판정"
    : nowMinuteOfDay <= S.endMin ? "관리"
    : "마감";

  // ── 의사결정 트리
  let dayType: Judgment["dayType"];
  let headline: string;
  let action: string;
  const binaryToday = ctx.events.some((e) => e.binary && e.when === "당일");

  if (phase === "장전") {
    dayType = binaryToday ? "이벤트보수" : crashActive ? "V반등후보" : "대기";
    headline = binaryToday
      ? `이벤트일(${ctx.events.filter((e) => e.binary).map((e) => e.label).join("·")}) — 보수 모드`
      : crashActive
        ? `폭락 직후(${crashCum?.toFixed(1)}%) — V반등 셋업 감시, 인버스 금지`
        : `Bias ${bias.dir} 강도${bias.strength} — 09:00 관찰 대기`;
    action = "09:00~09:30 관찰 전용 (진입 금지). 갭·Opening Range 기록.";
  } else if (phase === "관찰") {
    dayType = "관찰";
    headline = `관찰 구간 — 갭 ${gap !== null ? (gap > 0 ? "+" : "") + gap.toFixed(1) + "%" : "?"} · Bias ${bias.dir}`;
    action = "진입 금지. Opening Range 확정 대기 (09:30).";
  } else if (trend === null) {
    dayType = "대기";
    headline = "장중 데이터 부족 — 판정 불가";
    action = "페이지를 열어두면 60초마다 시계열이 축적됩니다.";
  } else if (crashActive) {
    // 분기 1 — V반등 셋업 우선, 인버스 금지 (XS1)
    dayType = "V반등후보";
    if (setups.long.verdict === "진입후보" || setups.long.verdict === "강한신호") {
      headline = `V반등 셋업 ${setups.long.verdict} — 반전 후 진행 확인됨 (가점 ${setups.long.bonus}점)`;
      action = `레버리지 ${risk.sizeGuide}. 스탑 -${risk.stopFixedPct}%${risk.stopAtrPct ? ` (ATR 권장 -${risk.stopAtrPct.toFixed(1)}%)` : ""}.`;
    } else {
      headline = `폭락 후 구간 — 반전 대기 (괴리는 진입 신호가 아님, 반전 확인 후)`;
      action = "L3 반전 후 지속 확인까지 관찰. 인버스 절대 금지(XS1).";
    }
  } else if (trend.grade === "횡보일선언") {
    // 분기 3 — T6 위반
    dayType = "횡보일";
    headline = `횡보일 선언 — 방향 전환 ${trend.flips}회 (기준 ${SIGNAL_CONFIG.trend.t6MaxFlips}회 초과)`;
    action = "당일 추세 매매 금지. '안 하는 것'이 시스템의 절반 (2.5.7).";
  } else if (trend.grade === "추세일" && divergence?.status !== "이탈") {
    // 분기 2 — 추세일 확정
    dayType = trend.dir === "UP" ? "추세일_상방" : "추세일_하방";
    const target = trend.dir === "UP" ? "레버리지" : "인버스";
    const setup = trend.dir === "UP" ? setups.long : setups.short;
    if (setup.blocked.length > 0) {
      headline = `추세일 ${trend.dir} 확정, 그러나 하드 블록 — ${setup.blocked[0]}`;
      action = "진입 불가. 블록 해제 조건 확인.";
    } else if (phase === "판정") {
      headline = `추세일 ${trend.dir === "UP" ? "상방" : "하방"} 확정 (T-스코어 ${trend.score.toFixed(1)}/${trend.maxAvailable} · DC1 ${trend.dc1 !== null ? (trend.dc1 * 100).toFixed(0) + "%" : "-"})`;
      action = `${target} 진입 검토 — ${risk.sizeGuide}. 스탑 -${risk.stopFixedPct}%.`;
    } else {
      headline = `추세일 ${trend.dir === "UP" ? "상방" : "하방"} 진행 중 — 신규 진입 시간 종료(${hm(S.entryEndMin)})`;
      action = `보유분만 R2 트레일링 -${risk.trailPct}% 관리. 15:00 당일 청산.`;
    }
  } else if (divergence?.status === "이탈") {
    dayType = "역발상검토";
    headline = `크로스마켓 이탈 — 한국 고유 원인 없으면 역발상(평균회귀) 셋업 검토 (D4)`;
    action = "원인 주석 입력으로 이탈 성격 분류. 고유 악재 있으면 그 방향 추세로 취급.";
  } else if (trend.grade === "약한추세") {
    dayType = trend.dir === "UP" ? "추세일_상방" : trend.dir === "DOWN" ? "추세일_하방" : "대기";
    headline = `약한 추세(${trend.dir ?? "-"}) — 정규화 ${(trend.normalized * 100).toFixed(0)}%`;
    action = `1/3 비중만 · 트레일링 타이트 -${SIGNAL_CONFIG.risk.weakTrailPct}% (4.3)`;
  } else {
    dayType = "대기";
    headline = `비추세 — T-스코어 ${trend.score.toFixed(1)}/${trend.maxAvailable} (정규화 ${(trend.normalized * 100).toFixed(0)}%)`;
    action = "진입 없음. 반전 셋업(2.2~2.3)만 감시.";
  }

  if (phase === "마감") {
    dayType = "마감";
    action = "장 마감 — 15:40 장후 배치로 라벨 확정.";
  }

  // 미산출 신호 요약
  if (trend) {
    const na = trend.signals.filter((s) => !s.available).map((s) => s.code);
    if (na.length > 0) dataNotes.push(`미산출 신호(만점 제외): ${na.join("·")} — T-스코어는 가용 만점 대비 비율로 판정`);
  }
  if (ext.basisBlackout) dataNotes.push("B1 만기 주간 — 베이시스 판정 제외 (노이즈)");

  return {
    date: ctx.date,
    ts: nowIso,
    phase, dayType, headline, action,
    bias, trend, divergence, setups, risk, ext,
    crashContext,
    dataNotes,
  };
}

// D1~D4 정합성 (마스터 2.5.3) — D2 나스닥은 기록만(v2.3)
// 비교 기준은 "장중 추세 방향"(시가 대비) — 전일 대비 등락으로 비교하면 큰 갭 후 페이드일(6/12형)에
// 방향이 반대로 읽혀 오판한다. 추세 미형성 시에만 전일 대비 부호로 폴백.
function computeDivergence(ticks: IntradayTick[], dir: "UP" | "DOWN" | null): DivergenceResult {
  const last = ticks[ticks.length - 1];
  const futChg = last?.futChg ?? null;
  const refSign = dir !== null ? (dir === "UP" ? 1 : -1) : futChg !== null && Math.abs(futChg) >= 0.2 ? Math.sign(futChg) : null;
  const cmp = (other: number | null): boolean | null => {
    if (other === null || refSign === null) return null;
    if (Math.abs(other) < 0.2) return null; // 보합권 — 판정 유보
    return Math.sign(other) === refSign;
  };
  const d1ok = cmp(last?.nikkeiChg ?? null);
  const d3ok = cmp(last?.twiiChg ?? null);
  const status: DivergenceResult["status"] =
    d1ok === null && d3ok === null ? "미상"
    : d1ok === false || d3ok === false ? "이탈"
    : "정합";
  return {
    d1: { ok: d1ok, detail: `니케이 ${fmt(last?.nikkeiChg)} vs FKS200 ${fmt(futChg)}` },
    d2: { detail: `나스닥 선물 ${fmt(last?.nqChg)} — 기록 전용(판정 미사용, v2.3)` },
    d3: { ok: d3ok, detail: `대만 자취안 ${fmt(last?.twiiChg)} vs FKS200 ${fmt(futChg)}` },
    status,
    routing: status === "이탈" ? "역발상검토" : status === "정합" ? "추세유지" : null,
  };
}

// 확장 모듈 값 기록 (N1·W1·B1 — 판정 미사용이어도 매일 기록, 확장기획서 0장 원칙 3)
function computeExt(ctx: PremarketContext, ticks: IntradayTick[]): ExtRecord {
  const hynixN1 = nr7Flags(ctx.hynixDaily, true);
  const futN1 = nr7Flags(ctx.k200Daily, true);
  const last = ticks[ticks.length - 1];

  // W1 — breadth + 왜곡 태그
  const breadth = last?.breadth ?? null;
  const idxChg = last?.futChg ?? null;
  const [dLo, dHi] = SIGNAL_CONFIG.ext.w1.distortionBand;
  const distortionTag = breadth !== null && idxChg !== null
    ? breadth >= dLo && breadth <= dHi && Math.abs(idxChg) >= 1
    : null;
  const hynixChg = last?.hynixChg ?? null;
  const breadthDivergence = idxChg !== null && hynixChg !== null ? hynixChg - idxChg : null;

  // B1 — 베이시스 (z-score는 20일 동시간대 축적 후 산출 가능 — 그 전엔 slope만)
  const basisPts = ticks.filter((t) => t.basis !== null);
  const curBasis = basisPts[basisPts.length - 1]?.basis ?? null;
  const past = basisPts.filter((t) => t.minuteOfDay <= (last?.minuteOfDay ?? 0) - 30);
  const basisSlope = curBasis !== null && past.length > 0 ? curBasis - (past[past.length - 1].basis as number) : null;

  return {
    nr7: hynixN1?.nr7 ?? null,
    nr4Ib: hynixN1?.nr4Ib ?? null,
    nr7Fut: futN1?.nr7 ?? null,
    breadth,
    breadthDivergence,
    distortionTag,
    basisZ: null, // 20일 동시간대 축적 전 — null 기록
    basisSlope,
    basisBlackout: isExpiryBlackout(new Date(ctx.date), SIGNAL_CONFIG.ext.b1.expiryBlackoutDays),
    vkospiPeak: null, // 무료 소스 부재 (plan.md)
  };
}

function fmt(v: number | null | undefined): string {
  return v == null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function hm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
