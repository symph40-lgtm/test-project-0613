// 국장 피셔 실시간 스냅샷 (사용자 지시 2026-07-23) — /ops "피셔 판정 실시간 알림" 전용.
// 판정 로직 변경 없는 조회 전용: 사용자가 버튼으로 문의하면 현재 완성봉 기준 F/M/본 상태를
// 계산해 웹 상세 + 문자 요약으로 답한다. 창 규칙은 라이브 스트림과 동일 —
// F·M = 08:00 연속창(NXT 프리장+정규장), 본피셔 = 09:00 정규장창(창 미형성 시 08시창 참고 표기).

import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict } from "./data";
import { avgRange } from "./indicators";
import { fetchDayMinutes, fetchNxtPremarket, fetchTodayMinutes } from "./kisMinute";
import { runFisher } from "./models/fisher";
import { loadDayRow } from "./store";
import type { MinuteBar, Verdict } from "./types";

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

const V_KO: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };
const V_SHORT: Record<Verdict, string> = { leverage: "레버", inverse: "인버", none: "없음" };
const confirmOf = (reason: string): string | null => reason.match(/^(\d{2}:\d{2}) A[상하] 확인/)?.[1] ?? null;

export function kstNowStr(): { date: string; hhmm: string } {
  const kst = new Date(Date.now() + 9 * 3600e3);
  return { date: kst.toISOString().slice(0, 10), hhmm: kst.toISOString().slice(11, 16) };
}

export async function fisherNowKr(): Promise<FisherNow> {
  const { date: today, hhmm } = kstNowStr();
  const code = PREDICT_CONFIG.symbol;
  const ymd = today.replace(/-/g, "");

  const daily = await fetchDailyPredict(code, 140);
  const hist = daily.filter((b) => b.date < today);
  const pre = await fetchNxtPremarket(code, ymd);
  let krx: MinuteBar[] | null = await fetchDayMinutes(code, ymd, "153000");
  if (!krx || krx.length < 5) krx = await fetchTodayMinutes(code, "153000");
  const bars08 = [...(pre ?? []), ...(krx ?? [])];

  const base: FisherNow = {
    market: "kr", title: "국장 (SK하이닉스 000660)", asOf: `${today} ${hhmm}`,
    session: "", official: null, tiers: [], priceLine: null, stopLine: null, summary: "", detail: [],
  };

  if (bars08.length < 16) {
    base.session = "데이터 없음 — 휴장이거나 프리장 시초 레인지(08:00~08:15) 형성 전";
    base.summary = `[피셔 실시간·국장 ${hhmm}] 판정 불가 — ${base.session}`;
    base.detail = [base.session];
    return base;
  }

  base.session = hhmm < "09:00" ? "NXT 프리장 (정규장 09:00 개장 전)" : hhmm <= "15:30" ? "정규장" : "장 마감 — 오늘 세션 최종 상태";
  const last = krx && krx.length ? krx[krx.length - 1] : bars08[bars08.length - 1];
  base.priceLine = `하닉 ${last.close.toLocaleString()}원 (${last.time} 완성봉)`;

  const input08 = { date: today, dailyHistory: hist.slice(-120), openPx: pre?.[0]?.open ?? bars08[0].open, morning: bars08, prevDayMinutes: null };
  const F = runFisher(input08, {
    offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio,
    confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes,
    strongBreakRatio: PREDICT_CONFIG.earlyStrongBreakRatio,
  });
  const M = runFisher(input08, { offsetRangeRatio: 0.1, confirmMinutes: 8 });
  // 본피셔 — 09:00 정규장창 (10:30 이후 공식 창). 정규장 초반이라 창 미형성이면 08시창 참고
  let bonNote = "09:00 정규장창·강돌파 포함";
  let B;
  if (krx && krx.length >= 20) {
    B = runFisher(
      { date: today, dailyHistory: hist.slice(-120), openPx: krx[0].open, morning: krx, prevDayMinutes: null },
      { strongBreakRatio: PREDICT_CONFIG.lateStrongBreakRatio },
    );
  } else {
    B = runFisher(input08, { strongBreakRatio: PREDICT_CONFIG.lateStrongBreakRatio });
    bonNote = "정규장 창 형성 전 — 08시창 참고";
  }
  base.tiers = [
    { name: "피셔F (0.05·4봉+강돌파)", verdict: F.verdict, confirmedAt: confirmOf(F.reason), note: F.reason },
    { name: "피셔M (0.10·8봉)", verdict: M.verdict, confirmedAt: confirmOf(M.reason), note: M.reason },
    { name: `본피셔 (0.15·8봉·${bonNote})`, verdict: B.verdict, confirmedAt: confirmOf(B.reason), note: B.reason },
  ];

  try {
    const row = await loadDayRow(today);
    if (row) base.official = `${V_KO[row.final_verdict]} (강도 ${row.strength}%${row.stage === "final" ? "·확정" : ""})`;
  } catch { /* 스트림 기록 없음 — 계산값만 표시 */ }

  // 스탑 금액 — 방향(공식 판정 우선, 없으면 F)의 실매매 ETF 현재가 기준 -3%
  const dir: Verdict = base.official?.startsWith("레버리지") ? "leverage"
    : base.official?.startsWith("인버스") ? "inverse"
    : F.verdict;
  if (dir !== "none") {
    try {
      const p = dir === "leverage" ? PREDICT_CONFIG.etf.leverage : PREDICT_CONFIG.etf.inverse;
      const etf = await fetchDailyPredict(p.code, 2);
      const e = etf[etf.length - 1];
      if (e && e.date === today && e.close > 0) {
        const stopPct = PREDICT_CONFIG.stops.fisher.etfPct;
        const stop = Math.floor((e.close * (1 - stopPct / 100)) / 5) * 5;
        base.stopLine = `${p.name} ${e.close.toLocaleString()}원 → 지금 진입 시 스탑 ${stop.toLocaleString()}원 (-${stopPct}%)`;
      }
    } catch { /* ETF 시세 실패 — 스탑 줄 생략 */ }
  }

  const tierSms = base.tiers
    .map((t) => `${t.name.split(" ")[0].replace("피셔", "")} ${V_SHORT[t.verdict]}${t.confirmedAt ? `(${t.confirmedAt})` : ""}`)
    .join("·");
  base.summary =
    `[피셔 실시간·국장 ${hhmm}] ${base.official ? `공식 ${base.official}` : "공식판정 기록 없음"}\n` +
    `${tierSms} | ${base.priceLine}` +
    (base.stopLine ? `\n▶${base.stopLine}` : "");
  base.detail = [
    `세션: ${base.session}`,
    `공식 판정(라이브 스트림): ${base.official ?? "기록 없음"}`,
    ...base.tiers.map((t) => `${t.name}: ${V_KO[t.verdict]}${t.confirmedAt ? ` — ${t.confirmedAt} 확인` : ""} · ${t.note}`),
    base.priceLine ?? "",
    base.stopLine ? `스탑: ${base.stopLine}` : "스탑: 방향 판정 없음 — 해당 없음",
    "비중 프로토콜: F 50% → M 동방향 +30%p → 본피셔 확정 +20%p (반대 확인 시 축소·청산)",
  ].filter(Boolean);
  return base;
}
