"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";

export type ApplicationStatus = {
  id: string;
  email: string;
  name: string;
  status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  created_at: string;
};

export type SubmitState = { error: string } | null;

export async function submitApplication(
  _prevState: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const email = (formData.get("email") as string)?.trim();
  const name = (formData.get("name") as string)?.trim();
  const phone = (formData.get("phone") as string)?.trim() || null;
  const experience = (formData.get("experience") as string)?.trim() || null;
  const motivation = (formData.get("motivation") as string)?.trim() || null;

  if (!email || !name) {
    return { error: "이름과 이메일은 필수 항목입니다." };
  }

  const admin = createAdminClient();

  // 기존 신청 여부 확인
  const { data: existing } = await admin
    .from("applications")
    .select("status")
    .eq("email", email)
    .single();

  if (existing) {
    const cookieStore = await cookies();
    cookieStore.set("applicant_email", email, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 7,
      path: "/",
      sameSite: "lax",
    });
    redirect("/apply/status");
  }

  const { error } = await admin.from("applications").insert({
    email,
    name,
    phone,
    experience,
    motivation,
  });

  if (error) {
    if (error.code === "23505") {
      // 동시 요청 등으로 인한 unique 충돌 — 기존 신청으로 안내
      const cookieStore = await cookies();
      cookieStore.set("applicant_email", email, {
        httpOnly: true,
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
        sameSite: "lax",
      });
      redirect("/apply/status");
    }
    return { error: "신청 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." };
  }

  const cookieStore = await cookies();
  cookieStore.set("applicant_email", email, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
    sameSite: "lax",
  });

  redirect("/apply/status");
}

export async function getApplicationStatus(
  email: string,
): Promise<ApplicationStatus | null> {
  if (!email) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("applications")
    .select("id, email, name, status, rejection_reason, created_at")
    .eq("email", email)
    .single();

  if (error || !data) return null;
  return data as ApplicationStatus;
}

export type LookupState = { error: string } | null;

export async function lookupByEmail(
  _prevState: LookupState,
  formData: FormData,
): Promise<LookupState> {
  const email = (formData.get("email") as string)?.trim();
  if (!email) return { error: "이메일을 입력해주세요." };

  const app = await getApplicationStatus(email);
  if (!app) return { error: "해당 이메일로 접수된 신청이 없습니다." };

  const cookieStore = await cookies();
  cookieStore.set("applicant_email", email, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
    sameSite: "lax",
  });
  redirect("/apply/status");
}
