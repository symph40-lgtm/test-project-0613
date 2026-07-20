// 운영 서비스 — 호출 시점 기준으로 알아서 처리 (스펙 5장):
//   ① 과거 미판정일 백필(최근 10거래일) ② 과거·당일 미채점일 채점 ③ 당일 10:30 경과 시 판정.
// KIS 과거 분봉으로 언제든 소급 가능 — 크론이 며칠 죽어도 다음 호출에서 복구된다.

import { PREDICT_CONFIG } from "./config";
import { atrPct } from "./indicators";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { fetchDayMinutes, fetchTodayMinutes, fetchNxtPremarket, clipToJudgeWindow } from "./kisMinute";
import { labelDay } from "./label";
import { runAllModels } from "./runner";
import { finalizeJudgment, runEnsemble } from "./ensemble";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { loadMacroHistory } from "./macro";
import {
  hasJudgment, hasModelRows, listUnscoredDates, loadAccuracyStats, loadDayRow,
  saveJudgment, scoreDay, upsertCheckpointDay, type Revision,
} from "./store";
import type { PredictDailyBar, Verdict } from "./types";

const STREAM_MIN = 8 * 60 + 31; // 08:31부터 체크포인트 스트림 (첫 판정 08:30 완성봉 기준)
const JUDGE_MIN = 14 * 60 + 1; // 14:01 확정 — 모델별 스냅샷(대조군 채점) 기록 (v1.4: 창 09:00~13:59)
const SCORE_MIN = 15 * 60 + 35; // 15:35부터 당일 채점

const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const V_KO: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };

async function judgeOneDay(
  date: string,
  complete: PredictDailyBar[], // date 이전의 완결 일봉들 (오래된→최신)
  openPx: number,
  source: "live" | "backfill",
  isToday: boolean,
): Promise<boolean> {
  const code = PREDICT_CONFIG.symbol;
  const ymd = date.replace(/-/g, "");
  let dayMin = await fetchDayMinutes(code, ymd, PREDICT_CONFIG.judgeHour);
  if ((!dayMin || dayMin.length < 60) && isToday) {
    dayMin = await fetchTodayMinutes(code, PREDICT_CONFIG.judgeHour);
  }
  if (!dayMin || dayMin.length < 60) return false;
  // 당일 확정(모델 스냅샷)도 커버리지 가드 — 부족하면 다음 크론에서 재시도 (2026-07-20)
  if (isToday && dayMin.length < 300 * 0.8) return false;
  const morning = clipToJudgeWindow(dayMin, PREDICT_CONFIG.judgeHour);
  const prevDate = complete[complete.length - 1]?.date;
  const prevDayMinutes = prevDate ? await fetchDayMinutes(code, prevDate.replace(/-/g, ""), "153000") : null;
  let macro = null;
  try {
    macro = (await loadMacroHistory())(date); // M7 근사 축1 — 실패해도 판정은 진행
  } catch { /* 야후 장애 — 축1 중립 처리 */ }
  const outputs = runAllModels({
    date,
    dailyHistory: complete.slice(-120),
    openPx,
    morning,
    prevDayMinutes,
    macro,
  });
  const acc = await loadAccuracyStats();
  const ens = runEnsemble(outputs, acc);
  const final = finalizeJudgment(outputs, ens); // 피셔 단독 모드 — 앙상블은 참고 기록
  await saveJudgment(date, outputs, final, ens, source);
  return true;
}

export type PredictRunResult = {
  date: string;
  judgedToday: boolean;
  earlyToday: boolean; // 조기 판정/모니터링 갱신 수행 여부
  backfilled: string[];
  scored: string[];
};

