// 삼전 다세션 트래킹 시딩 — 과거 소급 적재 (마이그레이션 031 적용 후 1회 실행).
//   npx tsx scripts/track-seed.ts                          # 정규장 본피셔·피셔W 224일 (.predict-cache — 무통신에 가까움)
//   npx tsx scripts/track-seed.ts --sessions reg,pre,after # 프리장·애프터장 포함 (KIS 호출 많음 — 약 10분, 다른 백테스트와 병렬 금지)
//   npx tsx scripts/track-seed.ts --days 120               # 기간 조정
// 라이브(runTrackService)와 동일 상수·라벨 — source='backtest'로 적재, (date,symbol,session,model) upsert라 재실행 안전.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { clipToJudgeWindow, fetchNxtAfterMarket, fetchNxtPremarket } from "../lib/predict/kisMinute";
import { labelDay } from "../lib/predict/label";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const SESSIONS = (() => {
  const i = args.indexOf("--sessions");
  return new Set((i >= 0 ? args[i + 1] : "reg").split(","));
})();
const SYMBOL = "005930";
const AH = PREDICT_CONFIG.after;
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");

function labelAfterBars(bars: MinuteBar[]): { label: Verdict; rOC: number } {
  const open = bars[0].open, close = bars[bars.length - 1].close;
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  const rOC = ((close - open) / open) * 100;
  const pos = hi > lo ? (close - lo) / (hi - lo) : 0.5;
  let label: Verdict = "none";
  if (rOC >= AH.label.trendMinPct && pos >= AH.label.posUp) label = "leverage";
  else if (rOC <= -AH.label.trendMinPct && pos <= AH.label.posDown) label = "inverse";
  return { label, rOC: Number(rOC.toFixed(2)) };
}

async function cachedFetch(kind: "pre" | "ah", date: string): Promise<MinuteBar[] | null> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = resolve(CACHE_DIR, `${SYMBOL}-${kind}-${date}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, "utf8")) as MinuteBar[] | null; } catch { /* 재수집 */ }
  }
  const ymd = date.replace(/-/g, "");
  const bars = kind === "pre" ? await fetchNxtPremarket(SYMBOL, ymd) : await fetchNxtAfterMarket(SYMBOL, ymd, "200000");
  writeFileSync(file, JSON.stringify(bars));
  return bars;
}

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { error: tErr } = await sb.from("predict_track_days").select("date").limit(1);
  if (tErr) { console.error(`predict_track_days 조회 실패 — 마이그레이션 031을 먼저 적용하세요: ${tErr.message}`); process.exit(1); }

  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(SYMBOL, DAYS + 140)).filter((b) => b.date < today);
  const testDays = daily.slice(-DAYS);
  console.log(`삼전 트래킹 시딩: ${testDays[0].date} ~ ${testDays[testDays.length - 1].date} · 세션 ${[...SESSIONS].join(",")}`);

  const rows: Record<string, unknown>[] = [];
  let done = 0;
  for (const bar of testDays) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const hist = daily.slice(Math.max(0, idx - 120), idx);
    const { label, rOC } = labelDay(bar);
    const push = (session: string, model: string, out: { verdict: Verdict; confidence: number }, entry: number, lab: Verdict, rc: number, close: number) => {
      rows.push({
        date: bar.date, symbol: SYMBOL, session, model,
        verdict: out.verdict, strength: Number((out.confidence * 100).toFixed(0)), entry_px: entry,
        label: lab, r_oc: rc,
        ret_pct: out.verdict !== "none" ? Number((((close - entry) / entry) * 100 * (out.verdict === "leverage" ? 1 : -1)).toFixed(2)) : null,
        source: "backtest", labeled_at: new Date().toISOString(),
      });
    };

    if (SESSIONS.has("reg")) {
      const file = resolve(CACHE_DIR, `${SYMBOL}-${bar.date}.json`);
      if (existsSync(file)) {
        const dayMin = JSON.parse(readFileSync(file, "utf8")) as MinuteBar[];
        const morning = clipToJudgeWindow(dayMin, PREDICT_CONFIG.judgeHour);
        if (morning.length >= 240) {
          const input = { date: bar.date, dailyHistory: hist, openPx: morning[0].open, morning, prevDayMinutes: null };
          const entry = morning[morning.length - 1].close;
          push("reg", "fisher", runFisher(input), entry, label, rOC, bar.close);
          push("reg", "fisherw", runFisher(input, { offsetRangeRatio: 0.25 }), entry, label, rOC, bar.close);
        }
      }
    }
    if (SESSIONS.has("pre")) {
      const pre = await cachedFetch("pre", bar.date);
      if (pre && pre.length >= 19) {
        const out = runFisher(
          { date: bar.date, dailyHistory: hist, openPx: pre[0].open, morning: pre, prevDayMinutes: null },
          { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes, strongBreakRatio: PREDICT_CONFIG.earlyStrongBreakRatio },
        );
        push("pre", "fisherf", out, pre[pre.length - 1].close, label, rOC, bar.close);
      }
    }
    if (SESSIONS.has("after")) {
      const ab = await cachedFetch("ah", bar.date);
      const range10 = avgRange(hist, 10);
      if (ab && ab.length >= 30 && range10 !== null) {
        const judgeBars = ab.filter((b) => b.time < "19:30");
        if (judgeBars.length >= 23) {
          const offsetRatio = ((AH.offsetPct / 100) * judgeBars[0].open) / range10;
          const out = runFisher(
            { date: bar.date, dailyHistory: hist, openPx: judgeBars[0].open, morning: judgeBars, prevDayMinutes: null },
            { offsetRangeRatio: offsetRatio, earlyConfirmBy: "17:00" },
          );
          const { label: aLab, rOC: aRc } = labelAfterBars(ab);
          push("after", "fisher", out, judgeBars[judgeBars.length - 1].close, aLab, aRc, ab[ab.length - 1].close);
        }
      }
    }
    if (++done % 20 === 0) process.stdout.write(`\r${done}/${testDays.length}일 처리`);
  }
  console.log(`\r${done}/${testDays.length}일 처리 완료 — ${rows.length}행 적재 중`);

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("predict_track_days").upsert(rows.slice(i, i + 200), { onConflict: "date,symbol,session,model" });
    if (error) throw new Error(`시딩 실패: ${error.message}`);
  }
  // 요약
  for (const [session, model] of [["reg", "fisher"], ["reg", "fisherw"], ["pre", "fisherf"], ["after", "fisher"]]) {
    const rs = rows.filter((r) => r.session === session && r.model === model);
    if (!rs.length) continue;
    const dir = rs.filter((r) => r.verdict !== "none");
    const hit = dir.filter((r) => r.verdict === r.label).length;
    const cum = dir.reduce((s, r) => s + ((r.ret_pct as number) || 0), 0);
    console.log(`${session}/${model}: ${rs.length}일 · 방향 ${hit}/${dir.length}${dir.length ? ` (${Math.round((100 * hit) / dir.length)}%)` : ""} · 누적 ${cum >= 0 ? "+" : ""}${cum.toFixed(1)}%p`);
  }
})();
