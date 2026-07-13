// 미국 반도체 신호 엔진 — 한국 M7과 같은 2축 구조 (사용자 지정 2026-07-13).
//  축2(가격 확인)는 한국 computeTrend를 그대로 재사용 (SMH → futPx 매핑, 가상 KST 분).
//  축1(usBias)은 미국 세션 특성에 맞춤: 미국 정규장에는 매크로(10Y·DXY·WTI·VIX·NQ)가 실시간으로
//  움직이므로 '전일' 스냅샷이 아닌 장중 라이브 값으로 투표한다.
//  수급(T4·T5·T8·L5)은 데이터 소스 부재 — 자동 미산출(만점 제외).
// 판정: 추세일 상방 → USD(2x) 레버리지 검토 / 추세일 하방 → SSG(-2x) 인버스 검토.

import { SIGNAL_CONFIG } from "../config";
import { US_SIGNAL_CONFIG as U } from "./config";
import { computeTrend } from "../engine/trend";
import { cumReturnPct, consecutiveUpDays, worstCumDeclinePct, gapPct as calcGap } from "../engine/daily";
import type { BiasResult, DailyBar, IntradayTick, TrendResult } from "../types";
import type { UsTickRow } from "./data";
import { toEngineTicks } from "./data";
import type { ChannelAlert } from "@/lib/alerts/dispatch";

export type UsJudgment = {
  date: string;              // ET 거래일
  ts: string;
  phase: "장전" | "관찰" | "판정" | "관리" | "마감";
  dayType: "추세일_상방" | "추세일_하방" | "횡보일" | "V반등후보" | "대기" | "관찰" | "마감" | "이벤트없음";
  headline: string;
  action: string;
  bias: BiasResult;
  trend: TrendResult | null;
  macroGate: { bad: number; detail: string; leverageOk: boolean };
  crash: { active: boolean; cumPct: number | null };
  gapPct: number | null;
  quotes: { smhChg: number | null; usdChg: number | null; ssgChg: number | null; soxChg: number | null };
  dataNotes: string[];
};

