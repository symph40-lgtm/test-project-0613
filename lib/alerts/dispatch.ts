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
  // 조용 시간 — true면 문자(SMS)만 억제하고 이메일은 발송 (미국 신호 야간, 사용자 지정 2026-07-13).
  // 주의: alertKey 1일 1회 기록은 그대로 남으므로 조용 시간에 소진된 키는 이후에도 문자로 재발송되지 않음.
  suppressSms?: boolean;
};

// ── 조용일 (사용자 지정 2026-07-16: "7/17·18은 조용한 곳에서 집중 — 국장·미장 문자 보내지 마,
// 강한 추세 판정 문자만 예외"). 해당 KST 날짜에는 아래 허용 키만 발송하고 나머지는 전부 억제.
const QUIET_DATES = new Set(["2026-07-17", "2026-07-18"]);
const QUIET_ALLOW_KEYS = /^(trend_up|trend_down|vrebound_long|us_trend_up|us_trend_down)(_cancel)?$/;

function quietDayBlocked(alertKey: string): boolean {
  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (!QUIET_DATES.has(kstToday)) return false;
  return !QUIET_ALLOW_KEYS.test(alertKey);
}

// ── 모바일 운영 설정: 문자 일시정지 (/ops 페이지에서 제어, ops_settings.sms_pause) — 60초 캐시.
// value: { until: "YYYY-MM-DD"(KST, 그날까지 정지), allowStrong: boolean(판정 문자는 허용) }
let pauseCache: { until: string | null; allowStrong: boolean; at: number } = { until: null, allowStrong: true, at: 0 };

async function smsPauseBlocked(admin: ReturnType<typeof createAdminClient>, alertKey: string): Promise<boolean> {
  try {
    if (Date.now() - pauseCache.at > 60_000) {
      const { data } = await admin.from("ops_settings").select("value").eq("key", "sms_pause").maybeSingle();
      const v = (data?.value ?? null) as { until?: string; allowStrong?: boolean } | null;
      pauseCache = {
        until: typeof v?.until === "string" ? v.until : null,
        allowStrong: v?.allowStrong !== false,
        at: Date.now(),
      };
    }
  } catch {
    return false; // 테이블 미존재(마이그레이션 025 전)·오류 — 정지 없음으로 처리
  }
  if (pauseCache.until === null) return false;
  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (kstToday > pauseCache.until) return false;
  return pauseCache.allowStrong ? !QUIET_ALLOW_KEYS.test(alertKey) : true;
}

// ── M7 판정·방향 계열 음소거 (사용자 지정 2026-07-20 한국 · 2026-07-21 미국 확장):
// 실투자 판정 기준이 예측 스트림(한국 /predict 피셔 · 미국 SOXX user+피셔)으로 이관되어 충돌 방지.
// 한국: 방향 제시(판정확정·횡보선언·V반등·RV1)와 장중브리핑 차단.
// 미국: us_trend_*(USD/SSG 판정 확정·해제)·us_rev_*(RV1 모멘텀 "SSG 검토") 차단 — USD/SSG는
//   저유동으로 체결 폐기됐는데 검토 문구가 계속 나가던 충돌 (2026-07-21 23:03 실측).
//   us_move·us_swing(SMH 급변·스윙 정보)도 차단 (사용자 지시 2026-07-23: "[스탁가드 미국] 꺼줘"
//   — 미장 실투자 채널은 [미국예측] 스트림으로 일원화).
// 유지: 수급반전(flow)·급변·스윙(한국 move·swing)·거래량(vol)·아침브리핑·예측(predict_*·uspredict_*).
//   판정 '기록'은 계속 쌓임 — 해제는 이 정규식만 비우면 된다.
const M7_MUTED_KEYS = /^((us_)?(trend_up|trend_down|range_day|vrebound_early|vrebound_long|rev_up|rev_down)(_cancel)?|us_(move|swing)_.*|ebrief_.*)$/;

export async function dispatchToChannels(
  triggerKey: "signal" | "rate" | "intraday_summary",
  date: string, // KST 거래일 (YYYY-MM-DD) — 이 날짜 기준 1일 1회 중복 방지
  alert: ChannelAlert,
  emailSubject?: string,
  snapshot?: Record<string, unknown>,
  // 중복 방지 창 오버라이드 (2026-07-23 실측 사고): 미장 거래일은 KST로 이틀에 걸쳐 KST 달력일
  // 창이 어제 세션 새벽 발송을 오늘 저녁 발송과 한 창으로 묶는다 (uspredict_chg_none_leverage
  // 7/22 02:10 발송 → 같은 날 22:50·00:05 복귀 문자 2건 억제·소실). 미장 계열은 dedupHours로
  // '최근 N시간' 창을 쓴다 — 세션 길이(≤8h) < N < 세션 간격(≥16h)이면 세션 단위 1회가 보장된다.
  opts?: { dedupHours?: number },
): Promise<number> {
  if (M7_MUTED_KEYS.test(alert.key)) return 0; // M7 판정·방향 계열 음소거 (2026-07-20)
  if (quietDayBlocked(alert.key)) return 0; // 조용일 — 강한 판정 문자 외 전부 억제
  const admin = createAdminClient();
  if (await smsPauseBlocked(admin, alert.key)) return 0; // 모바일 운영 설정의 일시정지

  // 중복 창: 기본 = 오늘(KST) 0시부터 / dedupHours 지정 시 = 최근 N시간
  const kstDayStartUtc = opts?.dedupHours
    ? new Date(Date.now() - opts.dedupHours * 3600e3).toISOString()
    : new Date(`${date}T00:00:00+09:00`).toISOString();
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
    if (ch.sms && alert.suppressSms) {
      results.push("sms:quiet"); // 조용 시간 — 문자 억제 (이메일은 발송)
    } else if (ch.sms) {
      const r = await sendSms({ to: ch.sms, text: alert.text, subject: alert.smsSubject }).catch(() => ({ ok: false as const, error: "예외" }));
      results.push(`sms:${r.ok ? "ok" : "fail"}`);
      if (r.ok) sent++;
    }
    // 이메일 절감 (사용자 지정 2026-07-13: "이메일은 지금보다 1/3로") — 심각도 high와 브리핑류만
    // 발송. 실측 5일 167건 중 high 63건(38%) ≈ 1/3. 조용 시간(suppressSms)엔 이메일이 유일한
    // 채널이므로 심각도와 무관하게 발송.
    const emailOk = alert.severity === "high" || triggerKey === "intraday_summary" || alert.suppressSms === true;
    if (ch.email && !emailOk) {
      results.push("email:cut"); // 절감 규칙으로 미발송
    } else if (ch.email) {
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
