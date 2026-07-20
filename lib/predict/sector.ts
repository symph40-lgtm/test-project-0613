// 섹터 ETF 후보 페이퍼 트래킹 (사용자 지정 2026-07-20) — 방산·조선, 10:30 피셔 판정.
// 문자 없음: 기록·채점·손익 누적만 (/predict 카드 표시). 실투자 편입 여부는 라이브 성적으로 결정.
// 흐름: ①10:31+ 당일 판정 기록 ②15:35+ 라벨·손익 채점 ③미채점 과거일 백필 (KIS 과거 분봉).

import { createAdminClient } from "@/lib/supabase/admin";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { fetchDayMinutes, clipToJudgeWindow } from "./kisMinute";
import { labelDay } from "./label";
import { runFisher } from "./models/fisher";
import type { Verdict } from "./types";

const JUDGE_MIN = 10 * 60 + 31;
const SCORE_MIN = 15 * 60 + 35;

export async function runSectorService(): Promise<{ judged: string[]; scored: string[] }> {
  const { date: today, minuteOfDay } = kstNowPredict();
  const admin = createAdminClient();
  const result = { judged: [] as string[], scored: [] as string[] };

  for (const sec of PREDICT_CONFIG.sectors) {
    const daily = await fetchDailyPredict(sec.symbol, 160);
    const complete = daily.filter((b) => b.date < today);
    if (complete.length < 40) continue;

    // ① 당일 판정 (10:31+)
    const todayBar = daily.find((b) => b.date === today);
    if (todayBar && minuteOfDay >= JUDGE_MIN) {
      const { data: exist } = await admin
        .from("predict_sector_days").select("date").eq("date", today).eq("symbol", sec.symbol).limit(1);
      if (!exist || exist.length === 0) {
        const dayMin = await fetchDayMinutes(sec.symbol, today.replace(/-/g, ""), PREDICT_CONFIG.sectorJudgeHour);
        const morning = dayMin ? clipToJudgeWindow(dayMin, PREDICT_CONFIG.sectorJudgeHour) : [];
        if (morning.length >= 50) {
          const out = runFisher({
            date: today, dailyHistory: complete.slice(-120), openPx: todayBar.open, morning, prevDayMinutes: null,
          });
          await admin.from("predict_sector_days").upsert(
            {
              date: today, symbol: sec.symbol, verdict: out.verdict,
              strength: Number((out.confidence * 100).toFixed(0)),
              entry_px: morning[morning.length - 1].close, source: "live",
            },
            { onConflict: "date,symbol" },
          );
          result.judged.push(`${sec.name}:${out.verdict}`);
        }
      }
    }

    // ② 미채점 채점 (과거일 언제나 + 오늘은 15:35 이후) — 일봉으로 라벨·손익
    const { data: unscored } = await admin
      .from("predict_sector_days").select("date, verdict, entry_px")
      .eq("symbol", sec.symbol).is("label", null).order("date", { ascending: true }).limit(15);
    for (const row of unscored ?? []) {
      const d = String(row.date);
      if (d === today && minuteOfDay < SCORE_MIN) continue;
      const bar = daily.find((b) => b.date === d);
      if (!bar) continue;
      const { label, rOC } = labelDay(bar);
      const v = row.verdict as Verdict;
      const entry = Number(row.entry_px) || null;
      const ret = v !== "none" && entry
        ? Number((((bar.close - entry) / entry) * 100 * (v === "leverage" ? 1 : -1)).toFixed(2))
        : null;
      await admin.from("predict_sector_days")
        .update({ label, r_oc: rOC, ret_pct: ret, labeled_at: new Date().toISOString() })
        .eq("date", d).eq("symbol", sec.symbol);
      result.scored.push(`${sec.name}:${d}`);
    }
  }
  return result;
}

// 페이지용 — 종목별 오늘 판정 + 누적 성적. 마이그레이션 028 미적용이면 null
export type SectorSummary = {
  symbol: string;
  name: string;
  today: { verdict: string; strength: number | null; label: string | null } | null;
  scoredN: number;
  acc3: number | null; // 3분류 정확도
  dirN: number;
  dirHit: number;
  cumRet: number; // 방향 판정 누적 손익 (진입→종가, %p)
};

export async function loadSectorSummary(): Promise<SectorSummary[] | null> {
  const admin = createAdminClient();
  const { date: today } = kstNowPredict();
  const { data, error } = await admin
    .from("predict_sector_days")
    .select("date, symbol, verdict, strength, label, ret_pct")
    .order("date", { ascending: false })
    .limit(600);
  if (error) return null;
  return PREDICT_CONFIG.sectors.map((sec) => {
    const rows = (data ?? []).filter((r) => r.symbol === sec.symbol);
    const t = rows.find((r) => String(r.date) === today);
    const scored = rows.filter((r) => r.label);
    const correct = scored.filter((r) => r.verdict === r.label).length;
    const dir = scored.filter((r) => r.verdict !== "none");
    return {
      symbol: sec.symbol,
      name: sec.name,
      today: t ? { verdict: String(t.verdict), strength: t.strength as number | null, label: (t.label as string) ?? null } : null,
      scoredN: scored.length,
      acc3: scored.length ? (correct / scored.length) * 100 : null,
      dirN: dir.length,
      dirHit: dir.filter((r) => r.verdict === r.label).length,
      cumRet: dir.reduce((s, r) => s + (Number(r.ret_pct) || 0), 0),
    };
  });
}
