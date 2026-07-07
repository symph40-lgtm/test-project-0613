// 공용 알림 발송 — alertKey 기준 1일 1회, 인증·동의된 문자+이메일 채널에 발송, alerts에 이력 기록.
// 신호(M7)·금리 알람 등 trigger_key가 다른 알림들이 같은 발송·중복방지 경로를 공유한다.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";

export type ChannelAlert = {
  key: string;
  severity: "high" | "medium" | "low";
  text: string;
  smsSubject?: string; // 문자 제목 — 알림 종류 표시. 미지정 시 무제(단문 요금)
};

export async function dispatchToChannels(
  triggerKey: "signal" | "rate" | "intraday_summary",
  date: string, // KST 거래일 (YYYY-MM-DD) — 이 날짜 기준 1일 1회 중복 방지
  alert: ChannelAlert,
  emailSubject?: string,
  snapshot?: Record<string, unknown>,
): Promise<number> {
  const admin = createAdminClient();

  // 오늘(KST) 이미 발송된 alertKey인지 확인
  const kstDayStartUtc = new Date(`${date}T00:00:00+09:00`).toISOString();
  const { data: sentToday } = await admin
    .from("alerts")
    .select("user_id, message")
    .eq("trigger_key", triggerKey)
    .gte("created_at", kstDayStartUtc);
  const alreadyByUser = new Set(
    (sentToday ?? [])
      .filter((r) => (r.message as { alertKey?: string } | null)?.alertKey === alert.key)
      .map((r) => r.user_id as string),
  );

  // 수신자: 인증·동의된 SMS·이메일 채널 (사용자별 묶음)
  const { data: channels } = await admin
    .from("alert_channels")
    .select("user_id, channel_type, contact")
    .in("channel_type", ["sms", "email"])
    .eq("verified", true)
    .eq("consent_given", true);
  const byUser = new Map<string, { sms?: string; email?: string }>();
  for (const ch of channels ?? []) {
    if (!ch.contact) continue;
    const entry = byUser.get(ch.user_id) ?? {};
    if (ch.channel_type === "sms") entry.sms = ch.contact;
    if (ch.channel_type === "email") entry.email = ch.contact;
    byUser.set(ch.user_id, entry);
  }

  let sent = 0;
  for (const [userId, ch] of byUser) {
    if (alreadyByUser.has(userId)) continue;
    const results: string[] = [];
    if (ch.sms) {
      const r = await sendSms({ to: ch.sms, text: alert.text, subject: alert.smsSubject }).catch(() => ({ ok: false as const, error: "예외" }));
      results.push(`sms:${r.ok ? "ok" : "fail"}`);
      if (r.ok) sent++;
    }
    if (ch.email) {
      const r = await sendEmail({
        to: ch.email,
        subject: emailSubject ?? alert.text.split("\n")[0],
        text: `${alert.text}\n\n대시보드: https://test-project-0613.vercel.app/signal\n(판단 보조 알림입니다 — 최종 결정과 책임은 본인에게 있습니다)`,
      }).catch(() => ({ ok: false as const, error: "예외" }));
      results.push(`email:${r.ok ? "ok" : "fail"}`);
      if (r.ok) sent++;
    }
    const anyOk = results.some((s) => s.endsWith("ok"));
    await admin.from("alerts").insert({
      user_id: userId,
      trigger_key: triggerKey,
      severity: alert.severity,
      message: { alertKey: alert.key, text: alert.text, channels: results },
      market_snapshot: snapshot ?? null,
      is_sent: anyOk,
      sent_at: anyOk ? new Date().toISOString() : null,
    });
  }
  return sent;
}
