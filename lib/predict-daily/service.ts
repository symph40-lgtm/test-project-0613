// 일봉 스윙 예측 서비스 — 호출 시점 기준 백필·마감 판정·채점을 알아서 처리 (크론 지연에 강함).
// 판정: 15:05~16:00 KST 창에서 미너비니 + 10Y 게이트 + 이벤트 감산. 변경 시에만 문자.
// 기획: docs/predict-daily-spec.md 7장. 기존 lib/predict(장중)와 완전 분리.

import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_DAILY_CONFIG as CFG } from "./config";
import { fetchDaily, kstNowDaily } from "./data";
import { judgeAt, judgeDaily } from "./judge";
import { fetchMacroSnap } from "./macro";
import { loadRecentDays, predictDailyTablesReady, upsertDay, updateLabels } from "./store";
import type { DailyJudgment, MacroSnap, PredictDailyRow, Stance } from "./types";

const STANCE_KO: Record<Stance, string> = { long: "매수", short: "회피(매도)", flat: "중립(현금)" };

function fmtPx(v: number): string {
  return Math.round(v).toLocaleString();
}

function macroLine(m: MacroSnap | null): string {
  if (!m) return "";
  const parts: string[] = [];
  if (m.y10 != null) parts.push(`10Y ${m.y10.toFixed(2)}${m.y10Chg != null ? `(${m.y10Chg >= 0 ? "+" : ""}${m.y10Chg.toFixed(2)}p)` : ""}`);
  if (m.sox != null) parts.push(`SOX ${m.sox >= 0 ? "+" : ""}${m.sox.toFixed(1)}%`);
  if (m.fxLevel != null) parts.push(`환율 ${Math.round(m.fxLevel)}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function judgmentText(name: string, j: DailyJudgment, macro: MacroSnap | null, prev: Stance | null): string {
  const pct = Math.round(j.exposure * 100);
  let action: string;
  if (j.stance === "long") {
    action = `매수 비중${pct}%` + (j.gates.length ? `(${j.gates.join("·")} 감산)` : "");
  } else if (j.stance === "short") {
    action = prev === "long" ? "전량 매도 — 하락 추세 진입" : "매수 금지(하락 추세)";
  } else {
    action = prev === "long" ? "전량 매도 — 추세 이탈" : "중립(현금 유지)";
  }
  const stop = j.stance === "long" && j.stopPx ? ` 손절 ${fmtPx(j.stopPx)}(-8%)` : "";
  return `[일봉] ${name} ${action} 종가 ${fmtPx(j.closePx)}${stop}.${macroLine(macro)} 무응답=현행 유지`;
}

export async function runPredictDailyService(): Promise<Record<string, unknown>> {
  if (!(await predictDailyTablesReady())) return { ready: false, note: "마이그레이션 030 미적용" };

  const now = kstNowDaily();
  const inJudgeWindow = now.weekday >= 1 && now.weekday <= 5 && now.minuteOfDay >= CFG.judgeWindow.from && now.minuteOfDay <= CFG.judgeWindow.to;
  const macro = await fetchMacroSnap(now.date).catch(() => null);
  const summary: Record<string, unknown> = { date: now.date, judged: [], scored: 0, backfilled: 0 };

  for (const sym of CFG.symbols) {
    const bars = await fetchDaily(sym.code, CFG.daysFetch);
    if (bars.length < CFG.warmup + 10) continue;
    const idxByDate = new Map(bars.map((b, i) => [b.date, i]));
    // 완결 봉 범위: 오늘 봉은 15:40 이후에만 종가로 인정 (장중엔 진행 중 봉)
    const closedThroughToday = now.minuteOfDay >= 15 * 60 + 40;
    const isClosed = (date: string) => date < now.date || (date === now.date && closedThroughToday);

    const rows = await loadRecentDays(sym.code, CFG.backfillDays + 40);
    const have = new Map(rows.map((r) => [r.date, r]));

    // 1. 백필 — 최근 완결 거래일 중 기록 없는 날 (판정 재현, 매크로 게이트는 소급 생략)
    let backfilled = 0;
    const lastCompleted = bars.length - (isClosed(bars[bars.length - 1].date) ? 1 : 2);
    for (let j = Math.max(CFG.warmup, lastCompleted - CFG.backfillDays + 1); j <= lastCompleted; j++) {
      if (have.has(bars[j].date)) continue;
      const jg = judgeAt(bars, j);
      const row: PredictDailyRow = {
        date: bars[j].date, symbol: sym.code,
        stance: jg.stance, exposure: jg.exposure, base_exposure: jg.baseExposure,
        model_stances: jg.modelStances, macro: null, gates: jg.gates.length ? jg.gates : null,
        event: null, stop_px: jg.stopPx, close_px: jg.closePx, revisions: null,
        label_r1: null, label_r3: null, correct1: null, correct3: null, source: "backfill",
      };
      await upsertDay(row);
      have.set(row.date, row);
      backfilled++;
    }
    summary.backfilled = (summary.backfilled as number) + backfilled;

    // 2. 채점 — r1/r3 가능한 미채점 행
    let scored = 0;
    for (const r of have.values()) {
      if (r.label_r3 !== null) continue;
      const i = idxByDate.get(r.date);
      if (i === undefined) continue;
      const patch: Record<string, unknown> = {};
      if (r.label_r1 === null && i + 1 < bars.length && isClosed(bars[i + 1].date)) {
        const r1 = bars[i + 1].close / bars[i].close - 1;
        patch.label_r1 = r1 * 100;
        patch.correct1 = r.stance === "flat" ? null : r.stance === "long" ? r1 > 0 : r1 < 0;
      }
      if (i + 3 < bars.length && isClosed(bars[i + 3].date)) {
        const r3 = bars[i + 3].close / bars[i].close - 1;
        patch.label_r3 = r3 * 100;
        patch.correct3 = r.stance === "flat" ? null : r.stance === "long" ? r3 > 0 : r3 < 0;
        patch.labeled_at = new Date().toISOString();
      }
      if (Object.keys(patch).length > 0) {
        await updateLabels(r.date, sym.code, patch);
        scored++;
      }
    }
    summary.scored = (summary.scored as number) + scored;

    // 3. 오늘 마감 판정 (창 내 + 오늘 봉 존재 시)
    const todayBar = bars[bars.length - 1].date === now.date ? bars[bars.length - 1] : null;
    if (!inJudgeWindow || !todayBar) continue;

    const jg = judgeDaily(bars, macro);
    const existing = have.get(now.date) && have.get(now.date)!.source !== "backfill" ? have.get(now.date)! : null;
    // 직전 완결 거래일의 스탠스 (변경 감지 기준)
    const prevRow = [...have.values()].filter((r) => r.date < now.date).sort((a, b) => (a.date < b.date ? -1 : 1)).pop() ?? null;
    const prevStance = prevRow?.stance ?? null;
    const prevExposure = prevRow?.exposure ?? 0;

    const nowIso = new Date().toISOString();
    const changedVsPrev = jg.stance !== prevStance || Math.abs(jg.exposure - prevExposure) >= 0.05;
    const changedVsToday = existing ? existing.stance !== jg.stance || Math.abs(existing.exposure - jg.exposure) >= 0.05 : false;

    const row: PredictDailyRow & { judged_at: string } = {
      date: now.date, symbol: sym.code,
      stance: jg.stance, exposure: jg.exposure, base_exposure: jg.baseExposure,
      model_stances: jg.modelStances, macro, gates: jg.gates.length ? jg.gates : null,
      event: jg.gates.find((g) => g.startsWith("이벤트")) ?? null,
      stop_px: jg.stopPx, close_px: jg.closePx,
      revisions: existing
        ? [...(existing.revisions ?? []), ...(changedVsToday ? [{ at: nowIso, stance: jg.stance, exposure: jg.exposure }] : [])]
        : null,
      label_r1: existing?.label_r1 ?? null, label_r3: existing?.label_r3 ?? null,
      correct1: existing?.correct1 ?? null, correct3: existing?.correct3 ?? null,
      source: "live", judged_at: nowIso,
    };
    await upsertDay(row);
    (summary.judged as unknown[]).push({ symbol: sym.code, stance: jg.stance, exposure: jg.exposure, gates: jg.gates });

    // 문자: 전일 대비 변경된 첫 판정, 또는 당일 내 판정 뒤집힘 (키에 분 없음 — 스탠스·비중으로 중복 방지)
    if (CFG.sms.enabled && ((!existing && changedVsPrev) || changedVsToday)) {
      const key = `pdaily_${sym.code}_${now.date}_${jg.stance}_${Math.round(jg.exposure * 100)}`;
      await dispatchToChannels("signal", now.date, {
        key,
        severity: jg.stance !== prevStance ? "high" : "medium",
        text: judgmentText(sym.name, jg, macro, prevStance),
        smsSubject: "일봉 판정",
      });
    }
  }

  return summary;
}
