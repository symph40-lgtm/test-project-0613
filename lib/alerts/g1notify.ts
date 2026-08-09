// G1A·G1B 신호/장애 알림 발송 — 이메일 절충 (사용자 결정 2026-08-10):
//   문자 보류 기간(sms_pause, ~8/21)에는 이메일로 대체 발송해 "침묵 해석 규칙"을 유지하고,
//   보류 해제 후에는 자동으로 문자 복귀. 어제(8/9 저녁) "보류 기간엔 보내지 말고" 지시는
//   '문자'에 대한 것으로 유지되며, 이메일 대체는 오늘 결정으로 신설.
// 발송 결과를 반환·기록해 무음 실패를 남기지 않는다 (8/10 R1 침묵 사고 교훈).

import { createAdminClient } from "@/lib/supabase/admin";
import { smsPauseActive } from "@/lib/alerts/pause";

export async function sendG1Notify(subject: string, text: string): Promise<{ via: "sms" | "email" | "none"; sent: number; errors: string[] }> {
  const errors: string[] = [];
  try {
    const admin = createAdminClient();
    const { data: ch, error } = await admin.from("alert_channels").select("channel_type,contact")
      .in("channel_type", ["sms", "email"]).eq("verified", true).eq("consent_given", true).limit(6);
    if (error) return { via: "none", sent: 0, errors: [error.message] };
    const paused = await smsPauseActive();
    let sent = 0;
    if (paused) {
      const { sendEmail } = await import("@/lib/email");
      for (const c of ch ?? []) {
        if (c.channel_type !== "email" || !c.contact) continue;
        const r = await sendEmail({ to: c.contact, subject: `${subject} (문자 보류 기간 이메일 대체)`, text });
        if (r.ok) sent++; else errors.push(r.error ?? "email 실패");
      }
      return { via: "email", sent, errors };
    }
    const { sendSms, hasSmsProvider } = await import("@/lib/sms");
    if (!hasSmsProvider()) return { via: "none", sent: 0, errors: ["SMS provider 없음"] };
    for (const c of ch ?? []) {
      if (c.channel_type !== "sms" || !c.contact) continue;
      const r = await sendSms({ to: c.contact, subject, text });
      if (r.ok) sent++; else errors.push(r.error ?? "sms 실패");
    }
    return { via: "sms", sent, errors };
  } catch (e) {
    return { via: "none", sent: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
}
