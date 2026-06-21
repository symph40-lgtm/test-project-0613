"use server";

import { createClient } from "@/lib/supabase/server";

export type NoteRow = {
  id: string;
  body: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

const SELECT = "id, body, pinned, created_at, updated_at";

export async function getNotes(): Promise<NoteRow[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data } = await supabase
    .from("investor_notes")
    .select(SELECT)
    .eq("user_id", user.id)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  return (data ?? []) as NoteRow[];
}

export async function addNote(body: string): Promise<{ error?: string; note?: NoteRow }> {
  const b = body.trim();
  if (!b) return { error: "내용을 입력하세요." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다." };
  const { data, error } = await supabase
    .from("investor_notes")
    .insert({ user_id: user.id, body: b })
    .select(SELECT)
    .single();
  if (error) return { error: "저장 중 오류가 발생했습니다." };
  return { note: data as NoteRow };
}

export async function updateNote(id: string, body: string): Promise<{ error?: string }> {
  const b = body.trim();
  if (!b) return { error: "내용을 입력하세요." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다." };
  const { error } = await supabase
    .from("investor_notes")
    .update({ body: b })
    .eq("id", id)
    .eq("user_id", user.id);
  return error ? { error: "수정 중 오류가 발생했습니다." } : {};
}

export async function togglePin(id: string, pinned: boolean): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다." };
  const { error } = await supabase
    .from("investor_notes")
    .update({ pinned })
    .eq("id", id)
    .eq("user_id", user.id);
  return error ? { error: "처리 중 오류가 발생했습니다." } : {};
}

export async function deleteNote(id: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다." };
  const { error } = await supabase.from("investor_notes").delete().eq("id", id).eq("user_id", user.id);
  return error ? { error: "삭제 중 오류가 발생했습니다." } : {};
}
