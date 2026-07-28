// TIGER 반도체TOP10(396500) 모니터링 스트림 1단계 (사용자 승인 2026-07-28 밤 — 국내판 SOXX).
// 판정 396500 · 상방 체결 488080(2x) · 하방은 기존 삼전 인버스2x 채널. NXT 프리·애프터 미거래라
// 전 단계 09시창(09:00~09:15 OR) — F(0.05·2봉)·M(0.08·6봉)·본(0.15·5봉·트레일 0.5×3 전일).
// 상수 근거: scripts/etf-param-optimize.ts 120일 전 축 스윕 (config.etfTop10 주석).
// 1단계 = 문자·기록 전용 (기존 삼전·하닉 실투자 판정 불변) — 60일 라이브 채점 후 승격 검토.
// 문자 키 predict_tr_etf* — 일시정지 '판정 허용'(PAUSE_ALLOW_KEYS의 predict_tr) 통과 형태.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict } from "./data";
import { avgRange } from "./indicators";
import { fetchDayMinutes, fetchTodayMinutes } from "./kisMinute";
import { runFisher } from "./models/fisher";
import type { FisherNow } from "./nowcast";
import type { MinuteBar, PredictDailyBar, Verdict } from "./types";

const CFG = PREDICT_CONFIG.etfTop10;
const V_KO: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };
const V_SHORT: Record<Verdict, string> = { leverage: "레버", inverse: "인버", none: "없음" };
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type Tiers = { F: ReturnType<typeof runFisher>; M: ReturnType<typeof runFisher>; B: ReturnType<typeof runFisher> };

async function loadInputs(): Promise<{ today: string; hist: PredictDailyBar[]; reg: MinuteBar[] } | null> {
  const kst = kstNow();
  const today = kst.toISOString().slice(0, 10);
  const daily = await fetchDailyPredict(CFG.code, 140);
  const hist = daily.filter((b) => b.date < today).slice(-120);
  if (hist.length < 30 || avgRange(hist, 10) === null) return null;
  let reg = await fetchDayMinutes(CFG.code, today.replace(/-/g, ""), "153000");
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  if ((!reg || reg.length < 5) && dow >= 1 && dow <= 5) reg = await fetchTodayMinutes(CFG.code, "153000");
  if (!reg || reg.length < 16) return null; // 09:15 OR 형성 전·휴장·조회 실패
  return { today, hist, reg };
}

function judgeTiers(today: string, hist: PredictDailyBar[], reg: MinuteBar[]): Tiers {
  const input = { date: today, dailyHistory: hist, openPx: reg[0].open, morning: reg, prevDayMinutes: null };
  const F = runFisher(input, {
    offsetRangeRatio: CFG.F.offsetRatio, confirmMinutes: CFG.F.confirmMinutes,
    strongBreakRatio: CFG.strongBreakRatio, reversalMinutes: CFG.reversalMinutes,
  });
  const M = runFisher(input, {
    offsetRangeRatio: CFG.M.offsetRatio, confirmMinutes: CFG.M.confirmMinutes, reversalMinutes: CFG.reversalMinutes,
  });
  const B = runFisher(input, {
    offsetRangeRatio: CFG.B.offsetRatio, confirmMinutes: CFG.B.confirmMinutes,
    strongBreakRatio: CFG.strongBreakRatio, reversalMinutes: CFG.reversalMinutes,
    trailRangeRatio: CFG.trail.rangeRatio, trailConfirmMinutes: CFG.trail.confirmMinutes,
  });
  return { F, M, B };
}

// 488080 스탑 라인 (상방 체결용) — 시세 실패 시 생략
async function levStopLine(): Promise<string> {
  try {
    const d = await fetchDailyPredict(CFG.lev.code, 2);
    const last = d[d.length - 1];
    if (!last || last.close <= 0) return "";
    const stopPct = CFG.stopBasePct * 2; // 기준 1x -1.5% ≈ 2x -3%
    const stop = Math.floor((last.close * (1 - stopPct / 100)) / 5) * 5;
    return `\n▶${CFG.lev.name} ${last.close.toLocaleString()}원 → 진입 시 스탑 ${stop.toLocaleString()}원 (-${stopPct}%)`;
  } catch { return ""; }
}

