"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";

export type Application = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  experience: string | null;
  motivation: string | null;
  status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  created_at: string;
};

export async function getApplications(status?: string): Promise<Application[]> {
  const admin = createAdminClient();
  let query = admin
    .from("applications")
    .select("*")
    .order("created_at", { ascending: false });

  if (status && ["pending", "approved", "rejected"].includes(status)) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    console.error("getApplications error:", error);
    return [];
  }
  return (data ?? []) as Application[];
}

export async function getApplicationDetail(id: string): Promise<Application | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("applications")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return null;
  return data as Application;
}

export async function approveApplication(
  id: string,
): Promise<{ success: boolean; error?: string; inviteError?: string }> {
  const admin = createAdminClient();

  // 신청 정보 조회
  const { data: app, error: fetchError } = await admin
    .from("applications")
    .select("email, status")
    .eq("id", id)
    .single();

  if (fetchError || !app) {
    return { success: false, error: "신청 정보를 찾을 수 없습니다." };
  }

  if (app.status === "approved") {
    return { success: true }; // 이미 승인됨 — 중복 처리 방어
  }

  // DB 상태 갱신
  const { error: updateError } = await admin
    .from("applications")
    .update({ status: "approved" })
    .eq("id", id);

  if (updateError) {
    return { success: false, error: "상태 갱신 중 오류가 발생했습니다." };
  }

  // FR-035: 승인 결과 이메일 통지
  sendEmail({
    to: app.email,
    subject: "[스탁가드] 이용 신청이 승인되었습니다",
    text: `안녕하세요.\n\n스탁가드 이용 신청이 승인되었습니다.\n곧 발송되는 초대 이메일을 통해 서비스에 접속하실 수 있습니다.\n\n감사합니다.\n스탁가드 팀`,
  }).catch((e) => console.warn("[FR-035] 승인 이메일 발송 오류:", e));

  // Supabase 초대 이메일 발송
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(app.email);

  revalidatePath("/admin/applications");

  if (inviteError) {
    // DB는 이미 approved — 초대 메일만 실패
    return {
      success: true,
      inviteError: `초대 이메일 발송 실패: ${inviteError.message}. 재발송 버튼을 사용해주세요.`,
    };
  }

  return { success: true };
}

export async function rejectApplication(
  id: string,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: app } = await admin
    .from("applications")
    .select("email")
    .eq("id", id)
    .single();

  const { error } = await admin
    .from("applications")
    .update({ status: "rejected", rejection_reason: reason || null })
    .eq("id", id);

  if (error) {
    return { success: false, error: "상태 갱신 중 오류가 발생했습니다." };
  }

  // FR-035: 거절 결과 이메일 통지
  if (app?.email) {
    const reasonText = reason ? `\n\n거절 사유: ${reason}` : "";
    sendEmail({
      to: app.email,
      subject: "[스탁가드] 이용 신청 결과 안내",
      text: `안녕하세요.\n\n아쉽게도 이번에는 스탁가드 이용 신청 승인이 어렵습니다.${reasonText}\n\n추후 다시 신청해 주시기 바랍니다.\n감사합니다.\n스탁가드 팀`,
    }).catch((e) => console.warn("[FR-035] 거절 이메일 발송 오류:", e));

  }

  revalidatePath("/admin/applications");
  return { success: true };
}

export async function resendInvite(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: app } = await admin
    .from("applications")
    .select("email")
    .eq("id", id)
    .single();

  if (!app) return { success: false, error: "신청 정보를 찾을 수 없습니다." };

  const { error } = await admin.auth.admin.inviteUserByEmail(app.email);
  if (error) {
    return { success: false, error: `재발송 실패: ${error.message}` };
  }

  return { success: true };
}