// ── usBias — 미국 장중 라이브 매크로 투표 (반도체 성장주 관점: 금리↑·강달러·유가↑·공포↑ = 하방)
export function computeUsBias(last: UsTickRow | undefined): BiasResult {
  const factors: BiasResult["factors"] = [];
  const add = (code: string, label: string, dir: "상방" | "하방" | "중립" | "미상", detail: string, weight = 1) =>
    factors.push({ code, label, dir, detail, weight });
  const M = U.macro;

  if (!last) {
    add("U1", "미 금리(10Y)", "미상", "데이터 대기");
    return { dir: "중립", strength: 0, factors };
  }

  // U1 — 10Y 장중 변화 + 절대 레벨 사다리 (한국 C6과 동일 us10yBands 재사용)
  const pp = last.us10y_chg_pp, lv = last.us10y_px;
  if (pp === null) add("U1", "미 금리(10Y)", "미상", "데이터 없음");
  else {
    const bands = SIGNAL_CONFIG.us10yBands;
    let stIdx = 0;
    if (lv !== null) bands.forEach((b, i) => { if (lv >= b.from) stIdx = i + 1; });
    const easing = pp < -M.us10yPpUp;
    const dir: "상방" | "하방" | "중립" =
      stIdx >= 4 ? "하방"
      : stIdx === 3 ? (easing ? "중립" : "하방")
      : stIdx === 2 ? (pp >= -0.01 ? "하방" : easing ? "상방" : "중립")
      : stIdx === 1 ? (pp > 0 ? "하방" : easing ? "상방" : "중립")
      : pp > M.us10yPpUp ? "하방" : easing ? "상방" : "중립";
    const bandTxt = stIdx > 0 ? `${bands[stIdx - 1].label} 구간 · ` : "";
    add("U1", "미 금리(10Y)", dir, `${bandTxt}${lv !== null ? lv.toFixed(2) + "%" : "?"} · 당일 ${pp > 0 ? "+" : ""}${pp.toFixed(3)}%p`, stIdx >= bands.length ? 2 : 1);
  }

  // U2 — 달러지수
  if (last.dxy_chg === null) add("U2", "달러지수(DXY)", "미상", "데이터 없음");
  else add("U2", "달러지수(DXY)", last.dxy_chg >= M.dxyPct ? "하방" : last.dxy_chg <= -M.dxyPct ? "상방" : "중립",
    `${last.dxy_px != null ? last.dxy_px.toFixed(1) + " · " : ""}${last.dxy_chg > 0 ? "+" : ""}${last.dxy_chg.toFixed(2)}% (기준 ±${M.dxyPct}%)`);

  // U3 — WTI
  if (last.wti_chg === null) add("U3", "WTI 유가", "미상", "데이터 없음");
  else add("U3", "WTI 유가", last.wti_chg >= M.wtiPct ? "하방" : last.wti_chg <= -M.wtiPct ? "상방" : "중립",
    `${last.wti_px != null ? "$" + last.wti_px.toFixed(1) + " · " : ""}${last.wti_chg > 0 ? "+" : ""}${last.wti_chg.toFixed(1)}% (기준 ±${M.wtiPct}%)`);

  // U4 — VIX (공포) — 급등=하방·급락=상방, 절대 레벨 30↑은 추가 경계
  if (last.vix_chg === null) add("U4", "VIX(변동성)", "미상", "데이터 없음");
  else {
    const high = last.vix_px !== null && last.vix_px >= M.vixHighLevel;
    add("U4", "VIX(변동성)", last.vix_chg >= M.vixChgPct || high ? "하방" : last.vix_chg <= -M.vixChgPct ? "상방" : "중립",
      `${last.vix_px?.toFixed(1) ?? "?"} · ${last.vix_chg > 0 ? "+" : ""}${last.vix_chg.toFixed(1)}%${high ? ` (레벨 ${M.vixHighLevel}↑ 경계)` : ""}`);
  }

  // U5 — 나스닥 선물 (동행 참고 — 반도체는 나스닥 베타 상단)
  if (last.nq_chg === null) add("U5", "나스닥 선물", "미상", "데이터 없음");
  else add("U5", "나스닥 선물", last.nq_chg >= M.nqPct ? "상방" : last.nq_chg <= -M.nqPct ? "하방" : "중립",
    `${last.nq_px != null ? Math.round(last.nq_px).toLocaleString("ko-KR") + " · " : ""}${last.nq_chg > 0 ? "+" : ""}${last.nq_chg.toFixed(2)}% (기준 ±${M.nqPct}%)`);

  const ups = factors.filter((f) => f.dir === "상방").reduce((s, f) => s + (f.weight ?? 1), 0);
  const downs = factors.filter((f) => f.dir === "하방").reduce((s, f) => s + (f.weight ?? 1), 0);
  const net = ups - downs;
  const dir: BiasResult["dir"] = net > 0 ? "상방" : net < 0 ? "하방" : "중립";
  return { dir, strength: (dir === "중립" ? 0 : Math.min(3, Math.abs(net))) as 0 | 1 | 2 | 3, factors };
}

