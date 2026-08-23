// sms_pause 활성 여부 — dispatch를 거치지 않는 직접 발송 경로(G1A·G1B)용.
// 사용자(발주자) 지시 2026-08-08: "G1A·G1B 관련 문자도 보내되, 단 15일 보류 기간에는 보내지 말고"
// — 종전 '전역 정지의 발주자 승인 예외'(8/9 커밋)를 이 지시로 철회. 정지 해제(8/21~) 후엔 정상 발송.
// dispatch.ts의 smsPauseBlocked와 달리 키별 허용(allowStrong) 구분 없이 기간만 본다 — G1은 정지 중 전부 보류.
//
// [발주자 지시 2026-08-23 — 전 채널 문자 정지 1개월(~9/23)] value.all=true 이면 신호 계급 SMS 전부 차단
// (dispatch 허용키·predict_now_ 예외까지). 유일 예외 = kind "fault"(시스템 장애 통지)·"verify"(OTP 인증).
// 발송만 차단 — 판정·기록·채점 파이프는 정상. 억제 이력은 alerts 테이블에 channels ["sms:suppressed"]로 보존(감사용).
import { createAdminClient } from "@/lib/supabase/admin";

export type SmsPause = { active: boolean; all: boolean; until: string | null; reason?: string };
let cache: { v: SmsPause; at: number } | null = null;

export async function smsPauseState(): Promise<SmsPause> {
  if (cache && Date.now() - cache.at < 60_000) return cache.v;
  let v: SmsPause = { active: false, all: false, until: null };
  try {
    const { data } = await createAdminClient().from("ops_settings").select("value").eq("key", "sms_pause").maybeSingle();
    const o = (data?.value ?? null) as { until?: string; all?: boolean; reason?: string } | null;
    if (typeof o?.until === "string") {
      const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      v = { active: kstToday <= o.until, all: o.all === true, until: o.until, reason: o.reason };
    }
  } catch { /* 조회 실패 시 발송 유지 (보수적 차단보다 기존 동작 우선) */ }
  cache = { v, at: Date.now() };
  return v;
}

export async function smsPauseActive(): Promise<boolean> {
  return (await smsPauseState()).active;
}

// 억제 이력 — alerts 테이블(user_id 필수)에 남긴다. user_id: 명시값 → 수신번호로 alert_channels 역조회 → 첫 SMS 사용자.
export async function logSuppressedSms(a: { userId?: string | null; to?: string | null; alertKey: string; subject?: string; text: string; source: string }): Promise<void> {
  try {
    const admin = createAdminClient();
    let userId = a.userId ?? null;
    if (!userId) {
      const q = a.to
        ? await admin.from("alert_channels").select("user_id").eq("channel_type", "sms").eq("contact", a.to).limit(1).maybeSingle()
        : await admin.from("alert_channels").select("user_id").eq("channel_type", "sms").eq("verified", true).limit(1).maybeSingle();
      userId = (q.data?.user_id as string | undefined) ?? null;
    }
    if (!userId) return;
    await admin.from("alerts").insert({
      user_id: userId, trigger_key: "signal", severity: "low",
      message: { alertKey: a.alertKey, subject: a.subject ?? null, text: a.text, channels: ["sms:suppressed"], suppressed: "sms_pause_2026-08-23", source: a.source },
      is_sent: false,
    });
  } catch { /* 로그 실패는 발송 판단에 영향 없음 */ }
}
