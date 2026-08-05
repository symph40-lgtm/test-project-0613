// 공용 알림 발송 — alertKey 기준 1일 1회, 인증·동의된 문자+이메일 채널에 발송, alerts에 이력 기록.
// 신호(M7)·금리 알람 등 trigger_key가 다른 알림들이 같은 발송·중복방지 경로를 공유한다.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { PREDICT_CONFIG } from "@/lib/predict/config";

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
// '판정 문자는 허용' 대상 (2026-07-28 실측 사고 교정): 기존엔 QUIET_ALLOW_KEYS(구 M7 trend_* 키)를
// 재사용했는데 그 키들은 M7_MUTED_KEYS로 이미 전부 음소거 — 허용 체크가 사문화되어 7/28 인버스 장에
// 판정 문자 0건. 현행 판정 채널(예측 스트림)의 전환·반전경보·회복·당일청산·공식판정 키를 허용한다.
// 유지 차단: 상태·유지확인·성능 등 저정보 키(predict_flat_*·predict_hold_*·predict_perf_* 등).
const PAUSE_ALLOW_KEYS = /^(trend_up|trend_down|vrebound_long|us_trend_up|us_trend_down)(_cancel)?$|^(us)?predict_(tr|rev9|chg|cp|recut|sell|prog5)|^uspredict_v2_(entry|rev|stop|conf|opp|ovn|bed|prot)/;
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
  if (alertKey.startsWith("predict_now_")) return false; // 피셔 실시간 버튼 = 사용자 명시 문의 — 정지 무시 (2026-07-28)
  return pauseCache.allowStrong ? !PAUSE_ALLOW_KEYS.test(alertKey) : true;
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