// ── 통합 판정
export function decideUs(rows: UsTickRow[], smhDaily: DailyBar[], nowVirtualMin: number, nowIso: string, etDate: string): UsJudgment {
  const dataNotes: string[] = [];
  const S = SIGNAL_CONFIG.session; // 가상 KST 분 매핑이라 한국 세션 상수 그대로 사용
  const last = rows[rows.length - 1];
  const ticks: IntradayTick[] = toEngineTicks(rows);

  // 갭 (SMH — 전일 종가 대비 당일 시가)
  const firstPx = ticks.find((t) => t.futPx !== null)?.futPx ?? null;
  const gap = calcGap(smhDaily, firstPx);

  // 폭락(XS1)·과열 — SMH 일봉
  const crashCum = worstCumDeclinePct(smhDaily, true);
  const crashActive = crashCum !== null && crashCum <= U.crashCumPct;

  const bias = computeUsBias(last);
  const inSession = nowVirtualMin >= S.openMin && rows.length > 0;
  const trend = inSession ? computeTrend(ticks, gap, { dc: { ...U.dc } }) : null;

  // 보수 게이트 (한국과 동일 원칙 — 매크로 정렬 + DC2, US 실측 기준)
  if (trend !== null && trend.grade === "추세일") {
    const aligned = bias.strength >= U.strongDay.minBiasStrength &&
      ((trend.dir === "UP" && bias.dir === "상방") || (trend.dir === "DOWN" && bias.dir === "하방"));
    const efficient = trend.dc2 !== null && trend.dc2 >= U.strongDay.dc2Min;
    if (!(aligned && efficient)) {
      trend.grade = "약한추세";
      dataNotes.push(`보수 게이트 강등: ${aligned ? "" : `매크로 미정렬(${bias.dir} 강도${bias.strength})`}${!aligned && !efficient ? " · " : ""}${efficient ? "" : `DC2 ${trend.dc2?.toFixed(2) ?? "-"} < ${U.strongDay.dc2Min}`}`);
    }
  }

  // LM 매크로 게이트 — 악화(금리↑·강달러·VIX 급등) 2개 이상이면 레버리지(USD) 금지
  const badItems = [
    (last?.us10y_chg_pp ?? 0) > U.macro.us10yPpUp,
    (last?.dxy_chg ?? 0) > U.macro.dxyPct,
    (last?.vix_chg ?? 0) > U.macro.vixChgPct || (last?.vix_px ?? 0) >= U.macro.vixHighLevel,
  ];
  const bad = badItems.filter(Boolean).length;
  const macroGate = {
    bad,
    detail: `악화 ${bad}/3 (10Y↑ ${b(badItems[0])} · DXY↑ ${b(badItems[1])} · VIX ${b(badItems[2])})`,
    leverageOk: bad < 2,
  };

  const phase: UsJudgment["phase"] =
    nowVirtualMin < S.openMin ? "장전"
    : nowVirtualMin < S.observeEndMin ? "관찰"
    : nowVirtualMin <= S.entryEndMin ? "판정"
    : nowVirtualMin <= S.endMin ? "관리"
    : "마감";

  let dayType: UsJudgment["dayType"];
  let headline: string;
  let action: string;

  if (phase === "장전") {
    dayType = "대기";
    headline = `미국 개장 전 — usBias ${bias.dir} 강도${bias.strength}`;
    action = "09:30 ET(한국 22:30/23:30) 개장 후 30분 관찰.";
  } else if (phase === "관찰") {
    dayType = "관찰";
    headline = `관찰 구간 — 갭 ${gap !== null ? (gap > 0 ? "+" : "") + gap.toFixed(1) + "%" : "?"} · usBias ${bias.dir}`;
    action = "진입 금지. Opening Range 확정 대기 (개장+30분).";
  } else if (trend === null || rows.length < 5) {
    dayType = "대기";
    headline = "장중 데이터 부족 — 판정 불가";
    action = "야간 수집 크론이 1분마다 틱을 쌓습니다.";
  } else if (crashActive) {
    dayType = "V반등후보";
    headline = `SMH 직전 1~3일 누적 ${crashCum?.toFixed(1)}% 폭락 — V반등 감시, SSG(인버스) 금지 (XS1)`;
    action = "반전 후 진행 확인 시 USD 검토. 폭락 추격 인버스 금지.";
  } else if (trend.grade === "횡보일선언") {
    dayType = "횡보일";
    headline = `횡보일 — ${trend.swing?.detail ?? "산·골 연결선 방향 없음"}`;
    action = "당일 추세 매매 금지. 구조가 풀리면 자동 재평가.";
  } else if (trend.grade === "추세일" || trend.grade === "약한추세") {
    const weak = trend.grade === "약한추세";
    if (trend.dir === "UP") {
      dayType = "추세일_상방";
      headline = `${weak ? "상방 약한 추세" : "추세일 상방 확정"} — SMH ${fmtPct(last?.smh_chg)} (T ${trend.score.toFixed(1)}/${trend.maxAvailable} · DC1 ${pct(trend.dc1)} · DC2 ${trend.dc2?.toFixed(2) ?? "-"})`;
      action = !macroGate.leverageOk
        ? `USD 진입 보류 — 매크로 게이트 (${macroGate.detail})`
        : weak ? `USD(2x) 1/3 비중만 검토 · 타이트 트레일링` : `USD(2x) 레버리지 진입 검토 · 16:00 ET 당일 청산`;
    } else if (trend.dir === "DOWN") {
      dayType = "추세일_하방";
      headline = `${weak ? "하방 약한 추세" : "추세일 하방 확정"} — SMH ${fmtPct(last?.smh_chg)} (T ${trend.score.toFixed(1)}/${trend.maxAvailable} · DC1 ${pct(trend.dc1)} · DC2 ${trend.dc2?.toFixed(2) ?? "-"})`;
      action = weak ? `SSG(-2x) 1/3 비중만 검토 · 타이트 트레일링` : `SSG(-2x) 인버스 진입 검토 · 16:00 ET 당일 청산`;
    } else {
      dayType = "대기";
      headline = `방향 미형성 (정규화 ${(trend.normalized * 100).toFixed(0)}%)`;
      action = "관망.";
    }
  } else {
    dayType = "대기";
    headline = `비추세 — T ${trend.score.toFixed(1)}/${trend.maxAvailable} (정규화 ${(trend.normalized * 100).toFixed(0)}%)`;
    action = "진입 없음.";
  }
  if (phase === "마감") { dayType = "마감"; action = "미국 정규장 마감."; }

  // X1 — 큰 갭 추격 금지
  if (gap !== null && Math.abs(gap) > U.gapBigPct && phase === "판정" && dayType.startsWith("추세일")) {
    action = `X1: 갭 ${gap > 0 ? "+" : ""}${gap.toFixed(1)}% — 시초 추격 금지, 방향 유지 확인 후. ` + action;
  }

  if (trend) {
    const na = trend.signals.filter((s) => !s.available).map((s) => s.code);
    if (na.length > 0) dataNotes.push(`미산출 신호(만점 제외): ${na.join("·")} — 미국은 수급 데이터 소스 없음`);
  }
  // 과열 참고
  const up = consecutiveUpDays(smhDaily, true);
  const cum5 = cumReturnPct(smhDaily, 5, true);
  if (up >= U.overheatDays || (cum5 !== null && cum5 >= U.overheatCumPct)) {
    dataNotes.push(`과열 경계: SMH 연속상승 ${up}일 · 5일 누적 ${cum5?.toFixed(1) ?? "?"}% — 반전(SSG) 셋업 감시`);
  }

  return {
    date: etDate, ts: nowIso, phase, dayType, headline, action, bias, trend,
    macroGate, crash: { active: crashActive, cumPct: crashCum }, gapPct: gap,
    quotes: { smhChg: last?.smh_chg ?? null, usdChg: last?.usd_chg ?? null, ssgChg: last?.ssg_chg ?? null, soxChg: last?.sox_chg ?? null },
    dataNotes,
  };
}

