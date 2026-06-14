"use server";

import { createClient } from "@/lib/supabase/server";

export async function bookmarkNextBriefing(): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const scheduledDate = tomorrow.toISOString().slice(0, 10);

  // UNIQUE(user_id, scheduled_date) 충돌 시 무시
  await supabase.from("briefing_bookmarks").upsert(
    { user_id: user.id, scheduled_date: scheduledDate },
    { onConflict: "user_id,scheduled_date" }
  );
}

export async function hasTodayBookmark(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from("briefing_bookmarks")
    .select("id")
    .eq("user_id", user.id)
    .eq("scheduled_date", today)
    .maybeSingle();

  return Boolean(data);
}
