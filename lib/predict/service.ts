// 운영 서비스 — 호출 시점 기준으로 알아서 처리 (스펙 5장):
//   ① 과거 미판정일 백필(최근 10거래일) ② 과거·당일 미채점일 채점 ③ 당일 10:30 경과 시 판정.
// KIS 과거 분봉으로 언제든 소급 가능 — 크론이 며칠 죽어도 다음 호출에서 복구된다.

import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { fetchDayMinutes, fetchTodayMinutes, clipToJudgeWindow } from "./kisMinute";
import { labelDay } from "./label";
import { runAllModels } from "./runner";
import { runEnsemble } from "./ensemble";
import { hasJudgment, listUnscoredDates, loadAccuracyStats, saveJudgment, scoreDay } from "./store";
import type { PredictDailyBar } from "./types";

const JUDGE_MIN = 10 * 60 + 31; // 10:31부터 판정 (10:29봉까지 완성 보장)
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
  await saveJudgment(date, outputs, ens, source);
  return true;
}

export type PredictRunResult = {
  date: string;
  judgedToday: boolean;
  backfilled: string[];
  scored: string[];
};

export async function runPredictService(): Promise<PredictRunResult> {
  const code = PREDICT_CONFIG.symbol;
  const { date: today, minuteOfDay } = kstNowPredict();
  const daily = await fetchDailyPredict(code, 170);
  const complete = daily.filter((b) => b.date < today); // 오늘 제외 = 확정 일봉
  const result: PredictRunResult = { date: today, judgedToday: false, backfilled: [], scored: [] };
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

  // ③ 당일 판정 (10:31 이후, 거래일에만 — 오늘 일봉이 형성돼 있어야 함)
  const todayBar = daily.find((b) => b.date === today);
  if (todayBar && minuteOfDay >= JUDGE_MIN && !(await hasJudgment(today))) {
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
