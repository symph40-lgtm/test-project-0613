"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { sendSms, normalizePhone } from "@/lib/sms";

export type AlertChannel = {
  channel_type: "email" | "sms";
  contact: string;
  verified: boolean;
  consent_given: boolean;
};

export async function getAlertChannels(): Promise<AlertChannel[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("alert_channels")
    .select("channel_type, contact, verified, consent_given")
    .eq("user_id", user.id);

  return (data ?? []) as AlertChannel[];
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function startOtpVerification(
  channelType: "email" | "sms",
  contact: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  // 채널별 연락처 유효성 검사 + 정규화
  let normalizedContact = contact;
  if (channelType === "email") {
    if (!contact || !contact.includes("@")) {
      return { error: "유효한 이메일 주소를 입력해주세요." };
    }
  } else {
    const phone = normalizePhone(contact);
    if (!phone) {
      return { error: "유효한 휴대폰 번호를 입력해주세요. (예: 010-1234-5678)" };
    }
    normalizedContact = phone;
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error: dbError } = await supabase.from("alert_channels").upsert(
    {
      user_id: user.id,
      channel_type: channelType,
      contact: normalizedContact,
      verified: false,
      otp_code: otp,
      otp_expires_at: expiresAt,
    },
    { onConflict: "user_id,channel_type" },
  );

  if (dbError) return { error: "인증 요청 중 오류가 발생했습니다." };

  if (channelType === "email") {
    const { ok, error: mailError } = await sendEmail({
      to: normalizedContact,
      subject: "[스탁가드] 이메일 인증 코드",
      text: `스탁가드 이메일 인증 코드: ${otp}\n\n이 코드는 10분간 유효합니다.\n본인이 요청하지 않은 경우 이 메일을 무시해주세요.`,
    });
    if (!ok) return { error: mailError ?? "이메일 발송에 실패했습니다." };
  } else {
    const { ok, error: smsError } = await sendSms({
      to: normalizedContact,
      text: `[스탁가드] 인증번호 ${otp} (10분 내 입력)`,
    });
    if (!ok) return { error: smsError ?? "문자 발송에 실패했습니다." };
  }

  return {};
}

export async function verifyOtp(
  channelType: "email" | "sms",
  code: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  const { data: channel } = await supabase
    .from("alert_channels")
    .select("otp_code, otp_expires_at")
    .eq("user_id", user.id)
    .eq("channel_type", channelType)
    .single();

  if (!channel) return { error: "인증 요청 정보를 찾을 수 없습니다. 다시 요청해주세요." };
  if (!channel.otp_code) return { error: "인증 요청 정보가 없습니다. 다시 요청해주세요." };

  if (new Date(channel.otp_expires_at) < new Date()) {
    return { error: "인증 코드가 만료됐습니다. 다시 요청해주세요." };
  }

  if (channel.otp_code !== code.trim()) {
    return { error: "인증 코드가 맞지 않습니다." };
  }

  await supabase
    .from("alert_channels")
    .update({ verified: true, otp_code: null, otp_expires_at: null })
    .eq("user_id", user.id)
    .eq("channel_type", channelType);

  revalidatePath("/positions/risk-line");
  return {};
}

export async function saveConsent(
  channelType: "email" | "sms",
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  await supabase
    .from("alert_channels")
    .update({ consent_given: true })
    .eq("user_id", user.id)
    .eq("channel_type", channelType);

  revalidatePath("/positions/risk-line");
  return {};
}
