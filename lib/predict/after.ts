// 애프터장 판정 서비스 (사용자 지정 2026-07-20) — NXT 애프터마켓 15:30~20:00, 하닉 본주 전용.
// 구조는 정규장 체크포인트 스트림의 축소판: 16:00 첫 판정 → 30분마다 → 19:30 확정,
// 사이 구간 모니터링(변경 시 문자), 세션 종료 후 라벨(±0.6% 스케일)로 채점.
// 판정자: 피셔 단독 (오프셋 = 0.15 × 당일 정규장 레인지 — 세션 스케일 근사, 미검증 초기값).
// 저장: predict_after_days (마이그레이션 027) — 정규장 채점과 완전 분리.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { fetchNxtAfterMarket } from "./kisMinute";
import { runFisher } from "./models/fisher";
import { avgRange } from "./indicators";
import { loadAfterPerf } from "./store";
import type { MinuteBar, Verdict } from "./types";

const AH = PREDICT_CONFIG.after;
// 액션 지시형 라벨 (사용자 지시 2026-08-04 새벽 "정보가 아니라 직접 취할 액션 위주로") — 애프터장은
// ETF 미거래라 하방의 액션은 '매수 금지·보유 롱 청산'뿐임을 라벨 자체에 명시.
// ⚠현재 애프터 문자는 신모델 전용 정책(smsNewModelOnly)으로 발송 억제 상태 — 재가동 대비 문구만 정비.
const V_KO: Record<Verdict, string> = { leverage: "상방(▶본주 소액 매수)", inverse: "하방(▶신규 매수 금지·보유 롱 청산)", none: "추세없음(▶행동 없음)" };
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type AfterRev = { at: string; checkpoint?: string; verdict: Verdict; strength: number };
type AfterRow = {
  date: string;
  final_verdict: Verdict;
  strength: number;
  stage: "open" | "final";
  revisions: AfterRev[] | null;
  label: Verdict | null;
};

async function loadAfterRow(date: string): Promise<AfterRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predict_after_days")
    .select("date, final_verdict, strength, stage, revisions, label")
    .eq("date", date)
    .maybeSingle();
  if (error) throw new Error(`predict_after_days 조회 실패(마이그레이션 027 확인): ${error.message}`);
  return (data as AfterRow | null) ?? null;
}

function labelAfter(bars: MinuteBar[]): { label: Verdict; rOC: number } {
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const rOC = ((close - open) / open) * 100;
  const pos = hi > lo ? (close - lo) / (hi - lo) : 0.5;
  const L = AH.label;
  let label: Verdict = "none";
  if (rOC >= L.trendMinPct && pos >= L.posUp) label = "leverage";
  else if (rOC <= -L.trendMinPct && pos <= L.posDown) label = "inverse";
  return { label, rOC: Number(rOC.toFixed(2)) };
}

// 지연 통지 가드 (2026-07-29 실사고: KIS 토큰 무효로 16시대 확인들이 19:24 일괄 발송 —
// "1단계 선진입 검토"가 3시간 뒤, 하필 되돌림 시작점에 도착). 확인 후 30분+ 경과면 진입 지침 대체.
function ahStaleGuard(reason: string): string | null {
  const confT = reason.match(/^(\d{2}:\d{2})/)?.[1];
  if (!confT) return null;
  const kst = new Date(Date.now() + 9 * 3600e3);
  const lag = kst.getUTCHours() * 60 + kst.getUTCMinutes() - hhmmToMin(confT);
  return lag >= 30 ? `⚠지연 통지(확인 ${confT}, ${lag}분 경과) — 추격 진입 금지, 현재가 기준 판단.` : null;
}

