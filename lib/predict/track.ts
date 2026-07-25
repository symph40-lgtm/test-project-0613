// 삼전 다세션 피셔 페이퍼 트래킹 (ops 지시 2026-07-25) — 프리장 피셔F · 정규장 본피셔+피셔W ·
// 애프터장 피셔. 문자 없음: 기록·채점만 (하닉은 기존 스트림·애프터·모델 스냅샷이 이미 채점).
// 배경 실측 (2026-07-25, 224일 백테스트): 삼전은 피셔W(0.25)가 3분류 67.0%·방향 63.4%로
// 본피셔(63.4%/57.4%)보다 우수 — 하닉(본피셔 우위)과 반대 양상. in-sample 격자 선택 경계가 있어
// 라이브 채점으로 재현 확인 후에만 판정자 검토. 상수는 각 세션의 하닉 검증분 그대로
// (오프셋이 10일 평균폭·세션 시가에 비례라 종목 변동폭은 자동 적응).
// 저장: predict_track_days (마이그레이션 031) — 미적용이면 조용히 스킵 (콘솔 로그만).

import { createAdminClient } from "@/lib/supabase/admin";
import { PREDICT_CONFIG } from "./config";
import { avgRange } from "./indicators";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { clipToJudgeWindow, fetchDayMinutes, fetchNxtAfterMarket, fetchNxtPremarket } from "./kisMinute";
import { labelDay } from "./label";
import { runFisher } from "./models/fisher";
import type { MinuteBar, Verdict } from "./types";

const SYMBOL = "005930"; // 삼전
const BACKFILL_DAYS = 7; // 미기록·미채점 소급 범위 (KIS 과거 분봉으로 언제든 복구)
const AH = PREDICT_CONFIG.after;

type TrackRow = {
  date: string; session: "pre" | "reg" | "after"; model: "fisherf" | "fisher" | "fisherw";
  verdict: Verdict; entry_px: number | null; label: string | null;
};

// 애프터 세션 라벨 — after.ts labelAfter와 동일 (±0.6% 스케일 + 종가 위치)
function labelAfterBars(bars: MinuteBar[]): { label: Verdict; rOC: number } {
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const rOC = ((close - open) / open) * 100;
  const pos = hi > lo ? (close - lo) / (hi - lo) : 0.5;
  let label: Verdict = "none";
  if (rOC >= AH.label.trendMinPct && pos >= AH.label.posUp) label = "leverage";
  else if (rOC <= -AH.label.trendMinPct && pos <= AH.label.posDown) label = "inverse";
  return { label, rOC: Number(rOC.toFixed(2)) };
}

