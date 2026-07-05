// M7 신호 알림 — 판정 구간(session.observeEndMin~entryEndMin, 현재 09:30~13:30)에
// 행동 가능한 판정이 확정되면 발송.
// 채널: SMS(알리고) + 이메일(Resend) 병행 — 알리고는 발송 IP 사전등록제라 유동 IP인 Vercel에서
// 인증오류(-101)로 실패할 수 있음(2026-07-05 확인). 이메일은 IP 제한이 없어 확실한 채널.
// 수신자: alert_channels에서 각 채널 인증(verified) + 동의(consent_given)한 사용자 전체.
// 중복 방지: alerts 테이블(trigger_key='signal')에 오늘 같은 alertKey가 있으면 재발송 안 함.
// 알림은 판단 보조일 뿐 매매 지시가 아니다 — 문구에 항상 "검토" 수준으로 표현.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { SIGNAL_CONFIG } from "./config";
import type { IntradayTick, Judgment } from "./types";

type SignalAlert = {
  key: string;
  severity: "high" | "medium" | "low";
  text: string;
  smsSubject?: string; // 문자 제목 — 알림 종류 표시 (진입신호·급락트리거 등). 미지정 시 무제
};

// 판정 → 알림 여부·문구 결정 (없으면 null)
export function buildSignalAlert(j: Judgment): SignalAlert | null {
  if (j.phase !== "판정") return null; // 진입 시간대(L4)에만 문자 — 그 외는 화면으로 충분

  const t = j.trend;
  const stat = t
    ? `T ${t.score.toFixed(1)}/${t.maxAvailable}·DC1 ${t.dc1 !== null ? (t.dc1 * 100).toFixed(0) + "%" : "-"}`
    : "";
  const stop = `스탑 -${j.risk.stopFixedPct}%${j.risk.stopAtrPct !== null ? `(ATR -${j.risk.stopAtrPct.toFixed(1)}%)` : ""}`;

  // 약한 추세(장중 재형성 포함)는 확정과 구분 — 비중 1/3·타이트 트레일링 안내
  const weak = t?.grade === "약한추세";
  const late = t?.midday?.active && (t?.flips ?? 0) > 2 ? " · 장중 재형성" : "";
  if (j.dayType === "추세일_상방" && j.setups.long.blocked.length === 0) {
    return {
      key: "trend_up",
      severity: "high",
      smsSubject: "진입신호 레버리지",
      text: weak
        ? `[스탁가드 신호] 상방 약한 추세${late} (${stat})\n레버리지 1/3 비중만 검토 · 트레일링 -${j.risk.trailPct}%\n${stop} · 15:00 당일 청산`
        : `[스탁가드 신호] 추세일 상방 확정${late} (${stat})\n레버리지 진입 검토 — ${j.risk.sizeGuide}\n${stop} · 15:00 당일 청산`,
    };
  }
  if (j.dayType === "추세일_하방" && j.setups.short.blocked.length === 0) {
    return {
      key: "trend_down",
      severity: "high",
      smsSubject: "진입신호 인버스",
      text: weak
        ? `[스탁가드 신호] 하방 약한 추세${late} (${stat})\n인버스 1/3 비중만 검토 · 트레일링 -${j.risk.trailPct}%\n${stop} · 15:00 당일 청산`
        : `[스탁가드 신호] 추세일 하방 확정${late} (${stat})\n인버스 진입 검토 — 총자산 ${j.risk.inverseCapPct}% 상한\n${stop} · 15:00 당일 청산`,
    };
  }
  if (j.dayType === "V반등후보" && (j.setups.long.verdict === "진입후보" || j.setups.long.verdict === "강한신호")) {
    return {
      key: "vrebound_long",
      severity: "high",
      smsSubject: "진입신호 V반등",
      text: `[스탁가드 신호] V반등 ${j.setups.long.verdict} (가점 ${j.setups.long.bonus}점, ${stat})\n반전 후 진행 확인됨 — 레버리지 검토, ${j.risk.sizeGuide}\n${stop} · 인버스 금지(XS1)`,
    };
  }
  if (j.dayType === "횡보일") {
    return {
      key: "range_day",
      severity: "low",
      smsSubject: "매매금지 횡보일",
      text: `[스탁가드 신호] 횡보일 선언 (방향 전환 ${j.trend?.flips ?? "?"}회)\n당일 추세 매매 금지 — '안 하는 것'이 절반입니다.`,
    };
  }
  return null;
}