// 체크포인트 판정 스트림 (사용자 지정 2026-07-16): 08:30 첫 판정 → 30분마다 → 14:00 확정.
// 지나간 미기록 체크포인트는 과거 분봉으로 소급 기록 (크론이 띄엄띄엄 와도 타임라인 완성).
// 사이 구간(라이브 호출)은 모니터링 — 직전 기록과 판정이 다르면 변경 엔트리 + 문자.
// 판정자: 09:30 전 = user(RV1+T6, 프리마켓 유일 유효 신호) / 이후 = 피셔.
// 창: 10:30 전 = 08:00(NXT) 시작 / 이후 = 09:00 시작 (220일 실측 최적 조합).
async function checkpointStream(
  today: string,
  complete: PredictDailyBar[],
  minuteOfDay: number,
): Promise<boolean> {
  const cfg = PREDICT_CONFIG.schedule;
  const prior = await loadDayRow(today);
  if (prior && prior.stage === "final") return false;
  const code = PREDICT_CONFIG.symbol;
  const ymd = today.replace(/-/g, "");
  const [pre, krxRaw] = await Promise.all([
    fetchNxtPremarket(code, ymd),
    fetchDayMinutes(code, ymd, PREDICT_CONFIG.judgeHour).then(
      (bars) => bars ?? fetchTodayMinutes(code, PREDICT_CONFIG.judgeHour),
    ),
  ]);
  const krx = krxRaw ?? [];
  // 데이터 커버리지 가드 (2026-07-20 실측: 장중 분봉 응답이 호출마다 들쭉날쭉 → 피셔 상태기계가
  // 불가능한 전이(레버리지→없음)로 진동). 정규장 예상 분봉의 80% 미만이면 이번 호출은 판정 생략.
  const expectKrx = Math.min(minuteOfDay, hhmmToMin("14:00") + 1) - 9 * 60 - 1;
  if (expectKrx > 10 && krx.length < expectKrx * 0.8) {
    console.error(`[predict] 분봉 커버리지 부족 (${krx.length}/${expectKrx}) — 이번 호출 판정 생략`);
    return false;
  }
  const acc = await loadAccuracyStats();

  const judgeAt = (cutHHMM: string): { verdict: Verdict; strength: number } | null => {
    const usePre = cutHHMM < cfg.preWindowBefore;
    const bars = [...(usePre ? pre ?? [] : []), ...krx].filter((b) => b.time < cutHHMM);
    if (bars.length < 10) return null;
    const openPx = usePre ? pre?.[0]?.open ?? bars[0].open : krx[0]?.open ?? bars[0].open;
    const outputs = runAllModels({
      date: today,
      dailyHistory: complete.slice(-120),
      openPx,
      morning: bars,
      prevDayMinutes: null, // 스트림 단계는 달튼 VA 생략 (확정 모델 스냅샷에서 반영)
    });
    const primary = cutHHMM < cfg.earlyModelBefore ? ("user" as const) : undefined;
    const fin = finalizeJudgment(outputs, runEnsemble(outputs, acc), primary);
    return { verdict: fin.finalVerdict, strength: fin.strengthPct };
  };

  // 오늘의 ATR 스탑 (조기 신호용, ETF 기준 %) — 문자에 계산값으로 동봉 (사용자 요청 2026-07-20)
  const sw = PREDICT_CONFIG.stops.earlySwing;
  const atrToday = atrPct(complete, 14);
  const atrStopEtf = atrToday !== null ? 2 * Math.min(sw.maxPct, Math.max(sw.minPct, sw.k * atrToday)) : null;

  const smsChange = async (whenLabel: string, prev: Verdict | null, next: { verdict: Verdict; strength: number }) => {
    if (!PREDICT_CONFIG.sms.enabled) return;
    // 실측 적중률 병기 — 그 시각 판정자(조기=user, 이후=피셔)의 방향 판정 누적 적중률 (표본 10회 이상일 때만)
    const judge = whenLabel < cfg.earlyModelBefore ? "user" : PREDICT_CONFIG.primaryModel;
    const judgeKo = judge === "user" ? "사용자모델" : "피셔"; // 어떤 모델의 판정인지 명시 (사용자 요청 2026-07-20)
    const st = acc[judge];
    const hitPct = next.verdict !== "none" && st && st.dirTotal >= 10 ? Math.round((st.dirCorrect / st.dirTotal) * 100) : null;
    const tail = `(강도 ${Math.round(next.strength)}%${hitPct !== null ? `·실측적중 ${hitPct}%` : ""})`;
    let text = prev === null
      ? `[예측·${judgeKo}] ${whenLabel} 첫 판정: ${V_KO[next.verdict]} ${tail}`
      : `[예측·${judgeKo}] ${whenLabel} 판정 변경: ${V_KO[prev]}→${V_KO[next.verdict]} ${tail}`;
    // 규칙 환기 (사용자 지정 2026-07-17 "당분간") — 수익은 적중률이 아니라 규칙에서.
    // 장문(LMS) 전환을 감수하고 동봉. config.sms.ruleReminder=false로 끄면 단문 복귀.
    if (PREDICT_CONFIG.sms.ruleReminder) {
      if (next.verdict !== "none") {
        // 신호 유형별 스탑을 계산값으로 — 조기(09:30 전)=ATR 0.7배(ETF 환산), 피셔=ETF -3% 고정
        text += whenLabel < cfg.earlyModelBefore
          ? `\n▶조기신호: 1/3만 선진입 · 스탑 ETF ${atrStopEtf !== null ? `-${atrStopEtf.toFixed(1)}%` : "ATR 0.7배"}(오늘 ATR 기준) · 09:30 피셔 확인 후 본진입. 당일청산.`
          : `\n▶피셔 확인: 본진입 가능 · 스탑 ETF -3% 고정(역행=확인실패, 즉시 컷) · 당일청산.`;
        text += ` 수익은 적중률(${hitPct ?? "?"}%)이 아니라 규칙에서.`;
      } else if (prev !== null) {
        text += `\n▶규칙: 방향 소멸 — 보유 중이면 청산 검토. 확정(14:00) 반대 보유 금지.`;
      }
    }
    try {
      // 키에 분(minute)을 넣지 않는다 — 2026-07-20 실측 사고: 상태 저장 실패 시 매 크론마다
      // 같은 판정이 분 단위 새 키로 재발송돼 2분 간격 문자 폭주. 체크포인트는 slot 키,
      // 모니터링 변경은 '이전→다음' 전환 키로 하루 1회 고정.
      const isCheckpoint = (PREDICT_CONFIG.schedule.checkpoints as readonly string[]).includes(whenLabel);
      const key = isCheckpoint
        ? `predict_cp${whenLabel.replace(":", "")}_${next.verdict}`
        : `predict_chg_${prev ?? "none"}_${next.verdict}`;
      await dispatchToChannels("signal", today, { key, severity: "medium", text, smsSubject: "예측 판정" });
    } catch { /* 발송 실패는 판정 기록을 막지 않는다 */ }
  };

  let revs: Revision[] = prior?.revisions ?? [];
  let changed = false;
  const done = new Set(revs.map((r) => r.checkpoint).filter(Boolean));
  const lastCp = cfg.checkpoints[cfg.checkpoints.length - 1];

  // ① 지나간 체크포인트 소급 기록 (완성봉 보장: 체크포인트 +1분 경과분만)
  for (const cp of cfg.checkpoints) {
    if (hhmmToMin(cp) + 1 > minuteOfDay || done.has(cp)) continue;
    const fin = judgeAt(cp);
    if (!fin) continue;
    const prev = revs.length ? revs[revs.length - 1].verdict : null;
    revs = [...revs, { at: new Date().toISOString(), checkpoint: cp, verdict: fin.verdict, strength: fin.strength }];
    changed = true;
    // 문자: 방향 등장·소멸·전환만 (첫 기록이 '추세없음'이면 조용)
    if (fin.verdict !== prev && !(prev === null && fin.verdict === "none")) await smsChange(cp, prev, fin);
  }

  // ② 체크포인트 사이 모니터링 — 현재 완성봉 기준 판정이 직전 기록과 다르면 변경 기록
  if (minuteOfDay > hhmmToMin(cfg.checkpoints[0]) && minuteOfDay <= hhmmToMin(lastCp) && revs.length > 0) {
    const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const fin = judgeAt(nowHHMM < lastCp ? nowHHMM : lastCp);
    const last = revs[revs.length - 1];
    if (fin && fin.verdict !== last.verdict) {
      revs = [...revs, { at: new Date().toISOString(), verdict: fin.verdict, strength: fin.strength }];
      changed = true;
      await smsChange(nowHHMM, last.verdict, fin);
    }
  }

  if (!changed || revs.length === 0) return false;
  const isFinal = revs.some((r) => r.checkpoint === lastCp);
  await upsertCheckpointDay(today, revs[revs.length - 1], revs, isFinal, prior);
  return true;
}

