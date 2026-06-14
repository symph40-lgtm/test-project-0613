"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type PrincipleKey = "lev" | "avg" | "loan" | "gap";

const PRINCIPLE_KEYS: PrincipleKey[] = ["lev", "avg", "loan", "gap"];

export type PrincipleRow = {
  id: PrincipleKey;
  label: string;
  on: boolean;
  active: boolean;
};

const LABELS: Record<PrincipleKey, string> = {
  lev: "하락장 2단계 이상에서는 레버리지 신규 매수 금지",
  avg: "급락 첫날에는 물타기 금지",
  loan: "손실 만회 목적의 대출 매수 금지",
  gap: "장마감 전 갭하락 위험 확인",
};

export async function getPrinciples(): Promise<PrincipleRow[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return PRINCIPLE_KEYS.map((id) => ({ id, label: LABELS[id], on: true, active: false }));
  }

  const { data: saved } = await supabase
    .from("principles")
    .select("principle_key, is_on")
    .eq("user_id", user.id);

  const savedMap = new Map(
    (saved ?? []).map((r) => [r.principle_key, r.is_on as boolean]),
  );

  const hasAny = savedMap.size > 0;

  return PRINCIPLE_KEYS.map((id) => ({
    id,
    label: LABELS[id],
    on: hasAny ? (savedMap.get(id) ?? false) : true,
    active: false,
  }));
}

export async function savePrinciples(
  selections: Record<PrincipleKey, boolean>,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  for (const key of PRINCIPLE_KEYS) {
    await supabase.from("principles").upsert(
      {
        user_id: user.id,
        principle_key: key,
        is_on: selections[key] ?? false,
      },
      { onConflict: "user_id,principle_key" },
    );
  }

  revalidatePath("/principles");
  return {};
}
