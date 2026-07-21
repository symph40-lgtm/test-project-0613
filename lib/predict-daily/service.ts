// 일봉 스윙 예측 서비스 — 호출 시점 기준 백필·마감 판정·채점을 알아서 처리 (크론 지연에 강함).
// 판정: 15:05~16:00 KST 창에서 미너비니 + 10Y 게이트 + 이벤트 감산. 변경 시에만 문자.
// 기획: docs/predict-daily-spec.md 7장. 기존 lib/predict(장중)와 완전 분리.

import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { fetchAfterPrice } from "./after";
import { PREDICT_DAILY_CONFIG as CFG } from "./config";
import { fetchDaily, kstNowDaily } from "./data";
import { fetchRecentFlow, flowLine, type FlowDay } from "./flow";
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
  if (m.dxy != null) parts.push(`DXY ${m.dxy.toFixed(1)}${m.dxyChg != null ? `(${m.dxyChg >= 0 ? "+" : ""}${m.dxyChg.toFixed(1)}%)` : ""}`);
  if (m.wti != null) parts.push(`WTI ${m.wti.toFixed(1)}${m.wtiChg != null ? `(${m.wtiChg >= 0 ? "+" : ""}${m.wtiChg.toFixed(1)}%)` : ""}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

// 판정 유지 문자 (매일 발송 — 사용자 지시 2026-07-22 "잊어버릴 수 있으니 매일, 언제부터 동일인지 표기")
function holdText(name: string, j: DailyJudgment, macro: MacroSnap | null, flow: FlowDay[], since: string, days: number): string {
  const pct = Math.round(j.exposure * 100);
  const what = j.stance === "long" ? `매수 비중${pct}%` : j.stance === "short" ? "회피(현금)" : "중립(현금)";
  const stop = j.stance === "long" && j.stopPx ? ` 손절 ${fmtPx(j.stopPx)}` : "";
  return `[일봉] ${name} ${what} 유지 — ${since.slice(5).replace("-", "/")}부터 ${days}거래일째. 종가 ${fmtPx(j.closePx)}${stop}.${macroLine(macro)}${flowLine(flow)}`;
}

function judgmentText(name: string, j: DailyJudgment, macro: MacroSnap | null, prev: Stance | null, flow: FlowDay[]): string {
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
  return `[일봉] ${name} ${action} 종가 ${fmtPx(j.closePx)}${stop}.${macroLine(macro)}${flowLine(flow)} 무응답=현행 유지`;
}

export async function runPredictDailyService(): Promise<Record<string, unknown>> {
  if (!(await predictDailyTablesReady())) return { ready: false, note: "마이그레이션 030 미적용" };

  const now = kstNowDaily();
  const inJudgeWindow = now.weekday >= 1 && now.weekday <= 5 && now.minuteOfDay >= CFG.judgeWindow.from && now.minuteOfDay <= CFG.judgeWindow.to;
  const macro = await fetchMacroSnap(now.date).catch(() => null);
  const summary: Record<string, unknown> = { date: now.date, judged: [], after: [], scored: 0, backfilled: 0 };

  for (const sym of CFG.symbols) {
    const bars = await fetchDaily(sym.code, CFG.daysFetch);
    if (bars.length < CFG.warmup + 10) continue;
    const idxByDate = new Map(bars.map((b, i) => [b.date, i]));
    // 완결 봉 범위: 오늘 봉은 15:40 이후에만 종가로 인정 (장중엔 진행 중 봉)
    const closedThroughToday = now.minuteOfDay >= 15 * 60 + 40;
    const isClosed = (date: string) => date < now.date || (date === now.date && closedThroughToday);

    const rows = await loadRecentDays(sym.code, 320); // 유지 스트릭("언제부터 동일 판정") 계산 여유 포함
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
        model_stances: jg.modelStances, macro: null, flow: null, gates: jg.gates.length ? jg.gates : null,
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
    if (inJudgeWindow && todayBar) {
    const jg = judgeDaily(bars, macro);
    const flow = await fetchRecentFlow(sym.code); // 확정치는 전일까지 — 표시·기록용 (게이트 아님)
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
      model_stances: jg.modelStances, macro, flow: flow.length ? flow.slice(-5) : null, gates: jg.gates.length ? jg.gates : null,
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

    // 문자: 매일 발송 (사용자 지시 2026-07-22 — 잊지 않도록). 변경이면 행동 지침, 유지면 "언제부터" 표기.
    //   키에 분 없음 — 스탠스·비중 조합으로 하루 내 중복 방지 (창 내 판정 뒤집힘 시에만 재발송).
    if (CFG.sms.enabled && (!existing || changedVsToday)) {
      // 유지 스트릭: 오늘과 같은 스탠스가 연속된 직전 거래일들 (오늘 포함 N거래일째)
      let since = now.date, streak = 1;
      const pastRows = [...have.values()].filter((r) => r.date < now.date).sort((a, b) => (a.date < b.date ? -1 : 1));
      for (let k = pastRows.length - 1; k >= 0; k--) {
        if (pastRows[k].stance !== jg.stance) break;
        since = pastRows[k].date; streak++;
      }
      const changed = changedVsPrev || changedVsToday;
      const key = `pdaily_${sym.code}_${now.date}_${jg.stance}_${Math.round(jg.exposure * 100)}`;
      await dispatchToChannels("signal", now.date, {
        key,
        severity: changed ? (jg.stance !== prevStance ? "high" : "medium") : "low",
        text: changed ? judgmentText(sym.name, jg, macro, prevStance, flow) : holdText(sym.name, jg, macro, flow, since, streak),
        smsSubject: "일봉 판정",
      });
    }
    have.set(now.date, row);
    }

    // 4. 애프터장 재판정 (사용자 크론 19·20시) — NXT 애프터 현재가로 오늘 일봉을 갱신해 재판정.
    //    스탠스 전환 또는 손절선 하회 시에만 문자 — "애프터장 마감 전 매도/매수 결정" 지원.
    const inAfterWindow = now.weekday >= 1 && now.weekday <= 5 && now.minuteOfDay >= CFG.afterWindow.from && now.minuteOfDay <= CFG.afterWindow.to;
    const todayRow = have.get(now.date) ?? null;
    if (inAfterWindow && todayBar && todayRow) {
      const nowHHMMSS = `${String(Math.floor(now.minuteOfDay / 60)).padStart(2, "0")}${String(now.minuteOfDay % 60).padStart(2, "0")}00`;
      const after = await fetchAfterPrice(sym.code, now.date.replace(/-/g, ""), nowHHMMSS);
      if (after) {
        const adjusted = bars.slice(0, -1).concat([{ ...todayBar, close: after.px, high: Math.max(todayBar.high, after.px), low: Math.min(todayBar.low, after.px) }]);
        const jgAfter = judgeDaily(adjusted, macro);
        const stopHit = todayRow.stance === "long" && todayRow.stop_px !== null && after.px <= todayRow.stop_px;
        const flipped = jgAfter.stance !== todayRow.stance;
        (summary.after as unknown[]).push({ symbol: sym.code, px: after.px, at: after.time, stance: jgAfter.stance, flipped, stopHit });
        if (CFG.sms.enabled && (flipped || stopHit)) {
          const chgPct = ((after.px / todayBar.close - 1) * 100).toFixed(1);
          const reason = stopHit ? "손절선 하회" : jgAfter.stance === "long" ? "추세 충족 전환" : "추세 이탈";
          const action = stopHit || (flipped && todayRow.stance === "long")
            ? "애프터장 마감 전 매도 권고"
            : flipped && jgAfter.stance === "long" ? "내일 갭 대비 애프터 매수 검토" : "관망";
          const key = `pdaily_after_${sym.code}_${now.date}_${stopHit ? "stop" : jgAfter.stance}`;
          await dispatchToChannels("signal", now.date, {
            key,
            severity: "high",
            text: `[일봉·애프터] ${sym.name} 애프터 ${fmtPx(after.px)}(${chgPct.startsWith("-") ? "" : "+"}${chgPct}%) — ${reason}. ${action}. 무응답=현행 유지`,
            smsSubject: "일봉 애프터",
          });
          // 기록: revisions에 애프터 재판정 누적 (같은 스탠스 반복은 생략)
          const revs = todayRow.revisions ?? [];
          const lastRev = revs[revs.length - 1];
          if (!lastRev || lastRev.stance !== jgAfter.stance) {
            await upsertDay({ ...todayRow, revisions: [...revs, { at: new Date().toISOString(), stance: jgAfter.stance, exposure: jgAfter.exposure }] });
          }
        }
      }
    }
  }

  return summary;
}
