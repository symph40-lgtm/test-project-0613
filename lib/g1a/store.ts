// G1A v0.3 저장 — g1a_days (마이그레이션 034). predict-daily store 패턴 준수, 쓰기는 service role.

import { createAdminClient } from "@/lib/supabase/admin";
import type { G1ARow, G1ASymbol } from "./types";

export async function g1aTablesReady(): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("g1a_days").select("date").limit(1);
  return !error;
}

export async function loadDay(date: string, symbol: G1ASymbol): Promise<G1ARow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("g1a_days").select("*").eq("date", date).eq("symbol", symbol).maybeSingle();
  return (data as G1ARow | null) ?? null;
}

export async function upsertDay(row: G1ARow): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("g1a_days")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "date,symbol" });
  if (error) throw new Error(`g1a_days upsert 실패: ${error.message}`);
}

// 라벨 미기입 행 (직전 판정일들)
export async function loadUnlabeled(limit = 6): Promise<G1ARow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("g1a_days")
    .select("*")
    .is("labels", null)
    .order("date", { ascending: false })
    .limit(limit);
  return (data ?? []) as G1ARow[];
}
