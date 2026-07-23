// 미장 피셔 실시간 스냅샷 (사용자 지시 2026-07-23) — /ops "피셔 판정 실시간 알림" 전용.
// 국장 lib/predict/nowcast.ts의 미국판 — 판정 로직 변경 없는 조회 전용.
// 창 규칙은 predictStream과 동일: F·M = 07:00 ET 연속창(프리장+정규장), 본피셔 = 09:30 정규장창.
// FisherNow 타입은 국장 모듈에서 type-only import (런타임 결합 없음 — lib 분리 원칙 유지).

import { createAdminClient } from "@/lib/supabase/admin";
import { avgRange } from "@/lib/predict/indicators";
import type { Verdict } from "@/lib/predict/types";
import type { FisherNow } from "@/lib/predict/nowcast";
import { US_SIGNAL_CONFIG } from "./config";
import { etNow } from "./data";
import { ET_OPEN, ET_CLOSE, ET_PRE_START, runUsFisher, type UsBar } from "./models";
import { fetchJudge5m, fetchJudgeDaily } from "./predictStream";

const UP = US_SIGNAL_CONFIG.usPredict;
const SY = UP.symbols;
const V_KO: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };
const V_SHORT: Record<Verdict, string> = { leverage: "레버", inverse: "인버", none: "없음" };
const confirmOf = (reason: string): string | null => reason.match(/^(\d{2}:\d{2}) A[상하] 확인/)?.[1] ?? null;