// ── 알림 — ① 판정 확정 문자 ② SMH 급변·스윙 (한국과 같은 극값 에피소드 재무장 방식)
export function buildUsSignalAlert(j: UsJudgment): ChannelAlert | null {
  if (j.phase !== "판정") return null;
  const t = j.trend;
  if (!t) return null;
  const at = j.ts ? kstHhmm(j.ts) : "--:--";
  const stat = `SMH ${fmtPct(j.quotes.smhChg)}·DC1 ${pct(t.dc1)}·${at}`;
  if (j.dayType === "추세일_상방" && t.grade === "추세일" && j.macroGate.leverageOk) {
    return {
      key: "us_trend_up", severity: "high", smsSubject: "*미국 판정 USD",
      text: `[스탁가드 미국] 추세일 상방 확정 (${stat})\nUSD(2x 반도체) 진입 검토 — USD ${fmtPct(j.quotes.usdChg)}\n16:00 ET(한국 새벽) 당일 청산 원칙`,
    };
  }
  if (j.dayType === "추세일_하방" && t.grade === "추세일" && !j.crash.active) {
    return {
      key: "us_trend_down", severity: "high", smsSubject: "*미국 판정 SSG",
      text: `[스탁가드 미국] 추세일 하방 확정 (${stat})\nSSG(-2x 반도체) 진입 검토 — SSG ${fmtPct(j.quotes.ssgChg)}\n16:00 ET 당일 청산 원칙`,
    };
  }
  return null;
}

