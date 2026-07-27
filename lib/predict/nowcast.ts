// 국장 피셔 실시간 스냅샷 (사용자 지시 2026-07-23) — /ops "피셔 판정 실시간 알림" 전용.
// 판정 로직 변경 없는 조회 전용: 사용자가 버튼으로 문의하면 현재 완성봉 기준 F/M/본 상태를
// 계산해 웹 상세 + 문자 요약으로 답한다. 창 규칙은 라이브 스트림과 동일 —
// F·M = 08:00 연속창(NXT 프리장+정규장), 본피셔 = 09:00 정규장창(창 미형성 시 08시창 참고 표기).
// 개정 (ops 지시 2026-07-23 저녁): ①하닉·삼전 별도 조회 ②15:30 이후엔 NXT 애프터마켓
// 실시간 판정 — 기존엔 18시 문의에도 정규장 15:30 결과가 나왔음(실사용 지적). 애프터 판정
// 방식은 하닉 애프터 스트림(after.ts)과 동일(피셔 단독·오프셋 = 세션 시가 0.4%)을 두 종목 공통 적용.

import { createAdminClient } from "@/lib/supabase/admin";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict } from "./data";
import { avgRange, isHighVolDay } from "./indicators";
import { fetchDayMinutes, fetchNxtAfterMarket, fetchNxtPremarket, fetchTodayMinutes } from "./kisMinute";
import { runFisher } from "./models/fisher";
import { loadDayRow } from "./store";
import type { MinuteBar, PredictDailyBar, Verdict } from "./types";

export type NowTier = { name: string; verdict: Verdict; confirmedAt: string | null; note: string };
export type FisherNow = {
  market: "kr" | "us";
  title: string;
  asOf: string; // KST "YYYY-MM-DD HH:MM"
  session: string;
  official: string | null; // 라이브 스트림의 현재 공식 판정
  tiers: NowTier[];
  priceLine: string | null;
  stopLine: string | null;
  summary: string; // 문자 본문 (핵심 요약)
  detail: string[]; // 웹 상세
};

export type KrStock = "hx" | "ss"; // 하닉 000660 · 삼전 005930

const V_KO: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };
const V_SHORT: Record<Verdict, string> = { leverage: "레버", inverse: "인버", none: "추세없음" };
// 애프터장은 본주 전용(ETF 미운영) — 방향 라벨을 애프터 스트림(after.ts)과 통일
const V_AH: Record<Verdict, string> = { leverage: "상방(본주 매수)", inverse: "하방(관망·청산)", none: "추세없음" };
const V_AH_SHORT: Record<Verdict, string> = { leverage: "상방", inverse: "하방", none: "없음" };
const confirmOf = (reason: string): string | null => reason.match(/^(\d{2}:\d{2}) A[상하] 확인/)?.[1] ?? null;

export function kstNowStr(): { date: string; hhmm: string } {
  const kst = new Date(Date.now() + 9 * 3600e3);
  return { date: kst.toISOString().slice(0, 10), hhmm: kst.toISOString().slice(11, 16) };
}

