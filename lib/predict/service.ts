// 운영 서비스 — 호출 시점 기준으로 알아서 처리 (스펙 5장):
//   ① 과거 미판정일 백필(최근 10거래일) ② 과거·당일 미채점일 채점 ③ 당일 10:30 경과 시 판정.
// KIS 과거 분봉으로 언제든 소급 가능 — 크론이 며칠 죽어도 다음 호출에서 복구된다.

import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { fetchDayMinutes, fetchTodayMinutes, fetchNxtPremarket, clipToJudgeWindow } from "./kisMinute";
import { labelDay } from "./label";
import { runAllModels } from "./runner";
import { finalizeJudgment, runEnsemble } from "./ensemble";
import { hasJudgment, listUnscoredDates, loadAccuracyStats, loadDayRow, saveEarlyJudgment, saveJudgment, scoreDay } from "./store";
import type { PredictDailyBar } from "./types";

const EARLY_MIN = 9 * 60 + 31; // 09:31 조기 판정 (08:00 NXT 프리마켓 포함 창 — 220일 분석에서 유일하게 경제성 양수)
const JUDGE_MIN = 10 * 60 + 31; // 10:31 확정 판정 (09:00 창 — 정확도 최고). 09:31~10:30은 모니터링(변경 누적)
const SCORE_MIN = 15 * 60 + 35; // 15:35부터 당일 채점

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
  const morning = clipToJudgeWindow(dayMin, PREDICT_CONFIG.judgeHour);
  const prevDate = complete[complete.length - 1]?.date;
  const prevDayMinutes = prevDate ? await fetchDayMinutes(code, prevDate.replace(/-/g, ""), "153000") : null;
  const outputs = runAllModels({
    date,
    dailyHistory: complete.slice(-120),
    openPx,
    morning,
    prevDayMinutes,
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

// 조기 판정·모니터링 (09:31~10:30) — 08:00 NXT 프리마켓 + 정규장 완성봉으로 잠정 판정.
// NXT 데이터가 없으면 정규장 봉만으로 판정 (봉 수 부족 시 모델이 스스로 보수 판정).
async function earlyJudge(
  today: string,
  complete: PredictDailyBar[],
  minuteOfDay: number,
): Promise<boolean> {
  const code = PREDICT_CONFIG.symbol;
  const ymd = today.replace(/-/g, "");
  const prior = await loadDayRow(today);
  if (prior && prior.stage === "final") return false; // 이미 확정 — 조기 단계 지남
  const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
  const cutoff = nowHHMM < "10:30" ? nowHHMM : "10:30";
  const [pre, krxRaw] = await Promise.all([
    fetchNxtPremarket(code, ymd),
    fetchDayMinutes(code, ymd, PREDICT_CONFIG.judgeHour).then(
      (bars) => bars ?? fetchTodayMinutes(code, PREDICT_CONFIG.judgeHour),
    ),
  ]);
  const krx = (krxRaw ?? []).filter((b) => b.time < cutoff);
  const morning = [...(pre ?? []), ...krx];
  if (morning.length < 20) return false;
  const openPx = pre?.[0]?.open ?? krx[0]?.open;
  if (!openPx) return false;
  const outputs = runAllModels({
    date: today,
    dailyHistory: complete.slice(-120),
    openPx,
    morning,
    prevDayMinutes: null, // 조기 단계는 달튼 VA 생략 (확정 판정에서 반영)
  });
  const acc = await loadAccuracyStats();
  const final = finalizeJudgment(outputs, runEnsemble(outputs, acc));
  await saveEarlyJudgment(today, final.finalVerdict, final.strengthPct, prior);
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

  // ③a 조기 판정·모니터링 (09:31~10:30) — 확정 전 잠정 판정, 변경은 revisions에 누적
  const todayBar = daily.find((b) => b.date === today);
  if (todayBar && minuteOfDay >= EARLY_MIN && minuteOfDay < JUDGE_MIN) {
    result.earlyToday = await earlyJudge(today, complete, minuteOfDay);
  }

  // ③b 당일 확정 판정 (10:31 이후, 09:00 창 — 조기 행이 있으면 확정으로 전환)
  if (todayBar && minuteOfDay >= JUDGE_MIN) {
    const row = await loadDayRow(today);
    if (!row || row.stage === "early") {
      result.judgedToday = await judgeOneDay(today, complete, todayBar.open, "live", true);
    }
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