// ── 신모델 전용 발송 (사용자 지시 2026-08-04 새벽 "앞으로는 최종 신모델만 문자 보내줘, 헷갈리지 않게"):
// 예측 계열 키(predict_/uspredict_/pdaily_) 중 최종 신모델과 사용자 확정 독립 채널만 발송.
// 억제 대상: 계층 전이(predict_tr_·uspredict_tr_)·진행경보(prog5/prog2)·애프터(predict_ah_·ss_ah·uspredict_ah)·
// rev9·재확인·recut·보유확인·성능·TOP10(predict_tr_etf)·일봉스윙(pdaily_) 등 — 판정·채점·기록은 전부 계속,
// '문자'만 신모델 채널로 일원화. 비예측 계열(금리 rate2y_·수급 flow_·급변 move_ 등)은 이 게이트 무관.
// 해제 = config.smsNewModelOnly false. 허용: 하닉 창판정(predict_cw_)·신모델 비교/시작(predict_nm_)·
// 삼전 v2(predict_ssv2_)·SOXX v2(uspredict_v2_)·딥바이(uspredict_dipbuy, 사용자 확정 8/3)·
// 실시간 버튼 응답(predict_now_)·결정 통지(predict_promote).
// usdaily_(미국 일봉 스윙 지침)도 범위에 포함 (8/4 실측 — 첫날 08:55 "[미국일봉] 내일 지침"이 키 명명
// 차이로 게이트를 빠져나옴. SOXX 지침 채널이 신모델 v2와 이원화되면 혼란이라 억제).
const NM_ONLY_SCOPE = /^(us)?predict_|^pdaily_|^usdaily_/;
// 하닉 F 판정(predict_tr_hxF_)·하닉 F 진행성(predict_prog5_hxF_)은 하닉 최종 신모델(4단 사다리)의
// 1·2단계 운반 채널이라 허용 (8/4 실측 교정 — 첫날 09:31 F 인버 판정 문자가 차단됐음. 사다리 =
// F30% → 진행성 70% → 창동의 100%이므로 F가 침묵하면 신모델 1단계가 죽는다). 하닉 M/본·삼전 계층·
// TOP10은 신모델 세트 밖 — 계속 억제.
const NM_ONLY_ALLOW = /^(predict_cw_|predict_nm_|predict_ssv2_|uspredict_v2_|uspredict_dipbuy|predict_now_|predict_promote|predict_tr_hxF_|predict_prog5_hxF_)/;
// '참고(기존모델)' 병행 발송 (사용자 지시 2026-08-04 저녁 "당분간 삼전 M/본·하닉 M/본·SOXX M/본도
// 보내줘, 제목으로 구분하면 헷갈리지 않지"): 기존 계층의 M·본 문자는 발송하되 제목을 참고(기존모델)로,
// 신모델 채널은 실전(신모델)로 교체해 실전/참고를 제목에서 즉시 구분. F 계층(삼전 ssF·미장 F)은
// 신모델 심판 F와 중복 혼란이라 계속 억제 (하닉 F만 사다리 1단계라 실전 소속).
// usdaily_(미국 일봉 스윙)도 참고 채널로 재개 (사용자 8/5 저녁 "일봉 예측 문자 안 오는데" — 8/4 차단분 복원)
const NM_REF_ALLOW = /^predict_tr_(hxM|hxB|ssM|ssB)_|^uspredict_tr_[MB]_|^usdaily_/;
const NM_LIVE_SUBJECT = /^(predict_cw_|predict_nm_|predict_ssv2_|uspredict_v2_|predict_tr_hxF_|predict_prog5_hxF_)/;
// 제목 종목명은 정식 명칭 (사용자 지시 2026-08-05 저녁 — 하닉→하이닉스·삼전→삼성전자)
const nmInstrument = (key: string): string =>
  /^us/.test(key) ? "SOXX" : /^predict_(ssv2_|tr_ss)/.test(key) ? "삼성전자" : "하이닉스";

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
  if (PREDICT_CONFIG.smsNewModelOnly && NM_ONLY_SCOPE.test(alert.key)) {
    const refOk = PREDICT_CONFIG.smsLegacyRef && NM_REF_ALLOW.test(alert.key); // 참고 채널 — smsLegacyRef로만 on/off
    if (!NM_ONLY_ALLOW.test(alert.key) && !refOk) return 0; // 신모델 전용 (2026-08-04)
    // 실전/참고 제목 구분 (사용자 지시 2026-08-04 저녁) — 본문 첫 줄의 [채널명]과 별개로 제목에서 즉시 판별
    if (refOk) alert = { ...alert, smsSubject: `참고(기존모델)·${nmInstrument(alert.key)}` };
    else if (NM_LIVE_SUBJECT.test(alert.key)) alert = { ...alert, smsSubject: `실전(신모델)·${nmInstrument(alert.key)}` };
  }
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

  // 발신 시각 일괄 부착 (사용자 지시 2026-07-25 "모든 문자 내에 시간을 적어줘") — 공통 경로라
  // 전 알림 계열에 빠짐없이 적용. 확인 시각(문자 본문 내 개별 표기)과 별개로, 수신 지연 판별용.
  const kstIso = new Date(Date.now() + 9 * 3600e3).toISOString(); // 날짜 포함 (사용자 지시 2026-07-25 2차)
  const textWithTime = `${alert.text}\n(발신 ${kstIso.slice(5, 10).replace("-", "/")} ${kstIso.slice(11, 16)})`;

  let sent = 0;
  for (const [userId, ch] of byUser) {
    if (alreadyByUser.has(userId)) continue;
    const results: string[] = [];
    if (ch.sms && alert.suppressSms) {
      results.push("sms:quiet"); // 조용 시간 — 문자 억제 (이메일은 발송)
    } else if (ch.sms) {
      const r = await sendSms({ to: ch.sms, text: textWithTime, subject: alert.smsSubject }).catch(() => ({ ok: false as const, error: "예외" }));
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
        text: `${textWithTime}\n\n대시보드: https://test-project-0613.vercel.app/signal\n(판단 보조 알림입니다 — 최종 결정과 책임은 본인에게 있습니다)`,
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