export async function fisherNowKr(stock: KrStock = "hx"): Promise<FisherNow> {
  const { date: today, hhmm } = kstNowStr();
  const isHx = stock === "hx";
  const code = isHx ? PREDICT_CONFIG.symbol : "005930";
  const nameKo = isHx ? "하닉" : "삼전";
  const ymd = today.replace(/-/g, "");

  const daily = await fetchDailyPredict(code, 140);
  const hist = daily.filter((b) => b.date < today).slice(-120);
  const pre = await fetchNxtPremarket(code, ymd);
  let krx: MinuteBar[] | null = await fetchDayMinutes(code, ymd, "153000");
  // 당일 폴백은 평일만 — fetchTodayMinutes는 날짜 필터가 없어 주말엔 직전 거래일 봉을
  // 오늘 것처럼 반환한다 (2026-07-25 토요일 실측: 금요일 세션이 '정규장'으로 표시됨)
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  if ((!krx || krx.length < 5) && dow >= 1 && dow <= 5) krx = await fetchTodayMinutes(code, "153000");
  const bars08 = [...(pre ?? []), ...(krx ?? [])];

  const base: FisherNow = {
    market: "kr",
    title: isHx ? "국장 하닉 (SK하이닉스 000660)" : "국장 삼전 (삼성전자 005930)",
    asOf: `${today} ${hhmm}`,
    session: "", official: null, tiers: [], priceLine: null, stopLine: null, summary: "", detail: [],
  };

  // ── 정규장 F/M/본 (두 종목 동일 규칙 — 08시 연속창 F·M, 09시 정규장창 본)
  let F: ReturnType<typeof runFisher> | null = null;
  let M: ReturnType<typeof runFisher> | null = null;
  let B: ReturnType<typeof runFisher> | null = null;
  let bonNote = "09:00 정규장창·강돌파 포함";
  if (bars08.length >= 16) {
    // 강돌파: 하닉 0.1 / 삼전 0.075 (사용자 승인 2026-07-25 종목 분리 — config.ssStrongBreakRatio)
    const sb = isHx ? PREDICT_CONFIG.earlyStrongBreakRatio : PREDICT_CONFIG.ssStrongBreakRatio;
    const sbLate = isHx ? PREDICT_CONFIG.lateStrongBreakRatio : PREDICT_CONFIG.ssStrongBreakRatio;
    // 고변동일 트레일 반전 (하닉 2026-07-25 · 삼전 2026-07-27 승인) — 스트림과 동일 조건으로 미러
    // (조회 일치). 문턱 종목 분리: 하닉 config.hxTrail / 삼전 config.ssTrail.
    const trailCfg = isHx ? PREDICT_CONFIG.hxTrail : PREDICT_CONFIG.ssTrail;
    const trailOpts = isHighVolDay(hist)
      ? { trailRangeRatio: trailCfg.rangeRatio, trailConfirmMinutes: trailCfg.confirmMinutes }
      : {};
    const input08 = { date: today, dailyHistory: hist, openPx: pre?.[0]?.open ?? bars08[0].open, morning: bars08, prevDayMinutes: null };
    F = runFisher(input08, {
      offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio,
      confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes,
      strongBreakRatio: sb,
      reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, // F·M도 반전 3봉 (2026-07-25 2차 승인)
    });
    M = runFisher(input08, { offsetRangeRatio: 0.1, confirmMinutes: 8, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes });
    if (krx && krx.length >= 20) {
      B = runFisher(
        { date: today, dailyHistory: hist, openPx: krx[0].open, morning: krx, prevDayMinutes: null },
        { strongBreakRatio: sbLate, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, ...trailOpts },
      );
    } else {
      B = runFisher(input08, { strongBreakRatio: sbLate, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, ...trailOpts });
      bonNote = "정규장 창 형성 전 — 08시창 참고";
    }
  }
  const regTiers: NowTier[] = F && M && B ? [
    { name: "피셔F (0.05·4봉+강돌파)", verdict: F.verdict, confirmedAt: confirmOf(F.reason), note: F.reason },
    { name: "피셔M (0.10·8봉)", verdict: M.verdict, confirmedAt: confirmOf(M.reason), note: M.reason },
    { name: `본피셔 (0.15·8봉·${bonNote})`, verdict: B.verdict, confirmedAt: confirmOf(B.reason), note: B.reason },
  ] : [];
  const regSms = regTiers
    .map((t) => `${t.name.split(" ")[0].replace("피셔", "")} ${V_SHORT[t.verdict]}${t.confirmedAt ? `(${t.confirmedAt})` : ""}`)
    .join("·");

  // 공식 판정 (라이브 스트림) — 하닉 전용 (predict_days 스트림이 하닉 기준)
  if (isHx) {
    try {
      const row = await loadDayRow(today);
      if (row) base.official = `${V_KO[row.final_verdict]} (강도 ${row.strength}%${row.stage === "final" ? "·확정" : ""})`;
    } catch { /* 스트림 기록 없음 — 계산값만 표시 */ }
  }

  // ── 애프터장 분기 (15:31~) — NXT 애프터마켓 15:30~20:00 실시간 판정
  if (hhmm >= "15:31") {
    return fisherNowKrAfter(base, { stock, code, nameKo, today, hhmm, ymd, hist, regTiers, regSms });
  }

  // ── 정규장 분기 (기존 동작)
  if (bars08.length < 16) {
    base.session = "데이터 없음 — 휴장이거나 프리장 시초 레인지(08:00~08:15) 형성 전";
    base.summary = `[피셔 실시간·${nameKo} ${hhmm}] 판정 불가 — ${base.session}`;
    base.detail = [base.session];
    return base;
  }

  base.session = hhmm < "09:00" ? "NXT 프리장 (정규장 09:00 개장 전)" : "정규장";
  const last = krx && krx.length ? krx[krx.length - 1] : bars08[bars08.length - 1];
  base.priceLine = `${nameKo} ${last.close.toLocaleString()}원 (${last.time} 완성봉)`;
  base.tiers = regTiers;

  // 스탑 금액 — 방향(공식 판정 우선, 없으면 F)의 실매매 ETF 현재가 기준 -3% (하닉 전용 — 삼전은 ETF 미설정)
  if (isHx) {
    const dir: Verdict = base.official?.startsWith("레버리지") ? "leverage"
      : base.official?.startsWith("인버스") ? "inverse"
      : F?.verdict ?? "none";
    if (dir !== "none") {
      try {
        const p = dir === "leverage" ? PREDICT_CONFIG.etf.leverage : PREDICT_CONFIG.etf.inverse;
        const etf = await fetchDailyPredict(p.code, 2);
        const e = etf[etf.length - 1];
        if (e && e.date === today && e.close > 0) {
          const stopPct = PREDICT_CONFIG.stops.fisher.hxEtfPct; // 하닉 전용 블록 — 스탑 폭 분리 (2026-07-28)
          const stop = Math.floor((e.close * (1 - stopPct / 100)) / 5) * 5;
          base.stopLine = `${p.name} ${e.close.toLocaleString()}원 → 지금 진입 시 스탑 ${stop.toLocaleString()}원 (-${stopPct}%)`;
        }
      } catch { /* ETF 시세 실패 — 스탑 줄 생략 */ }
    }
  }

  base.summary =
    `[피셔 실시간·${nameKo} ${hhmm}] ${base.official ? `공식 ${base.official}` : isHx ? "공식판정 기록 없음" : "계산값 (삼전은 공식 스트림 없음)"}\n` +
    `${regSms} | ${base.priceLine}` +
    (base.stopLine ? `\n▶${base.stopLine}` : "");
  base.detail = [
    `세션: ${base.session}`,
    isHx ? `공식 판정(라이브 스트림): ${base.official ?? "기록 없음"}` : "공식 판정: 삼전은 스트림 기록 없음 — 아래는 실시간 계산값",
    ...base.tiers.map((t) => `${t.name}: ${V_KO[t.verdict]}${t.confirmedAt ? ` — ${t.confirmedAt} 확인` : ""} · ${t.note}`),
    base.priceLine ?? "",
    base.stopLine ? `스탑: ${base.stopLine}` : `스탑: ${isHx ? "방향 판정 없음 — 해당 없음" : "삼전은 실매매 ETF 미설정 — 표기 생략"}`,
    "비중 프로토콜: F 50% → M 동방향 +30%p → 본피셔 확정 +20%p (반대 확인 시 축소·청산)",
  ].filter(Boolean);
  return base;
}

