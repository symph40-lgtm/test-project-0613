"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { recommendRiskLines } from "@/lib/positions";
import { getPositions } from "../actions";
import {
  type RiskLineKey,
  type RiskLineRow,
  RISK_LINE_LABELS,
  RISK_LINE_KEYS,
} from "./constants";

export async function getRiskLines(): Promise<RiskLineRow[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const [{ data: saved }, positions] = await Promise.all([
    supabase
      .from("risk_lines")
      .select("trigger_key, is_on")
      .eq("user_id", user.id),
    getPositions(),
  ]);

  const recommended = recommendRiskLines(positions);
  const savedMap = new Map(
    (saved ?? []).map((r) => [r.trigger_key, r.is_on as boolean]),
  );

  return RISK_LINE_KEYS.map((key) => ({
    trigger_key: key,
    label: RISK_LINE_LABELS[key],
    is_on: savedMap.has(key) ? (savedMap.get(key) ?? false) : recommended.includes(key),
    recommended: recommended.includes(key),
  }));
}

export async function saveRiskLines(
  selections: Record<RiskLineKey, boolean>,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  for (const key of RISK_LINE_KEYS) {
    await supabase.from("risk_lines").upsert(
      {
        user_id: user.id,
        trigger_key: key,
        is_on: selections[key] ?? false,
      },
      { onConflict: "user_id,trigger_key" },
    );
  }

  revalidatePath("/positions/risk-line");
  return {};
}
