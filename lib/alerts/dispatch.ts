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
let pauseCache: { until: string | null; allowStrong: boolean; all: boolean; at: number } = { until: null, allowStrong: true, all: false, at: 0 };

async function smsPauseBlocked(admin: ReturnType<typeof createAdminClient>, alertKey: string): Promise<boolean> {
  try {
    if (Date.now() - pauseCache.at > 60_000) {
      const { data } = await admin.from("ops_settings").select("value").eq("key", "sms_pause").maybeSingle();
      const v = (data?.value ?? null) as { until?: string; allowStrong?: boolean; all?: boolean } | null;
      pauseCache = {
        until: typeof v?.until === "string" ? v.until : null,
        allowStrong: v?.allowStrong !== false,
        all: v?.all === true,   // [발주자 8/23] 전 채널 정지 — 허용키·predict_now_ 예외 없이 신호 전부 차단
        at: Date.now(),
      };
    }
  } catch {
    return false; // 테이블 미존재(마이그레이션 025 전)·오류 — 정지 없음으로 처리
  }
  if (pauseCache.until === null) return false;
  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (kstToday > pauseCache.until) return false;
  if (pauseCache.all) return true;   // 8/23 전 채널 정지 — 예외 없음 (장애 통지는 dispatch를 타지 않음)
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

// ── 신모델 '대체 채널'만 차단 (사용자 정정 2026-08-06: "문자 보내지 말라는 것은 신모델 적용에 따른
// 기존 모델 부분만 — 기존 문자 전체가 아니라"): 신모델(하이닉스 사다리·삼성전자 v2·SOXX v2)이 대체한
// 장중 판정 채널만 차단하고, 신모델과 무관한 기존 문자(미국일봉·애프터장·TOP10·갭 경보·상태·성능·
// 딥바이 등)는 원래대로 발송. 판정·채점·기록은 전 스트림 계속. 비예측 계열(금리·수급·급변)은 무관.
// 차단(대체분): 하이닉스 M/본 계층·삼성전자 계층 F/M/본·미장(SOXX) 계층 F/M/본·진행경보(prog5 —
// 하닉 F분은 사다리 2단계라 실전 유지)·재확인·rev9·recut·미장 prog2. 하닉 F(predict_tr_hxF_)는
// 사다리 1단계 운반 채널이라 실전 발송 (8/4 실사고 교정).
// smsLegacyRef=true면 대체분을 차단 대신 '참고(기존모델)' 제목으로 병행 발송 (8/4 저녁 방식).
// TOP10(396500 모니터링 스트림) 문자도 차단 (사용자 지시 2026-08-06 "TOP10 관련 문자는 꺼줘" —
// 기록·채점·60일 승격 검토는 계속, 실시간 버튼 응답(fisher_now_etf)은 사용자 문의라 유지)
// predict_flat_*·uspredict_flat_* 추가 (사용자 지적 2026-08-08 "predict_flat_*은 기존 모델 아닌가"):
// 기존 피셔 스트림의 '방향 없음(가동 확인)' 통지인데 이 목록에서 빠져 있어 신모델 전용 정책을
// 그대로 통과해 왔다 — 8/06 프리장 문자 실사례. 이제 기존 계층 취급(legacyTier 제목 또는 차단).
const NM_REPLACED = /^predict_tr_(hxM|hxB|ssF|ssM|ssB)_|^predict_tr_etf|^predict_etf_|^predict_prog5_(?!hxF)|^predict_(reconf_|rev9_|recut_|flat_)|^uspredict_(tr_|prog2_|rev9_|recut_|flat_)/;
// 참고 제목 대상 (신모델과 무관하지만 구모델 산출물 표시): 미국일봉·애프터장
// 애프터장 F·M 사다리 문자 차단 (사용자 지시 2026-08-08 "애프터장 F M 모두 꺼줘" — 8/6 16:14
// 삼전 애프터 피셔F 문자 실사례). 본피셔 확정·전이(predict_ah_final/HHmm·predict_ss_ah_*)는 유지 —
// 끄려면 이 정규식에 합치면 된다. 판정·기록·채점은 계속.
const AH_LADDER_MUTED = /^predict_(ss_ahF_|ss_ahM_|ah_hxF_|ah_hxM_)/;
const NM_REF_SUBJECT = /^usdaily_|^predict_ah_|^predict_ss_ah/;
const NM_LIVE_SUBJECT = /^(predict_cw_|predict_nm_|predict_ssv2_|uspredict_v2_|predict_tr_hxF_|predict_prog5_hxF_)/;
// 제목 종목명은 정식 명칭 (사용자 지시 2026-08-05 저녁 — 하닉→하이닉스·삼전→삼성전자)
const nmInstrument = (key: string): string =>
  /^us/.test(key) ? "SOXX" : /^predict_(ssv2_|tr_ss|ss_ah)/.test(key) ? "삼성전자" : "하이닉스";

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
  if (AH_LADDER_MUTED.test(alert.key)) return 0; // 애프터장 F·M 사다리 문자 차단 (2026-08-08)
  // ── 신모델 무관 문자 전면 차단 (사용자 지시 2026-08-08 "신모델과 관계가 조금도 없는 문자는 우선은 다 꺼")
  // 화이트리스트만 통과: 신모델 3종 채널·하닉 사다리 실전 운반(F/진행경보)·기존계층 30% 실전(8/7 배합 결정)·
  // 갭경보(사다리 비중 지침)·딥바이·당일청산 리마인더·결정통지·실시간 버튼 응답·발송 점검.
  // 이로써 꺼지는 것: 일봉(pdaily)·미국일봉(usdaily)·애프터장 전체·TOP10·금리 알람·아침브리핑·장중시황·
  // 성능/리뷰·flat 가동확인·기타 M7 잔재. 판정·기록·채점은 전부 계속 — 문자 표시층만.
  // G1A/G1B는 dispatch를 거치지 않는 직접 발송(발주자 승인 예외)이라 영향 없음. 해제 = strict를 false로.
  if (PREDICT_CONFIG.smsNewModelStrict) {
    // morning_ 추가 (사용자 지시 2026-08-08 "브리핑은 보내야지") — 아침브리핑 시장/지표/레짐/이슈/갭경고
    const NM_STRICT_ALLOW = /^(morning_|predict_cw_|predict_gap_hx|predict_nm_|predict_ssv2_|predict_kr_g10$|uspredict_v2_|predict_tr_(hxF|hxM|hxB|ssF|ssM|ssB)_|predict_prog5_hxF_|predict_ss_delay_entry|uspredict_dipbuy|predict_sell_1510|predict_promote_|predict_now_|nm_audit$|nm_perf10$)/;
    if (!NM_STRICT_ALLOW.test(alert.key)) return 0;
  }
  if (PREDICT_CONFIG.smsNewModelOnly) {
    // 기존 계층 30% 실전 승격 (사용자 확정 2026-08-07 — config.legacyTier): 신모델 70%와 고정 배합으로
    // 병행하므로 대체 채널을 차단하지 않고 '실전(기존계층 30%)' 제목으로 발송한다. live: false면 종전대로.
    const LT = PREDICT_CONFIG.legacyTier;
    // 계층 문자 몫 각주 (사용자 지적 2026-08-25 — 8/25 아침 실사례: 신모델 "100% 매수" 문자 뒤에
    // 계층 "F 20%·M +30%p" 문자가 와서 합산 혼동): 계층 채널의 %는 전부 '기존계층 몫(계좌 30%)
    // 안에서의 비율'임을 본문에 일괄 명시. 템플릿마다 넣지 않고 여기 한 곳에서 붙인다 — 누락 방지.
    const SLEEVE_NOTE = `\n※ 위 %는 기존계층 몫(계좌의 ${LT.pct}%) 안에서의 비율 — 신모델(${100 - LT.pct}%) 문자와 별도 트랙, 합산 금지`;
    if (NM_REPLACED.test(alert.key) || alert.key === "predict_ss_delay_entry") {
      if (LT.live) alert = { ...alert, smsSubject: `실전(기존계층 ${LT.pct}%)·${nmInstrument(alert.key)}`, text: alert.text + SLEEVE_NOTE };
      else if (!PREDICT_CONFIG.smsLegacyRef) return 0; // 신모델 대체 채널 차단 (2026-08-06 정정 범위)
      else alert = { ...alert, smsSubject: `참고(기존모델)·${nmInstrument(alert.key)}` };
    } else if (NM_REF_SUBJECT.test(alert.key)) alert = { ...alert, smsSubject: `참고(기존모델)·${nmInstrument(alert.key)}` };
    else if (NM_LIVE_SUBJECT.test(alert.key)) alert = { ...alert, smsSubject: `실전(신모델${LT.live ? ` ${100 - LT.pct}%` : ""})·${nmInstrument(alert.key)}` };
  }
  // ── **'10시 이전에는 불확실성으로 웹사이트 표시 및 문자발송 차단 요청'** (발주자 지시 2026-08-25 —
  // 당분간, 별도 해제 지시까지): 국장 신모델(하이닉스·삼성전자) 계열 문자는 10:00 KST 이후에만 발송.
  // 이른 판정은 sms:suppressed(source kr_quiet10)로 alerts에 기록만 남기고, 10시 개시 요약 문자
  // (predict_kr_g10 — lib/predict/krQuiet10.ts)가 1건으로 합산 전달. SOXX(uspredict_*)·기존계층 30%
  // (predict_tr_hxM 등)·아침브리핑·실시간 버튼(predict_now_)은 대상 아님. 웹 /newmodel도 같은 게이트로
  // 10시 이전 오늘 표시를 숨긴다. 해제 = config.newModel.krQuietUntil을 ""로.
  {
    const KR_NM_Q10 = /^predict_(cw_|nm_|ssv2_|tr_hxF_|prog5_hxF_|gap_hx)/;
    const qU = PREDICT_CONFIG.newModel.krQuietUntil;
    if (qU && KR_NM_Q10.test(alert.key)) {
      const kq = new Date(Date.now() + 9 * 3600e3);
      if (kq.getUTCHours() * 60 + kq.getUTCMinutes() < Number(qU.slice(0, 2)) * 60 + Number(qU.slice(3, 5))) {
        const { logSuppressedSms } = await import("@/lib/alerts/pause");
        await logSuppressedSms({ alertKey: alert.key, subject: alert.smsSubject, text: alert.text, source: "kr_quiet10" });
        return 0;
      }
    }
  }
  if (quietDayBlocked(alert.key)) return 0; // 조용일 — 강한 판정 문자 외 전부 억제
  const admin = createAdminClient();
  if (await smsPauseBlocked(admin, alert.key)) {
    // 억제 이력 보존 (발주자 8/23 §3 — suppressed_sms 감사): 파이프는 정상, 발송만 차단
    const { logSuppressedSms } = await import("@/lib/alerts/pause");
    await logSuppressedSms({ alertKey: alert.key, subject: alert.smsSubject, text: alert.text, source: "dispatch" });
    return 0;
  }

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
  const textWithTime = `${alert.text}\n(발신 ${kstIso.slice(5, 10).replace("-", "/")} ${kstIso.slice(11, 19)})`;

  let sent = 0;
  for (const [userId, ch] of byUser) {
    if (alreadyByUser.has(userId)) continue;
    const results: string[] = [];
    let smsFailed = false;
    if (ch.sms && alert.suppressSms) {
      results.push("sms:quiet"); // 조용 시간 — 문자 억제 (이메일은 발송)
    } else if (ch.sms) {
      // 발송 후 확인 절차 (사용자 지시 2026-08-06 새벽 "보내고 나서 제대로 보낸 것인지 확인"):
      // 실패 시 즉시 1회 재시도 → 그래도 실패면 이메일 강제 대체 + 기록(11:00 발송 감사가 집계·통지)
      let r = await sendSms({ to: ch.sms, text: textWithTime, subject: alert.smsSubject }).catch(() => ({ ok: false as const, error: "예외" }));
      if (!r.ok) {
        r = await sendSms({ to: ch.sms, text: textWithTime, subject: alert.smsSubject }).catch(() => ({ ok: false as const, error: "예외" }));
        results.push(`sms:${r.ok ? "retry-ok" : "fail"}`);
      } else results.push("sms:ok");
      if (r.ok) sent++;
      else { smsFailed = true; console.error(`[dispatch] SMS 2회 실패 — 이메일 대체: ${alert.key}`); }
    }
    // 이메일 절감 (사용자 지정 2026-07-13: "이메일은 지금보다 1/3로") — 심각도 high와 브리핑류만
    // 발송. 조용 시간(suppressSms)·SMS 실패 대체 시엔 심각도와 무관하게 발송.
    const emailOk = alert.severity === "high" || triggerKey === "intraday_summary" || alert.suppressSms === true || smsFailed;
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