// 애프터장 실시간 (ops 지시 2026-07-23) — 하닉 애프터 스트림(after.ts)과 동일 방식을 두 종목 공통 적용:
// 피셔 단독 · OR 15:30~15:45 · 오프셋 = 세션 시가 × 0.4% (runFisher ratio로 환산) · 확인 8봉.
async function fisherNowKrAfter(
  base: FisherNow,
  ctx: { stock: KrStock; code: string; nameKo: string; today: string; hhmm: string; ymd: string; hist: PredictDailyBar[]; regTiers: NowTier[]; regSms: string },
): Promise<FisherNow> {
  const { stock, code, nameKo, today, hhmm, ymd, hist, regTiers, regSms } = ctx;
  const AH = PREDICT_CONFIG.after;
  base.session = hhmm <= "20:00" ? "NXT 애프터마켓 15:30~20:00 (실시간)" : "애프터장 종료 — 오늘 세션 최종 상태";

  const bars = await fetchNxtAfterMarket(code, ymd, "200000");
  const range10 = avgRange(hist, 10);

  let afterTier: NowTier | null = null;
  if (bars && bars.length >= 23 && range10 !== null) {
    const offsetRatio = ((AH.offsetPct / 100) * bars[0].open) / range10;
    const out = runFisher(
      { date: today, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null },
      { offsetRangeRatio: offsetRatio, earlyConfirmBy: "17:00" },
    );
    afterTier = { name: "애프터 피셔 (시가 0.4%·8봉)", verdict: out.verdict, confirmedAt: confirmOf(out.reason), note: out.reason };
    base.tiers = [afterTier];
  }
  if (bars && bars.length) {
    const lastA = bars[bars.length - 1];
    base.priceLine = `${nameKo} ${lastA.close.toLocaleString()}원 (${lastA.time} 애프터봉)`;
  }

  // 애프터 공식 판정 (predict_after_days — 하닉 애프터 스트림 전용)
  if (stock === "hx") {
    try {
      const admin = createAdminClient();
      const { data } = await admin
        .from("predict_after_days")
        .select("final_verdict, strength, stage")
        .eq("date", today)
        .maybeSingle();
      if (data) {
        const row = data as { final_verdict: Verdict; strength: number; stage: string };
        base.official = `${V_AH[row.final_verdict]} (강도 ${row.strength}%${row.stage === "final" ? "·확정" : ""})`;
      }
    } catch { /* 마이그레이션 027 미적용 또는 기록 없음 — 계산값만 */ }
  }

  const notReady = !afterTier
    ? (!bars || bars.length === 0
      ? "애프터 체결 데이터 없음 — 휴장·NXT 비거래일이거나 세션 시초 직후"
      : "애프터 시초 레인지(15:30~15:45)+확인봉 형성 전 — 15:53경부터 판정 가능")
    : null;

  const headline = afterTier
    ? `애프터 ${V_AH_SHORT[afterTier.verdict]}${afterTier.confirmedAt ? `(${afterTier.confirmedAt} 확인)` : ""}`
    : `애프터 판정 불가`;
  base.summary =
    `[피셔 실시간·${nameKo} ${hhmm}] ${headline}${base.official ? ` · 공식 ${base.official}` : ""}${notReady ? ` — ${notReady}` : ""}\n` +
    `정규장최종 ${regSms || "기록 없음"}${base.priceLine ? ` | ${base.priceLine}` : ""}` +
    (afterTier && afterTier.verdict !== "none"
      ? `\n▶애프터 본주 전용(ETF 미운영) · 스탑 본주 -1.5% · 20:00 세션 종료 전 청산 — 미검증 신호, 소액만`
      : "");
  base.detail = [
    `세션: ${base.session}`,
    stock === "hx"
      ? `애프터 공식 판정(스트림): ${base.official ?? "기록 없음"}`
      : "애프터 공식 판정: 삼전은 애프터 스트림 없음 — 아래는 실시간 계산값 (하닉과 동일 방식)",
    afterTier
      ? `${afterTier.name}: ${V_AH[afterTier.verdict]}${afterTier.confirmedAt ? ` — ${afterTier.confirmedAt} 확인` : ""} · ${afterTier.note}`
      : notReady!,
    ...(regTiers.length
      ? [`정규장 최종(참고): ${regTiers.map((t) => `${t.name.split(" ")[0]} ${V_KO[t.verdict]}${t.confirmedAt ? `(${t.confirmedAt})` : ""}`).join(" · ")}`]
      : []),
    base.priceLine ?? "",
    afterTier && afterTier.verdict !== "none"
      ? "지침: 애프터장은 본주 전용(레버·인버스 ETF 미운영) · 스탑 본주 -1.5% · 20:00 세션 종료 전 청산 — 미검증 신호, 소액만"
      : "지침: 방향 없음 — 진입 대기",
  ].filter(Boolean);
  return base;
}
