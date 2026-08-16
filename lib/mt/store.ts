// MT 저장 — mt_days·mt_state (마이그레이션 037). g1a/store.ts 패턴 준수, 쓰기는 service role.

import { createAdminClient } from "@/lib/supabase/admin";
import type { MtDay, MtSymbol } from "./types";

export async function mtTablesReady(): Promise<boolean> {
  const { error } = await createAdminClient().from("mt_days").select("date").limit(1);
  return !error;
}

export async function loadMtDay(date: string, symbol: MtSymbol): Promise<MtDay | null> {
  const { data } = await createAdminClient().from("mt_days").select("*").eq("date", date).eq("symbol", symbol).maybeSingle();
  return (data as MtDay | null) ?? null;
}

export async function loadMtRecent(limit = 90): Promise<MtDay[]> {
  const { data } = await createAdminClient().from("mt_days").select("*").order("date", { ascending: false }).limit(limit);
  return (data ?? []) as MtDay[];
}

export async function loadMtLatestPerSymbol(): Promise<MtDay[]> {
  const rows = await loadMtRecent(30);
  const seen = new Map<string, MtDay>();
  for (const r of rows) if (!seen.has(r.symbol)) seen.set(r.symbol, r);
  return [...seen.values()];
}

export async function upsertMtDay(day: MtDay): Promise<void> {
  const { error } = await createAdminClient().from("mt_days")
    .upsert({ ...day, updated_at: new Date().toISOString() }, { onConflict: "date,symbol" });
  if (error) throw new Error(`mt_days upsert 실패: ${error.message}`);
}

/** 백필·소급 대량 기입 (배치 200행) */
export async function upsertMtDays(days: MtDay[]): Promise<number> {
  const admin = createAdminClient();
  let n = 0;
  for (let i = 0; i < days.length; i += 200) {
    const chunk = days.slice(i, i + 200).map((d) => ({ ...d, updated_at: new Date().toISOString() }));
    const { error } = await admin.from("mt_days").upsert(chunk, { onConflict: "date,symbol" });
    if (error) throw new Error(`mt_days 배치 upsert 실패: ${error.message}`);
    n += chunk.length;
  }
  return n;
}

export async function loadMtState(symbol: MtSymbol): Promise<Record<string, unknown> | null> {
  const { data } = await createAdminClient().from("mt_state").select("state").eq("symbol", symbol).maybeSingle();
  return (data?.state as Record<string, unknown>) ?? null;
}

export async function saveMtState(symbol: MtSymbol, state: Record<string, unknown>): Promise<void> {
  const { error } = await createAdminClient().from("mt_state")
    .upsert({ symbol, state, updated_at: new Date().toISOString() }, { onConflict: "symbol" });
  if (error) throw new Error(`mt_state upsert 실패: ${error.message}`);
}