export function buildUsMoveAlerts(rows: UsTickRow[]): ChannelAlert[] {
  const last = rows[rows.length - 1];
  if (!last) return [];
  const S = SIGNAL_CONFIG.session;
  if (last.minute_of_day < S.openMin || last.minute_of_day > S.endMin) return [];
  const M = U.moveAlert;
  const chgs = rows.map((r) => r.smh_chg).filter((v): v is number => v !== null && isFinite(v));
  const cur = last.smh_chg;
  if (cur === null || chgs.length === 0) return [];
  const hi = Math.max(...chgs), lo = Math.min(...chgs);
  const hhmm = kstHhmm(last.ts);
  const usdNote = last.usd_chg !== null ? ` USD ${fmtPct(last.usd_chg)}` : "";
  const alerts: ChannelAlert[] = [];

  // 절대 단계 (극값 갱신 중일 때만 — 한국과 동일 원칙)
  const levels: number[] = [];
  for (let v = M.step; v <= M.maxLevel + 1e-9; v += M.step) levels.push(Number(v.toFixed(2)));
  const atExtreme = cur > 0 ? cur >= hi - 0.2 : cur <= lo + 0.2;
  const crossed = levels.filter((lv) => Math.abs(cur) >= lv);
  if (crossed.length > 0 && atExtreme) {
    const level = Math.max(...crossed);
    const dir = cur > 0 ? "급등" : "급락";
    alerts.push({
      key: `us_move_${cur > 0 ? "u" : "d"}${level}`,
      severity: Math.abs(cur) >= 3 * M.step ? "high" : "medium",
      text: `[스탁가드 미국] SMH ${dir} ${cur > 0 ? "+" : ""}${cur.toFixed(1)}% (${hhmm})${usdNote} ${dir === "급락" ? "위험선 점검" : "추세 점검"}`,
    });
  }

  // 반락·반등 스윙 (에피소드 재무장)
  if (chgs.length >= 2) {
    const down = hi - cur;
    if (hi >= M.swingMinExtreme && down >= M.swingStep) {
      const level = Number((Math.floor(down / M.swingStep + 1e-9) * M.swingStep).toFixed(1));
      const epi = Math.floor(hi / M.swingStep + 1e-9);
      alerts.push({
        key: `us_swing_d${level}e${epi}`, severity: down >= 3 * M.swingStep ? "high" : "medium",
        text: `[스탁가드 미국] SMH 반락 고점${hi > 0 ? "+" : ""}${hi.toFixed(1)}%→${cur > 0 ? "+" : ""}${cur.toFixed(1)}% (-${down.toFixed(1)}%p, ${hhmm})${usdNote}`,
      });
    }
    const up = cur - lo;
    if (lo <= -M.swingMinExtreme && up >= M.swingStep) {
      const level = Number((Math.floor(up / M.swingStep + 1e-9) * M.swingStep).toFixed(1));
      const epi = Math.floor(lo / M.swingStep + 1e-9);
      alerts.push({
        key: `us_swing_u${level}e${epi}`, severity: up >= 3 * M.swingStep ? "high" : "medium",
        text: `[스탁가드 미국] SMH 반등 저점${lo.toFixed(1)}%→${cur > 0 ? "+" : ""}${cur.toFixed(1)}% (+${up.toFixed(1)}%p, ${hhmm})${usdNote}`,
      });
    }
  }
  return alerts;
}

function b(v: boolean): string { return v ? "충족" : "-"; }
function pct(v: number | null): string { return v === null ? "-" : `${(v * 100).toFixed(0)}%`; }
function fmtPct(v: number | null | undefined): string { return v == null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`; }
function kstHhmm(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3);
  if (!isFinite(d.getTime())) return "--:--";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