// 애프터장 스트림 + 채점 — runPredictService에서 호출 (실패해도 정규장 흐름은 무관)
export async function runAfterService(): Promise<{ judged: boolean; scored: string[] }> {
  const code = PREDICT_CONFIG.symbol;
  const { date: today, minuteOfDay } = kstNowPredict();
  const admin = createAdminClient();
  const result = { judged: false, scored: [] as string[] };

  // ① 미채점 백필 (과거일 + 오늘 20:05 이후) — NX 과거 분봉으로 소급 가능
  const { data: unscored } = await admin
    .from("predict_after_days")
    .select("date")
    .is("label", null)
    .order("date", { ascending: true })
    .limit(10);
  for (const r of unscored ?? []) {
    const d = String(r.date);
    if (d === today && minuteOfDay < 20 * 60 + 5) continue; // 세션 종료 전
    const bars = await fetchNxtAfterMarket(code, d.replace(/-/g, ""), "200000");
    if (!bars || bars.length < 30) continue;
    const { label, rOC } = labelAfter(bars);
    await admin
      .from("predict_after_days")
      .update({ label, r_oc: rOC, labeled_at: new Date().toISOString() })
      .eq("date", d);
    result.scored.push(d);
  }

  // ①b 삼전 애프터 전이 문자 (이월 지시 2026-07-25 ②번 → 07-26 승격 — 트래킹 채점 축적 확인 완료).
  // 근거 (predict_track_days after/fisher, 224일 백테스트 시딩 채점): 방향 판정 103일 — rOC 부호
  // 적중 89.3%(최근 40건 80%)·3분류 라벨 일치 54%(하닉 loadAfterPerf와 동일 눈금)·19:30 진입→종가
  // 잔여 +6.47%p 누적. 판정·상수는 track.ts 애프터와 동일(오프셋 = 세션 시가 0.4%·확정 19:30) —
  // 기록·채점은 track.ts 그대로 유지, 여기는 문자 레이어만 추가 (국장 ②b 관례: 상태 ops_settings·
  // 전이 키 1일 1회). ⚠라이브 재현 0일 — 문구에 '시딩 검증·라이브 축적 중' 명시, 소액 지침.
  if (PREDICT_CONFIG.sms.enabled && minuteOfDay >= 15 * 60 + 50 && minuteOfDay <= 19 * 60 + 35) {
    try {
      const SS = "005930";
      const ssDaily = await fetchDailyPredict(SS, 160);
      const ssHist = ssDaily.filter((b) => b.date < today).slice(-120);
      const ssRange10 = avgRange(ssHist, 10);
      const ssBars = await fetchNxtAfterMarket(SS, today.replace(/-/g, ""), "193000");
      if (ssRange10 !== null && ssHist.length >= 30 && ssBars && ssBars.length >= 20) {
        const offR = ((AH.offsetPct / 100) * ssBars[0].open) / ssRange10;
        const ssInput = { date: today, dailyHistory: ssHist, openPx: ssBars[0].open, morning: ssBars, prevDayMinutes: null };
        const out = runFisher(ssInput, { offsetRangeRatio: offR, earlyConfirmBy: "17:00" });
        // 애프터 3단계 사다리 F/M (사용자 승인 2026-07-26 — config.after.ladder 근거 참조.
        // 삼전 224일: F 레그 +4.7→+16.5%p·본확인 24분 선행 / M 동반 잔여+ 56%·+30.4%p vs 미동반 3%)
        const L = AH.ladder;
        const fT = runFisher(ssInput, { offsetRangeRatio: ((L.fOffPct / 100) * ssBars[0].open) / ssRange10, confirmMinutes: L.fConfirm, earlyConfirmBy: "17:00" });
        const mT = runFisher(ssInput, { offsetRangeRatio: ((L.mOffPct / 100) * ssBars[0].open) / ssRange10, confirmMinutes: L.mConfirm, earlyConfirmBy: "17:00" });
        const cur = out.verdict;
        const strength = Number((out.confidence * 100).toFixed(0));
        const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "predict_ss_after_state").maybeSingle();
        const prevSt = (stRow?.value ?? null) as { date: string; verdict: Verdict; F?: Verdict; M?: Verdict } | null;
        const prev: Verdict = prevSt && prevSt.date === today ? prevSt.verdict : "none";
        const pF: Verdict = prevSt && prevSt.date === today ? prevSt.F ?? "none" : "none";
        const pM: Verdict = prevSt && prevSt.date === today ? prevSt.M ?? "none" : "none";
        if (fT.verdict !== pF && !(pF === "none" && fT.verdict === "none")) {
          const lb = pF === "none" ? `${V_KO[fT.verdict]} 확인` : fT.verdict === "none" ? `${V_KO[pF]} 소멸` : `${V_KO[pF]}→${V_KO[fT.verdict]} 전환`;
          const g = (fT.verdict !== "none" ? ahStaleGuard(fT.reason) : null)
            ?? (fT.verdict === "none" ? "▶선진입분 청산 검토."
            : pF !== "none" ? "▶전환 — 선진입분 청산 후 반대 방향 소액부터."
            : "▶1단계 소액 선진입 검토 · 피셔M 확인 대기 (실측: 본확인 24분 선행·M 동반 잔여+ 56% vs 미동반 3% — M 확인 전 소액 유지).");
          try {
            await dispatchToChannels("signal", today, {
              key: `predict_ss_ahF_${pF}_${fT.verdict}`, severity: "medium",
              text: `[예측·삼전 애프터 피셔F] ${lb}${fT.verdict !== "none" ? ` — ${fT.reason.split(" — ")[0]}` : ""} (1단계). ${g} 본주 전용·스탑 -1.5%·20:00 전 청산.`,
              smsSubject: "예측 애프터",
            });
          } catch { /* 발송 실패 무시 */ }
        }
        if (mT.verdict !== pM && !(pM === "none" && mT.verdict === "none")) {
          const lb = pM === "none" ? `${V_KO[mT.verdict]} 재확인` : mT.verdict === "none" ? `${V_KO[pM]} 소멸` : `${V_KO[pM]}→${V_KO[mT.verdict]} 전환`;
          const warn = mT.verdict !== "none" && fT.verdict !== "none" && mT.verdict !== fT.verdict ? " ⚠피셔F와 반대 — F 선진입분 축소." : "";
          const g = (mT.verdict !== "none" ? ahStaleGuard(mT.reason) : null)
            ?? (mT.verdict === "none" ? "▶2단계분 비중 축소 검토."
            : `▶2단계 확대 검토 — M 동반 실측 잔여+ 56%·누적 +30.4%p(224일) vs 미동반 손실.${warn}`);
          try {
            await dispatchToChannels("signal", today, {
              key: `predict_ss_ahM_${pM}_${mT.verdict}`, severity: "medium",
              text: `[예측·삼전 애프터 피셔M] ${lb}${mT.verdict !== "none" ? ` — ${mT.reason.split(" — ")[0]}` : ""} (2단계). ${g} 확정(3단계)은 본피셔 문자.`,
              smsSubject: "예측 애프터",
            });
          } catch { /* 발송 실패 무시 */ }
        }
        const isFinalW = minuteOfDay >= hhmmToMin(AH.finalCp);
        // 실측적중 동봉 — 트래킹(시딩 포함) 라벨 일치, 하닉 애프터와 동일 눈금
        let ssAcc = "";
        try {
          const { data: tr } = await admin
            .from("predict_track_days")
            .select("verdict, label")
            .eq("symbol", SS).eq("session", "after").eq("model", "fisher")
            .not("label", "is", null).neq("verdict", "none").limit(2000);
          const t = (tr ?? []).length;
          const c = (tr ?? []).filter((r) => r.verdict === r.label).length;
          if (t > 0) ssAcc = `·과거 애프터판정 ${t}번 중 ${Math.round((100 * c) / t)}% 적중(백테스트 포함 — 이번 신호의 확률 아님)`;
        } catch { /* 통계 실패는 발송을 막지 않는다 */ }
        const ssGuide = `\n▶애프터장: 본주 전용(ETF 미운영) · 스탑 본주 -1.5% · 20:00 세션 종료 전 청산. 시딩 224일 검증·라이브 축적 중 — 소액만.`;
        const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
        if (cur !== prev && !(prev === "none" && cur === "none")) {
          const head = prev === "none" ? `${nowHHMM} 첫 판정: ${V_KO[cur]}` : `${nowHHMM} 판정 변경: ${V_KO[prev]}→${V_KO[cur]}`;
          try {
            await dispatchToChannels("signal", today, {
              key: `predict_ss_ah_${prev}_${cur}`,
              severity: "medium",
              text: `[예측·삼전 애프터] ${head} (강도 ${strength}%${ssAcc})${cur !== "none" ? ssGuide : ""}`,
              smsSubject: "예측 애프터",
            });
          } catch { /* 발송 실패 무시 */ }
        }
        // 확정(19:30) — 방향일 때 항상 1회 (하닉과 동일: "확정판결이 나오면 정규장처럼").
        // 내일갭 동봉 (사용자 승인 2026-07-26 — scripts/after-gap-sweep.ts, 삼전 224일 시딩):
        // 상방 확정일 갭+ 67%·평균 +1.7% vs 기준선 57%·+0.5 / 하방 38%·-0.8. 갭 이후 장중은 예측력
        // 없음. 확정 컷 신규 진입도 실익 없음(하닉 189일 +0.07%/건 관례 준용) — 진입 지침 대신 내일 대비.
        if (isFinalW && cur !== "none") {
          // 문구 평문화 (사용자 지시 2026-07-29 밤: "모든 문자 오해 소지 없게 쉽게" — 확정=기록용 명시,
          // 내일갭=과거 통계임을 명시)
          const ssGapLine = cur === "leverage"
            ? `\n▶내일 시가 참고(과거 224일 통계): 애프터가 상방으로 끝난 날은 다음날 67%가 갭상승(평균 +1.7%) — 인버스 보유 중이면 내일 시초 정리 검토. 장중 방향 예측은 아님.`
            : `\n▶내일 시가 참고(과거 224일 통계): 애프터가 하방으로 끝난 날은 다음날 갭상승 38%(평균 -0.8%) — 레버리지 보유 중이면 내일 시초 갭 유의.`;
          try {
            await dispatchToChannels("signal", today, {
              key: `predict_ss_ah_final_${cur}`,
              severity: "medium",
              text: `[예측·삼전 애프터] 오늘 애프터 최종(${AH.finalCp} 확정): ${V_KO[cur]} (강도 ${strength}%${ssAcc})\n▶이 문자는 기록·내일 아침 대비용 — 지금 진입하라는 뜻 아님(과거 이 시각 진입 수익 사실상 0).${ssGapLine}`,
              smsSubject: "예측 애프터",
            });
          } catch { /* 발송 실패 무시 */ }
        }
        if (cur !== prev || fT.verdict !== pF || mT.verdict !== pM || !prevSt || prevSt.date !== today) {
          await admin.from("ops_settings").upsert(
            { key: "predict_ss_after_state", value: { date: today, verdict: cur, F: fT.verdict, M: mT.verdict } },
            { onConflict: "key" },
          );
        }
      }
    } catch (e) {
      console.error("[after] 삼전 애프터 문자 실패 (하닉 스트림은 계속):", e);
    }
  }

  // ② 라이브 스트림 (15:50~19:35 — 첫 15분 OR 형성 후)
  if (minuteOfDay < 15 * 60 + 50 || minuteOfDay > 19 * 60 + 35) return result;
  const prior = await loadAfterRow(today);
  if (prior && prior.stage === "final") return result;

  const daily = await fetchDailyPredict(code, 160);
  const todayBar = daily.find((b) => b.date === today);
  const history = daily.filter((b) => b.date < today).slice(-120);
  const range10 = avgRange(history, 10);
  if (!todayBar || range10 === null) return result;
  const bars = await fetchNxtAfterMarket(code, today.replace(/-/g, ""), "193000");
  if (!bars || bars.length < 20) return result;

  // 오프셋 = 세션 시가 × 0.4% (2026-07-21 개정 — 정규장 광폭 날 기회손실 해결, 189일 실측)
  // runFisher의 ratio(×avgRange10) 형태로 환산해 주입
  const offsetRatio = ((AH.offsetPct / 100) * bars[0].open) / range10;
  const judgeAt = (cutHHMM: string): { verdict: Verdict; strength: number } | null => {
    const w = bars.filter((b) => b.time < cutHHMM);
    if (w.length < 20) return null;
    const out = runFisher(
      { date: today, dailyHistory: history, openPx: bars[0].open, morning: w, prevDayMinutes: null },
      { offsetRangeRatio: offsetRatio, earlyConfirmBy: "17:00" },
    );
    return { verdict: out.verdict, strength: Number((out.confidence * 100).toFixed(0)) };
  };

  // ②c 하닉 애프터 3단계 사다리 F/M 전이 문자 (사용자 승인 2026-07-26 — config.after.ladder 근거.
  // 하닉 189일: F 레그 +11.2→+17.9%p(전·후반 개선)·본확인 19분 선행 / M 동반 잔여+ 63%·+38.0%p
  // vs 미동반 0%·-14.7%p). 판정·채점(본 19:30 확정)·체크포인트 문자는 불변 — 문자 레이어만.
  try {
    const L = AH.ladder;
    const hxInput = { date: today, dailyHistory: history, openPx: bars[0].open, morning: bars, prevDayMinutes: null };
    const fT = runFisher(hxInput, { offsetRangeRatio: ((L.fOffPct / 100) * bars[0].open) / range10, confirmMinutes: L.fConfirm, earlyConfirmBy: "17:00" });
    const mT = runFisher(hxInput, { offsetRangeRatio: ((L.mOffPct / 100) * bars[0].open) / range10, confirmMinutes: L.mConfirm, earlyConfirmBy: "17:00" });
    const { data: stR } = await admin.from("ops_settings").select("value").eq("key", "predict_ah_hx_tier").maybeSingle();
    const pv = (stR?.value ?? null) as { date: string; F: Verdict; M: Verdict } | null;
    const pF: Verdict = pv && pv.date === today ? pv.F : "none";
    const pM: Verdict = pv && pv.date === today ? pv.M : "none";
    if (fT.verdict !== pF && !(pF === "none" && fT.verdict === "none")) {
      const lb = pF === "none" ? `${V_KO[fT.verdict]} 확인` : fT.verdict === "none" ? `${V_KO[pF]} 소멸` : `${V_KO[pF]}→${V_KO[fT.verdict]} 전환`;
      const g = (fT.verdict !== "none" ? ahStaleGuard(fT.reason) : null)
        ?? (fT.verdict === "none" ? "▶선진입분 청산 검토."
        : pF !== "none" ? "▶전환 — 선진입분 청산 후 반대 방향 소액부터."
        : "▶1단계 소액 선진입 검토 · 피셔M 확인 대기 (실측: 본확인 19분 선행·M 동반 잔여+ 63% vs 미동반 0% — M 확인 전 소액 유지).");
      try {
        await dispatchToChannels("signal", today, {
          key: `predict_ah_hxF_${pF}_${fT.verdict}`, severity: "medium",
          text: `[예측·하닉 애프터 피셔F] ${lb}${fT.verdict !== "none" ? ` — ${fT.reason.split(" — ")[0]}` : ""} (1단계). ${g} 본주 전용·스탑 -1.5%·20:00 전 청산.`,
          smsSubject: "예측 애프터",
        });
      } catch { /* 발송 실패 무시 */ }
    }
    if (mT.verdict !== pM && !(pM === "none" && mT.verdict === "none")) {
      const lb = pM === "none" ? `${V_KO[mT.verdict]} 재확인` : mT.verdict === "none" ? `${V_KO[pM]} 소멸` : `${V_KO[pM]}→${V_KO[mT.verdict]} 전환`;
      const warn = mT.verdict !== "none" && fT.verdict !== "none" && mT.verdict !== fT.verdict ? " ⚠피셔F와 반대 — F 선진입분 축소." : "";
      const g = (mT.verdict !== "none" ? ahStaleGuard(mT.reason) : null)
        ?? (mT.verdict === "none" ? "▶2단계분 비중 축소 검토."
        : `▶2단계 확대 검토 — M 동반 실측 잔여+ 63%·누적 +38.0%p(189일) vs 미동반 손실.${warn}`);
      try {
        await dispatchToChannels("signal", today, {
          key: `predict_ah_hxM_${pM}_${mT.verdict}`, severity: "medium",
          text: `[예측·하닉 애프터 피셔M] ${lb}${mT.verdict !== "none" ? ` — ${mT.reason.split(" — ")[0]}` : ""} (2단계). ${g} 확정(3단계)은 본피셔 문자.`,
          smsSubject: "예측 애프터",
        });
      } catch { /* 발송 실패 무시 */ }
    }
    if (fT.verdict !== pF || mT.verdict !== pM || !pv || pv.date !== today) {
      await admin.from("ops_settings").upsert(
        { key: "predict_ah_hx_tier", value: { date: today, F: fT.verdict, M: mT.verdict } },
        { onConflict: "key" },
      );
    }
  } catch { /* 사다리 문자 실패는 본 스트림을 막지 않는다 */ }

  // 애프터 라이브 실측적중 동봉 (사용자 지시 2026-07-25 — 모든 판정 문자에 강도·실측 공통 눈금)
  let afterAccTail = "";
  try {
    const p = await loadAfterPerf();
    if (p && p.t > 0) afterAccTail = `·과거 애프터판정 ${p.t}번 중 ${Math.round((100 * p.c) / p.t)}% 적중(이번 신호의 확률 아님)`;
  } catch { /* 통계 실패는 발송을 막지 않는다 */ }

  // 내일갭 동봉 (사용자 승인 2026-07-26 — scripts/after-gap-sweep.ts, 하닉 189일): 애프터 확정
  // 방향이 다음날 시가 갭을 예측 (상방 확정일 갭+ 66%·평균 +2.2% vs 기준선 50%·+0.5, 하방 43%·-0.8).
  // 갭 이후 장중(시초30분·시→종)은 예측력 없음 — 갭 대비 지침만. 확정(19:30) 신규 진입은 실익
  // 없음(스펙 7장 실측 +0.07%/건) — 확정 문자는 진입 지침 대신 채점·내일 대비 기준으로 표기.
  // 문구 평문화 (사용자 지시 2026-07-29 밤) — '내일갭'이 과거 통계임을 명시, 매수 지시로 오독 방지
  const hxGapLine = (v: Verdict): string => v === "leverage"
    ? `\n▶내일 시가 참고(과거 189일 통계): 애프터가 상방으로 끝난 날은 다음날 66%가 갭상승(평균 +2.2%) — 인버스 ETF 보유 중이면 내일 시초 정리 검토. 장중 방향 예측은 아님.`
    : `\n▶내일 시가 참고(과거 189일 통계): 애프터가 하방으로 끝난 날은 다음날 갭상승 43%(평균 -0.8%) — 레버리지 ETF 보유 중이면 내일 시초 갭 유의.`;
  const sms = async (whenLabel: string, prev: Verdict | null, v: { verdict: Verdict; strength: number }, isFinal: boolean) => {
    if (!PREDICT_CONFIG.sms.enabled) return;
    const head = isFinal ? `확정(${AH.finalCp})` : whenLabel;
    let text = prev === null
      ? `[예측·하닉 애프터] ${head} 첫 판정: ${V_KO[v.verdict]} (강도 ${v.strength}%${afterAccTail})`
      : `[예측·하닉 애프터] ${head} 판정 변경: ${V_KO[prev]}→${V_KO[v.verdict]} (강도 ${v.strength}%${afterAccTail})`;
    if (v.verdict !== "none") {
      text += isFinal
        ? `\n▶이 문자는 기록·내일 아침 대비용 — 지금 진입하라는 뜻 아님(과거 19:30 진입 평균 +0.07% ≈ 0).${hxGapLine(v.verdict)}`
        : `\n▶애프터장: 본주 전용(ETF 미운영) · 스탑 본주 -1.5% · 20:00 세션 종료 전 청산. 미검증 신호 — 소액만.`;
    }
    try {
      await dispatchToChannels("signal", today, {
        key: `predict_ah_${isFinal ? "final" : whenLabel.replace(":", "")}_${v.verdict}`,
        severity: "medium",
        text,
        smsSubject: "예측 애프터",
      });
    } catch { /* 발송 실패 무시 */ }
  };

  let revs: AfterRev[] = prior?.revisions ?? [];
  let changed = false;
  const done = new Set(revs.map((r) => r.checkpoint).filter(Boolean));

  for (const cp of AH.checkpoints) {
    if (hhmmToMin(cp) + 1 > minuteOfDay || done.has(cp)) continue;
    const fin = judgeAt(cp);
    if (!fin) continue;
    const prev = revs.length ? revs[revs.length - 1].verdict : null;
    revs = [...revs, { at: new Date().toISOString(), checkpoint: cp, verdict: fin.verdict, strength: fin.strength }];
    changed = true;
    const isFinal = cp === AH.finalCp;
    // 문자: 변경 시 + 확정은 방향일 때 항상 (사용자: "확정판결이 나오면 정규장처럼 보내줘")
    if (fin.verdict !== prev && !(prev === null && fin.verdict === "none")) await sms(cp, prev, fin, isFinal);
    else if (isFinal && fin.verdict !== "none") await sms(cp, null, fin, true);
  }

  // 모니터링 (체크포인트 사이 변경)
  if (revs.length > 0 && minuteOfDay <= hhmmToMin(AH.finalCp)) {
    const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const fin = judgeAt(nowHHMM < AH.finalCp ? nowHHMM : AH.finalCp);
    const last = revs[revs.length - 1];
    if (fin && fin.verdict !== last.verdict) {
      revs = [...revs, { at: new Date().toISOString(), verdict: fin.verdict, strength: fin.strength }];
      changed = true;
      await sms(nowHHMM, last.verdict, fin, false);
    }
  }

  if (!changed || revs.length === 0) return result;
  const isFinal = revs.some((r) => r.checkpoint === AH.finalCp);
  const latest = revs[revs.length - 1];
  await admin.from("predict_after_days").upsert(
    { date: today, final_verdict: latest.verdict, strength: latest.strength, stage: isFinal ? "final" : "open", revisions: revs },
    { onConflict: "date" },
  );
  result.judged = true;
  return result;
}

// 페이지용 로더 — 마이그레이션 027 미적용이면 null
export async function loadAfterDays(n: number): Promise<
  { date: string; final_verdict: string; strength: number; stage: string; label: string | null; r_oc: number | null; revisions: AfterRev[] | null }[] | null
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predict_after_days")
    .select("date, final_verdict, strength, stage, label, r_oc, revisions")
    .order("date", { ascending: false })
    .limit(n);
  if (error) return null;
  return (data ?? []) as never;
}