export async function runTrackService(): Promise<{ judged: string[]; scored: string[] }> {
  const admin = createAdminClient();
  const { date: today, minuteOfDay } = kstNowPredict();
  const result = { judged: [] as string[], scored: [] as string[] };

  // 테이블 가드 — 마이그레이션 031 미적용이면 스킵 (deployment 메모: DB 의존 기능의 조용한 사망 방지)
  const { error: tErr } = await admin.from("predict_track_days").select("date").limit(1);
  if (tErr) {
    console.error("[track] predict_track_days 조회 실패 — 마이그레이션 031 미적용? 트래킹 스킵:", tErr.message);
    return result;
  }

  const daily = await fetchDailyPredict(SYMBOL, 180);
  const complete = daily.filter((b) => b.date < today);
  if (complete.length < 40) return result;
  const days = [...complete.slice(-BACKFILL_DAYS).map((b) => b.date), today];

  const { data: existRows } = await admin
    .from("predict_track_days")
    .select("date, session, model, verdict, entry_px, label")
    .eq("symbol", SYMBOL)
    .gte("date", days[0]);
  const have = new Map<string, TrackRow>(
    ((existRows ?? []) as (TrackRow & { date: string })[]).map((r) => [`${r.date}|${r.session}|${r.model}`, r]),
  );
  const key = (d: string, s: string, m: string) => `${d}|${s}|${m}`;

  const upsertJudge = async (
    d: string, session: TrackRow["session"], model: TrackRow["model"],
    out: { verdict: Verdict; confidence: number }, entryPx: number, isToday: boolean,
  ) => {
    const row = {
      date: d, symbol: SYMBOL, session, model,
      verdict: out.verdict, strength: Number((out.confidence * 100).toFixed(0)),
      entry_px: entryPx, source: isToday ? "live" : "backfill",
    };
    const { error } = await admin.from("predict_track_days").upsert(row, { onConflict: "date,symbol,session,model" });
    if (!error) {
      have.set(key(d, session, model), { date: d, session, model, verdict: out.verdict, entry_px: entryPx, label: null });
      result.judged.push(`${d} ${session}/${model}:${out.verdict}`);
    }
  };

  for (const d of days) {
    const isToday = d === today;
    const ymd = d.replace(/-/g, "");
    const idx = daily.findIndex((b) => b.date === d);
    const hist = idx >= 0 ? daily.slice(Math.max(0, idx - 120), idx) : complete.slice(-120);
    if (hist.length < 30) continue;

    // ── ① 판정 기록 (세션 컷 경과 + 미기록)
    // 프리장 피셔F — 창 08:00~08:50 NXT, 컷 = 프리장 종료 (09:01+ 판정)
    if (!have.has(key(d, "pre", "fisherf")) && (!isToday || minuteOfDay >= 9 * 60 + 1)) {
      const pre = await fetchNxtPremarket(SYMBOL, ymd);
      if (pre && pre.length >= 19) { // OR 15봉 + 확인 4봉
        const out = runFisher(
          { date: d, dailyHistory: hist, openPx: pre[0].open, morning: pre, prevDayMinutes: null },
          {
            offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio,
            confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes,
            strongBreakRatio: PREDICT_CONFIG.ssStrongBreakRatio, // 삼전 분리 상수 (2026-07-25) — 라이브 재현 감시용
          },
        );
        await upsertJudge(d, "pre", "fisherf", out, pre[pre.length - 1].close, isToday);
      }
    }

    // 정규장 본피셔·피셔W — 창 09:00~13:59, 컷 14:00 (확정 모델 스냅샷과 동일 원전 상수·강돌파 없음)
    const needReg = !have.has(key(d, "reg", "fisher")) || !have.has(key(d, "reg", "fisherw"));
    if (needReg && (!isToday || minuteOfDay >= 14 * 60 + 1)) {
      const dayMin = await fetchDayMinutes(SYMBOL, ymd, PREDICT_CONFIG.judgeHour);
      const morning = dayMin ? clipToJudgeWindow(dayMin, PREDICT_CONFIG.judgeHour) : [];
      if (morning.length >= 240) { // 커버리지 가드 (예상 300봉의 80% — KIS 응답 들쭉날쭉 대비)
        const input = { date: d, dailyHistory: hist, openPx: morning[0].open, morning, prevDayMinutes: null };
        const entry = morning[morning.length - 1].close;
        if (!have.has(key(d, "reg", "fisher"))) {
          await upsertJudge(d, "reg", "fisher", runFisher(input), entry, isToday);
        }
        if (!have.has(key(d, "reg", "fisherw"))) {
          await upsertJudge(d, "reg", "fisherw", runFisher(input, { offsetRangeRatio: 0.25 }), entry, isToday);
        }
      }
    }

    // 애프터장 피셔 — 창 15:30~19:29, 컷 19:30 (하닉 애프터 스트림과 동일: 오프셋 = 세션 시가 0.4%)
    if (!have.has(key(d, "after", "fisher")) && (!isToday || minuteOfDay >= 19 * 60 + 31)) {
      const ab = await fetchNxtAfterMarket(SYMBOL, ymd, "193000");
      const range10 = avgRange(hist, 10);
      if (ab && ab.length >= 23 && range10 !== null) {
        const offsetRatio = ((AH.offsetPct / 100) * ab[0].open) / range10;
        const out = runFisher(
          { date: d, dailyHistory: hist, openPx: ab[0].open, morning: ab, prevDayMinutes: null },
          { offsetRangeRatio: offsetRatio, earlyConfirmBy: "17:00" },
        );
        await upsertJudge(d, "after", "fisher", out, ab[ab.length - 1].close, isToday);
      }
    }

    // ── ② 채점 (미채점 + 세션 결과 확정 후)
    const bar = idx >= 0 ? daily[idx] : undefined;
    // 프리장·정규장 → 당일 일봉 라벨 (±1.2%) — 15:35 이후
    if (bar && (!isToday || minuteOfDay >= 15 * 60 + 35)) {
      const { label, rOC } = labelDay(bar);
      for (const [session, model] of [["pre", "fisherf"], ["reg", "fisher"], ["reg", "fisherw"]] as const) {
        const r = have.get(key(d, session, model));
        if (!r || r.label !== null) continue;
        const entry = Number(r.entry_px) || null;
        const ret = r.verdict !== "none" && entry
          ? Number((((bar.close - entry) / entry) * 100 * (r.verdict === "leverage" ? 1 : -1)).toFixed(2))
          : null;
        const { error } = await admin.from("predict_track_days")
          .update({ label, r_oc: rOC, ret_pct: ret, labeled_at: new Date().toISOString() })
          .eq("date", d).eq("symbol", SYMBOL).eq("session", session).eq("model", model);
        if (!error) {
          r.label = label;
          result.scored.push(`${d} ${session}/${model}`);
        }
      }
    }
    // 애프터장 → 애프터 라벨 (±0.6%) — 20:05 이후 전체 세션 봉으로
    const ar = have.get(key(d, "after", "fisher"));
    if (ar && ar.label === null && (!isToday || minuteOfDay >= 20 * 60 + 5)) {
      const full = await fetchNxtAfterMarket(SYMBOL, ymd, "200000");
      if (full && full.length >= 30) {
        const { label, rOC } = labelAfterBars(full);
        const entry = Number(ar.entry_px) || null;
        const aClose = full[full.length - 1].close;
        const ret = ar.verdict !== "none" && entry
          ? Number((((aClose - entry) / entry) * 100 * (ar.verdict === "leverage" ? 1 : -1)).toFixed(2))
          : null;
        const { error } = await admin.from("predict_track_days")
          .update({ label, r_oc: rOC, ret_pct: ret, labeled_at: new Date().toISOString() })
          .eq("date", d).eq("symbol", SYMBOL).eq("session", "after").eq("model", "fisher");
        if (!error) {
          ar.label = label;
          result.scored.push(`${d} after/fisher`);
        }
      }
    }
  }
  return result;
}

// 주기 성능 문자용 — 삼전 트래킹 방향적중 요약 (세션/모델별). 표본 없으면 null.
export async function loadTrackPerf(): Promise<Record<string, { c: number; t: number }> | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predict_track_days")
    .select("symbol, session, model, verdict, label")
    .eq("symbol", SYMBOL)
    .not("label", "is", null)
    .neq("verdict", "none")
    .limit(3000);
  if (error) return null;
  const out: Record<string, { c: number; t: number }> = {};
  for (const r of data ?? []) {
    const k = `${r.session}/${r.model}`;
    const s = (out[k] ??= { c: 0, t: 0 });
    s.t++;
    if (r.verdict === r.label) s.c++;
  }
  return out;
}