// ── 장중 급변 감지 (순수 함수) — 당일 등락률이 단계(config.moveAlert)를 돌파하면 알림 생성.
// 판정 구간과 무관하게 장중(09:00~15:45) 전체 감시 — 보유 중 트레일링 점검·급등 확인용.
// 문자 요금 절약을 위해 90바이트 이내 단문으로 압축 (상세는 이메일·대시보드).
export function buildMoveAlerts(tick: IntradayTick | undefined): SignalAlert[] {
  if (!tick) return [];
  const S = SIGNAL_CONFIG.session;
  if (tick.minuteOfDay < S.openMin || tick.minuteOfDay > S.endMin + 15) return [];
  const hhmm = `${String(Math.floor(tick.minuteOfDay / 60)).padStart(2, "0")}:${String(tick.minuteOfDay % 60).padStart(2, "0")}`;

  const targets: { name: string; sym: string; chg: number | null; levels: readonly number[] }[] = [
    { name: "SK하이닉스", sym: "hynix", chg: tick.hynixChg, levels: SIGNAL_CONFIG.moveAlert.stockLevels },
    { name: "삼성전자", sym: "samsung", chg: tick.samsungChg, levels: SIGNAL_CONFIG.moveAlert.stockLevels },
    { name: "코스피200선물", sym: "fut", chg: tick.futChg, levels: SIGNAL_CONFIG.moveAlert.futLevels },
  ];

  const alerts: SignalAlert[] = [];
  for (const t of targets) {
    if (t.chg === null || !isFinite(t.chg)) continue;
    // 돌파한 최고 단계 1개만 (예: -7.2%면 -7 단계. -3·-5는 이미 지난 단계지만 미발송이었다면 이 단계 알림이 커버)
    const crossed = t.levels.filter((lv) => Math.abs(t.chg as number) >= lv);
    if (crossed.length === 0) continue;
    const level = Math.max(...crossed);
    const dir = (t.chg as number) > 0 ? "급등" : "급락";
    const sign = (t.chg as number) > 0 ? "+" : "";
    alerts.push({
      key: `move_${t.sym}_${(t.chg as number) > 0 ? "u" : "d"}${level}`,
      severity: Math.abs(t.chg as number) >= t.levels[t.levels.length - 1] ? "high" : "medium",
      // 단문 (≤90바이트): "[스탁가드] SK하이닉스 급락 -5.2% (10:41) 위험선·트레일링 점검"
      text: `[스탁가드] ${t.name} ${dir} ${sign}${(t.chg as number).toFixed(1)}% (${hhmm}) ${dir === "급락" ? "위험선·트레일링 점검" : "과열·청산 검토"}`,
    });
  }
  return alerts;
}

// 급변 알림 발송 — state 라우트에서 틱마다 호출 (단계별 1일 1회 중복 방지)
export async function maybeSendMoveAlerts(date: string, tick: IntradayTick | undefined): Promise<number> {
  const alerts = buildMoveAlerts(tick);
  if (alerts.length === 0) return 0;
  let sent = 0;
  for (const alert of alerts) {
    sent += await dispatchToChannels(date, alert, `장중 급변 — ${alert.text.slice(7, 40)}`);
  }
  return sent;
}

// ── 공용 발송 — alertKey 기준 1일 1회, 인증·동의된 문자+이메일 채널에 발송, alerts에 이력 기록
async function dispatchToChannels(
  date: string,
  alert: SignalAlert,
  emailSubject?: string,
  snapshot?: Record<string, unknown>,
): Promise<number> {
  const admin = createAdminClient();

  // 오늘(KST) 이미 발송된 alertKey인지 확인
  const kstDayStartUtc = new Date(`${date}T00:00:00+09:00`).toISOString();
  const { data: sentToday } = await admin
    .from("alerts")
    .select("user_id, message")
    .eq("trigger_key", "signal")
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
      trigger_key: "signal",
      severity: alert.severity,
      message: { alertKey: alert.key, text: alert.text, channels: results },
      market_snapshot: snapshot ?? null,
      is_sent: anyOk,
      sent_at: anyOk ? new Date().toISOString() : null,
    });
  }
  return sent;
}

// 발송 실행 — state 라우트에서 판정마다 호출 (내부에서 중복·수신자 판단)
export async function maybeSendSignalSms(j: Judgment): Promise<{ sent: number; skipped: string | null }> {
  const alert = buildSignalAlert(j);
  if (!alert) return { sent: 0, skipped: "알림 대상 아님" };
  const sent = await dispatchToChannels(j.date, alert, undefined, { headline: j.headline, dayType: j.dayType, ts: j.ts });
  return { sent, skipped: sent === 0 ? "기발송 또는 채널 없음" : null };
}