export async function fisherNowUs(): Promise<FisherNow> {
  const { date: etToday, minuteOfDay: etMin } = etNow();
  const kst = new Date(Date.now() + 9 * 3600e3);
  const hhmm = kst.toISOString().slice(11, 16);

  const base: FisherNow = {
    market: "us", title: `미장 (판정 ${SY.judge} · 체결 ${SY.leverage}/${SY.inverse})`,
    asOf: `${kst.toISOString().slice(0, 10)} ${hhmm} KST (ET ${String(Math.floor(etMin / 60)).padStart(2, "0")}:${String(etMin % 60).padStart(2, "0")})`,
    session: "", official: null, tiers: [], priceLine: null, stopLine: null, summary: "", detail: [],
  };

  const byDay = await fetchJudge5m(6);
  // 오늘 ET 세션이 없으면(주말·개장 전) 가장 최근 세션으로 폴백
  const days = [...byDay.keys()].sort();
  const sessionDate = byDay.has(etToday) && (byDay.get(etToday) ?? []).some((b) => b.etMin >= ET_PRE_START)
    ? etToday : days[days.length - 1];
  const raw = byDay.get(sessionDate) ?? [];
  const isToday = sessionDate === etToday;
  // 완성봉만 (오늘 세션이면 진행 중 5분봉 제외)
  const all = raw.filter((b) => !isToday || b.etMin + 5 <= etMin);
  const win07 = all.filter((b) => b.etMin >= ET_PRE_START && b.etMin < ET_CLOSE);
  const win930 = all.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);

  if (win07.length < 4) {
    base.session = `데이터 없음 — 세션 ${sessionDate} 관찰창(07:00 ET~) 형성 전이거나 야후 수집 실패`;
    base.summary = `[피셔 실시간·미장 ${hhmm}] 판정 불가 — ${base.session}`;
    base.detail = [base.session];
    return base;
  }

  base.session = !isToday
    ? `마감 — 최근 세션 ${sessionDate} (ET) 최종 상태`
    : etMin < ET_OPEN ? "프리마켓 (정규장 09:30 ET 개장 전)" : etMin < ET_CLOSE ? "정규장" : "장 마감 — 오늘 세션 최종 상태";

  const daily = await fetchJudgeDaily(30);
  const hist = daily.filter((b) => b.date < sessionDate);
  const lastBar = (win930.length ? win930 : win07)[Math.max(0, (win930.length ? win930 : win07).length - 1)];
  base.priceLine = `${SY.judge} ${lastBar.close.toFixed(2)}$ (${lastBar.time} ET 완성봉)`;

  const F = runUsFisher(win07, hist, UP.fisherF.offsetRangeRatio, {
    confirmBars: UP.fisherF.confirmBars, strongBreakRatio: UP.fisherF.strongBreakRatio,
  });
  const M = runUsFisher(win07, hist, UP.fisherM.offsetRangeRatio, { confirmBars: UP.fisherM.confirmBars });
  const bonReady = win930.length >= 4;
  const B = bonReady
    ? runUsFisher(win930, hist, UP.offsetRangeRatio)
    : runUsFisher(win07, hist, UP.offsetRangeRatio);
  base.tiers = [
    { name: "피셔F (0.05·1봉+강돌파·07시창)", verdict: F.verdict, confirmedAt: confirmOf(F.reason), note: F.reason },
    { name: "피셔M (0.10·2봉·07시창)", verdict: M.verdict, confirmedAt: confirmOf(M.reason), note: M.reason },
    { name: `본피셔 (0.15·2봉·${bonReady ? "09:30창" : "정규장 창 형성 전 — 07시창 참고"})`, verdict: B.verdict, confirmedAt: confirmOf(B.reason), note: B.reason },
  ];

  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("us_predict_days")
      .select("final_verdict, strength, stage")
      .eq("date", sessionDate)
      .maybeSingle();
    if (data) base.official = `${V_KO[data.final_verdict as Verdict]} (강도 ${data.strength}%${data.stage === "final" ? "·확정" : ""})`;
  } catch { /* 마이그레이션 029 미적용·기록 없음 — 계산값만 */ }

  // 스탑 — 방향의 3x ETF 최근 5분봉 종가 기준 (SOXX 스탑 2.0% × 3배 = ETF -6%)
  const dir: Verdict = base.official?.startsWith("레버리지") ? "leverage"
    : base.official?.startsWith("인버스") ? "inverse"
    : F.verdict;
  if (dir !== "none") {
    try {
      const etfSym = dir === "leverage" ? SY.leverage : SY.inverse;
      const { default: YahooFinance } = await import("yahoo-finance2");
      const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
      const r = await yf.chart(etfSym, { period1: new Date(Date.now() - 3 * 86400e3), interval: "5m", includePrePost: true });
      const qs = (r.quotes ?? []).filter((q) => q.close != null);
      const px = qs.length ? (qs[qs.length - 1].close as number) : null;
      if (px) {
        const stopPct = UP.stopPct * SY.leverageX;
        base.stopLine = `${etfSym} ${px.toFixed(2)}$ → 지금 진입 시 스탑 ${(px * (1 - stopPct / 100)).toFixed(2)}$ (-${stopPct.toFixed(1)}%)`;
      }
    } catch { /* ETF 시세 실패 — 스탑 줄 생략 */ }
  }

  const tierSms = base.tiers
    .map((t) => `${t.name.split(" ")[0].replace("피셔", "")} ${V_SHORT[t.verdict]}${t.confirmedAt ? `(${t.confirmedAt}ET)` : ""}`)
    .join("·");
  base.summary =
    `[피셔 실시간·미장 ${hhmm}] ${base.official ? `공식 ${base.official}` : "공식판정 기록 없음"} (세션 ${sessionDate})\n` +
    `${tierSms} | ${base.priceLine}` +
    (base.stopLine ? `\n▶${base.stopLine}` : "");
  base.detail = [
    `세션: ${base.session}`,
    `공식 판정(라이브 스트림): ${base.official ?? "기록 없음"}`,
    ...base.tiers.map((t) => `${t.name}: ${V_KO[t.verdict]}${t.confirmedAt ? ` — ${t.confirmedAt} ET 확인` : ""} · ${t.note}`),
    base.priceLine ?? "",
    base.stopLine ? `스탑: ${base.stopLine}` : "스탑: 방향 판정 없음 — 해당 없음",
    "비중 프로토콜: F 50% → M 동방향 +30%p → 본피셔 확정 +20%p (반대 확인 시 축소·청산)",
  ].filter(Boolean);
  return base;
}
