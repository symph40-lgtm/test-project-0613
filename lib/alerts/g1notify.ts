// G1A·G1B 신호/장애 알림 발송.
//   이력: 8/10 이메일 절충(문자 보류 기간 이메일 대체, ~8/21) → 8/21 해제 → **8/23 발주자 지시: 전 채널 문자 정지 1개월(~9/23)**.
//   8/23 규율: kind "signal"(T2/R1/R2·야간 역행·이벤트 통보 등 판정성)은 정지 중 **억제**(이메일 대체 없음 —
//   "발송만 차단, 파이프 정상", 억제 이력 alerts 테이블 보존). kind "fault"(발행 실패·파이프 다운·정본 불일치)는
//   예측 신호가 아니므로 정지 무관 상시 발송(기존 판정 유지). 발송 성공분도 alerts에 기록해 감사 가능하게
//   (8/22 새벽 "02:00 발송?" 질의 — G1 직접 경로는 종전 무기록이라 확인이 느렸던 교훈).
// 발송 결과를 반환·기록해 무음 실패를 남기지 않는다 (8/10 R1 침묵 사고 교훈).

import { createAdminClient } from "@/lib/supabase/admin";
import { logSuppressedSms, smsPauseState } from "@/lib/alerts/pause";

export type G1NotifyKind = "signal" | "fault";

export async function sendG1Notify(subject: string, text: string, kind: G1NotifyKind = "signal"): Promise<{ via: "sms" | "email" | "suppressed" | "none"; sent: number; errors: string[] }> {
  const errors: string[] = [];
  try {
    const admin = createAdminClient();
    const { data: ch, error } = await admin.from("alert_channels").select("user_id,channel_type,contact")
      .in("channel_type", ["sms", "email"]).eq("verified", true).eq("consent_given", true).limit(6);
    if (error) return { via: "none", sent: 0, errors: [error.message] };
    const ps = await smsPauseState();
    if (kind === "signal" && ps.active) {
      // 8/23 정지: 신호 계급 억제 — 사용자별 1건 로그 (이메일 대체 없음)
      const users = new Set((ch ?? []).filter((c) => c.channel_type === "sms").map((c) => c.user_id as string));
      for (const uid of users) await logSuppressedSms({ userId: uid, alertKey: `g1:${subject}`, subject, text, source: "g1notify" });
      return { via: "suppressed", sent: 0, errors: [] };
    }
    const { sendSms, hasSmsProvider } = await import("@/lib/sms");
    if (!hasSmsProvider()) return { via: "none", sent: 0, errors: ["SMS provider 없음"] };
    let sent = 0;
    for (const c of ch ?? []) {
      if (c.channel_type !== "sms" || !c.contact) continue;
      const r = await sendSms({ to: c.contact, subject, text, kind: kind === "fault" ? "fault" : "signal" });
      if (r.ok) sent++; else errors.push(r.error ?? "sms 실패");
      // 발송 감사 로그 (성공·실패 모두)
      try {
        await admin.from("alerts").insert({
          user_id: c.user_id, trigger_key: "signal", severity: kind === "fault" ? "high" : "medium",
          message: { alertKey: `g1:${subject}`, subject, text, channels: [r.ok ? "sms:ok" : r.suppressed ? "sms:suppressed" : "sms:fail"], source: "g1notify", kind },
          is_sent: r.ok, sent_at: r.ok ? new Date().toISOString() : null,
        });
      } catch { /* 로그 실패 무시 */ }
    }
    return { via: "sms", sent, errors };
  } catch (e) {
    return { via: "none", sent: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
}
