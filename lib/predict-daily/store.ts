// 일봉 스윙 저장/로드 — predict_daily_days (마이그레이션 030). 쓰기는 service role 전용.

import { createAdminClient } from "@/lib/supabase/admin";
import type { PredictDailyRow } from "./types";

// 마이그레이션 030 적용 여부 프로브
export async function predictDailyTablesReady(): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("predict_daily_days").select("date").limit(1);
  return !error;
}

export async function loadRecentDays(symbol: string, n: number): Promise<PredictDailyRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("predict_daily_days")
    .select("*")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(n);
  return ((data ?? []) as PredictDailyRow[]).reverse(); // 오래된 → 최신
}

export async function upsertDay(row: PredictDailyRow & { judged_at?: string; labeled_at?: string | null }): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("predict_daily_days").upsert(row, { onConflict: "date,symbol" });
  if (error) throw new Error(`predict_daily_days upsert 실패: ${error.message}`);
}

export async function updateLabels(
  date: string,
  symbol: string,
  patch: Partial<Pick<PredictDailyRow, "label_r1" | "label_r3" | "correct1" | "correct3">> & { labeled_at?: string },
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("predict_daily_days").update(patch).eq("date", date).eq("symbol", symbol);
  if (error) throw new Error(`predict_daily_days 채점 실패: ${error.message}`);
}
