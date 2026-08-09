// sms_pause 활성 여부 — dispatch를 거치지 않는 직접 발송 경로(G1A·G1B)용.
// 사용자(발주자) 지시 2026-08-08: "G1A·G1B 관련 문자도 보내되, 단 15일 보류 기간에는 보내지 말고"
// — 종전 '전역 정지의 발주자 승인 예외'(8/9 커밋)를 이 지시로 철회. 정지 해제(8/21~) 후엔 정상 발송.
// dispatch.ts의 smsPauseBlocked와 달리 키별 허용(allowStrong) 구분 없이 기간만 본다 — G1은 정지 중 전부 보류.
import { createAdminClient } from "@/lib/supabase/admin";

export async function smsPauseActive(): Promise<boolean> {
  try {
    const { data } = await createAdminClient().from("ops_settings").select("value").eq("key", "sms_pause").maybeSingle();
    const v = (data?.value ?? null) as { until?: string } | null;
    if (typeof v?.until !== "string") return false;
    const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    return kstToday <= v.until;
  } catch { return false; } // 조회 실패 시 발송 유지 (보수적 차단보다 기존 동작 우선)
}
