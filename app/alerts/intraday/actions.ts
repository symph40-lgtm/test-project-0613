"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AlertMessage } from "@/lib/alerts/compose";

export type AlertRow = {
  id: string;
  trigger_key: string;
  severity: "high" | "medium" | "low";
  message: AlertMessage | null;
  market_snapshot: { composite: number; stage: string } | null;
  created_at: string;
  read_at: string | null;
};

export async function getLatestAlert(): Promise<AlertRow | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from("alerts")
    .select("id, trigger_key, severity, message, market_snapshot, created_at, read_at")
    .eq("user_id", user.id)
    .in("trigger_key", ["low", "drop5", "futures", "rebound"])
    .gte("created_at", `${today}T00:00:00Z`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data as AlertRow | null;
}

export async function markAlertRead(alertId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("alerts")
    .update({ read_at: new Date().toISOString() })
    .eq("id", alertId);
}