export async function runPredictService(): Promise<PredictRunResult> {
  const code = PREDICT_CONFIG.symbol;
  const { date: today, minuteOfDay } = kstNowPredict();
  const daily = await fetchDailyPredict(code, 170);
  const complete = daily.filter((b) => b.date < today); // 오늘 제외 = 확정 일봉
  const result: PredictRunResult = { date: today, judgedToday: false, earlyToday: false, backfilled: [], scored: [] };
  if (complete.length < 40) return result;

  // ① 최근 10거래일 중 판정 자체가 없는 날 백필 (판정→즉시 채점)
  for (const bar of complete.slice(-10)) {
    if (await hasJudgment(bar.date)) continue;
    const idx = complete.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const ok = await judgeOneDay(bar.date, complete.slice(0, idx), bar.open, "backfill", false);
    if (ok) {
      const { label, rOC } = labelDay(bar);
      await scoreDay(bar.date, label, rOC);
      result.backfilled.push(bar.date);
    }
  }

  // ② 판정은 있는데 미채점인 과거일 채점
  for (const d of await listUnscoredDates(today)) {
    const bar = complete.find((b) => b.date === d);
    if (!bar) continue;
    const { label, rOC } = labelDay(bar);
    await scoreDay(d, label, rOC);
    result.scored.push(d);
  }

  // ③a 체크포인트 스트림 (08:31~) — 08:30 첫 판정, 30분마다, 14:00 확정. 사이는 모니터링
  const todayBar = daily.find((b) => b.date === today);
  if (todayBar && minuteOfDay >= STREAM_MIN) {
    result.earlyToday = await checkpointStream(today, complete, minuteOfDay);
  }

  // ③b 모델별 확정 스냅샷 (14:01 이후, 09:00~13:59 창) — 대조군 채점용 모델 행 + 가중치 기록
  if (todayBar && minuteOfDay >= JUDGE_MIN && !(await hasModelRows(today))) {
    result.judgedToday = await judgeOneDay(today, complete, todayBar.open, "live", true);
  }

  // ④ 당일 채점 (15:35 이후 — 일봉 확정)
  if (todayBar && minuteOfDay >= SCORE_MIN && (await hasJudgment(today))) {
    const unscoredToday = (await listUnscoredDates("9999-12-31")).includes(today);
    if (unscoredToday) {
      const { label, rOC } = labelDay(todayBar);
      await scoreDay(today, label, rOC);
      result.scored.push(today);
    }
  }

  return result;
}