// 전이 모니터 — runPredictService 말미에서 매분 호출 (실패는 삼켜 기존 스트림에 무영향)
export async function runEtfTop10Monitor(): Promise<void> {
  try {
    const kst = kstNow();
    const dow = new Date(`${kst.toISOString().slice(0, 10)}T00:00:00Z`).getUTCDay();
    const minuteOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (dow < 1 || dow > 5) return;
    if (minuteOfDay < hhmmToMin("09:17") || minuteOfDay > hhmmToMin("15:25")) return; // 판정·발송 창
    const inputs = await loadInputs();
    if (!inputs) return;
    const { today, hist, reg } = inputs;
    const { F, M, B } = judgeTiers(today, hist, reg);

    const admin = createAdminClient();
    type EtfState = { date: string; F: Verdict; M: Verdict; B: Verdict };
    const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "predict_etf_state").maybeSingle();
    const prev = (stRow?.value ?? null) as EtfState | null;
    const sameDay = prev !== null && prev.date === today;
    const px = reg[reg.length - 1];
    const stateLine = `\nTOP10: F${V_SHORT[F.verdict]}·M${V_SHORT[M.verdict]}·본${V_SHORT[B.verdict]} ${px.close.toLocaleString()}원(${px.time})`;

    const tiers = [
      { tier: "F" as const, tierKo: "피셔F 임시판정", out: F, prevV: sameDay ? prev!.F : "none" as Verdict },
      { tier: "M" as const, tierKo: "피셔M 중간확인", out: M, prevV: sameDay ? prev!.M : "none" as Verdict },
      { tier: "B" as const, tierKo: "본피셔 확정", out: B, prevV: sameDay ? prev!.B : "none" as Verdict },
    ];
    let anyChange = false;
    for (const t of tiers) {
      const cur = t.out.verdict;
      if (cur === t.prevV) continue;
      anyChange = true;
      const label = t.prevV === "none" ? `${V_KO[cur]} 확인` : cur === "none" ? `${V_KO[t.prevV]} 소멸` : `${V_KO[t.prevV]}→${V_KO[cur]} 전환`;
      // 지연 통지 가드 (개별주 스트림 이식): 확인 시각과 30분+ 차이면 추격 금지 경고
      const confT = cur !== "none" ? (t.out.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null) : null;
      const lagMin = confT ? minuteOfDay - hhmmToMin(confT) : 0;
      const stale = confT !== null && lagMin >= 30;
      const guide = stale
        ? `⚠지연 통지(확인 ${confT}, ${lagMin}분 경과) — 추격 진입 금지, 현재가와 다음 문자 기준 판단.`
        : cur === "none"
          ? "▶해당 단계 비중 축소·청산 검토."
          : cur === "inverse"
            ? "▶하방 — 신규 하방 체결은 기존 삼전 인버스2x 채널 문자 기준 (TOP10 전용 인버스 미상장). 488080 보유분 청산 검토."
            : t.tier === "F"
              ? `▶1단계: 계획 비중 50% 진입 검토 — 체결 ${CFG.lev.name}(${CFG.lev.code}). 피셔M 중간확인 대기.`
              : t.tier === "M"
                ? "▶2단계: +30%p(누적 80%) 검토."
                : "▶3단계: 잔여 +20%p(누적 100%) 검토 · 15:30 마감 전 당일청산 원칙.";
      const stopLine = !stale && cur === "leverage" ? await levStopLine() : "";
      try {
        await dispatchToChannels("signal", today, {
          key: `predict_tr_etf${t.tier}_${t.prevV}_${cur}`,
          severity: t.tier === "B" ? "high" : "medium",
          text: `[예측·TOP10 ${t.tierKo}] ${label}${cur !== "none" ? ` — ${t.out.reason.split(" — ")[0]}` : ""} (강도 ${Math.round(t.out.confidence * 100)}%·모니터링 60일 채점 중 — 실투자 판정은 기존 삼전·하닉 문자). ${guide} 무응답=현행 유지${stopLine}${stateLine}`,
          smsSubject: "예측 TOP10",
        });
      } catch { /* 발송 실패 무시 */ }
    }

    // 무추세 확인 (정규장 1회 — 프리장 미거래라 프리장 확인은 구조적으로 없음)
    const allNone = [F.verdict, M.verdict, B.verdict].every((v) => v === "none");
    const prevAllNone = !sameDay || (["F", "M", "B"] as const).every((k) => prev![k] === "none");
    if (allNone && prevAllNone && minuteOfDay >= hhmmToMin("10:00")) {
      try {
        await dispatchToChannels("signal", today, {
          key: "predict_etf_flat_reg",
          severity: "low",
          text: `[예측·TOP10] 정규장 방향 없음 (측정 ${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}) — F/M/본 모두 미확인. 방향 확인 시 즉시 문자. (모니터링 스트림 — 프리장은 NXT 미거래로 판정 없음)${stateLine}`,
          smsSubject: "예측 TOP10",
        });
      } catch { /* 발송 실패 무시 */ }
    }

    if (anyChange || !sameDay) {
      await admin.from("ops_settings").upsert(
        { key: "predict_etf_state", value: { date: today, F: F.verdict, M: M.verdict, B: B.verdict }, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    }
  } catch { /* 모니터 실패는 기존 스트림을 막지 않는다 */ }
}

// /fisher 실시간 버튼용 — 즉시 계산 (fisherNowKr와 동일한 FisherNow 형태)
export async function fisherNowEtf(): Promise<FisherNow> {
  const kst = kstNow();
  const today = kst.toISOString().slice(0, 10);
  const hhmm = kst.toISOString().slice(11, 16);
  const base: FisherNow = {
    market: "kr",
    title: `국장 TOP10 (TIGER 반도체TOP10 ${CFG.code} · 체결 ${CFG.lev.code})`,
    asOf: `${today} ${hhmm}`,
    session: "", official: null, tiers: [], priceLine: null, stopLine: null, summary: "", detail: [],
  };
  const inputs = await loadInputs();
  if (!inputs) {
    base.session = hhmm >= "09:00" && hhmm <= "15:30"
      ? "데이터 없음 — 09시창(09:00~09:15) 형성 전이거나 일시 조회 실패 (잠시 후 재시도)"
      : "데이터 없음 — 휴장·장 시작 전이거나 프리장 시간 (TOP10은 NXT 프리장 미거래 — 판정은 09:15 이후)";
    base.summary = `[피셔 실시간·TOP10 ${hhmm}] 판정 불가 — ${base.session}`;
    base.detail = [base.session];
    return base;
  }
  const { hist, reg } = inputs;
  const { F, M, B } = judgeTiers(inputs.today, hist, reg);
  base.session = hhmm <= "15:30" ? "정규장 (09시창 판정)" : "정규장 종료 — 오늘 최종 상태";
  const confirmOf = (reason: string): string | null => reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
  base.tiers = [
    { name: `피셔F (${CFG.F.offsetRatio}·${CFG.F.confirmMinutes}봉+강돌파)`, verdict: F.verdict, confirmedAt: confirmOf(F.reason), note: F.reason },
    { name: `피셔M (${CFG.M.offsetRatio}·${CFG.M.confirmMinutes}봉)`, verdict: M.verdict, confirmedAt: confirmOf(M.reason), note: M.reason },
    { name: `본피셔 (${CFG.B.offsetRatio}·${CFG.B.confirmMinutes}봉·트레일0.5×3)`, verdict: B.verdict, confirmedAt: confirmOf(B.reason), note: B.reason },
  ];
  const last = reg[reg.length - 1];
  base.priceLine = `TOP10 ${last.close.toLocaleString()}원 (${last.time} 완성봉)`;
  if (F.verdict === "leverage" || B.verdict === "leverage") base.stopLine = (await levStopLine()).replace(/^\n▶/, "");
  const sms = base.tiers.map((t) => `${t.name.split(" ")[0].replace("피셔", "").replace("본", "본")} ${V_SHORT[t.verdict]}${t.confirmedAt ? `(${t.confirmedAt})` : ""}`).join("·");
  base.summary = `[피셔 실시간·TOP10 ${hhmm}] 모니터링 계산값 (실투자 판정은 삼전·하닉)\n${sms} | ${base.priceLine}` + (base.stopLine ? `\n▶${base.stopLine}` : "");
  base.detail = [
    `세션: ${base.session}`,
    "공식 판정: TOP10은 모니터링 스트림 (60일 채점 중) — 아래는 실시간 계산값",
    ...base.tiers.map((t) => `${t.name}: ${V_KO[t.verdict]}${t.confirmedAt ? ` — ${t.confirmedAt} 확인` : ""} · ${t.note}`),
    base.priceLine,
    base.stopLine ? `스탑: ${base.stopLine}` : "스탑: 방향 판정 없음 또는 하방(삼전 인버스2x 채널 이용) — 해당 없음",
    "비중 프로토콜: F 50% → M +30%p → 본피셔 +20%p · 하방 체결은 삼전 인버스2x 채널",
  ].filter(Boolean) as string[];
  return base;
}
