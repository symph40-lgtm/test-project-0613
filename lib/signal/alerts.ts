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
import type { Judgment } from "./types";

type SignalAlert = { key: string; severity: "high" | "medium" | "low"; text: string };

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
      text: weak
        ? `[스탁가드 신호] 상방 약한 추세${late} (${stat})\n레버리지 1/3 비중만 검토 · 트레일링 -${j.risk.trailPct}%\n${stop} · 15:00 당일 청산`
        : `[스탁가드 신호] 추세일 상방 확정${late} (${stat})\n레버리지 진입 검토 — ${j.risk.sizeGuide}\n${stop} · 15:00 당일 청산`,
    };
  }
  if (j.dayType === "추세일_하방" && j.setups.short.blocked.length === 0) {
    return {
      key: "trend_down",
      severity: "high",
      text: weak
        ? `[스탁가드 신호] 하방 약한 추세${late} (${stat})\n인버스 1/3 비중만 검토 · 트레일링 -${j.risk.trailPct}%\n${stop} · 15:00 당일 청산`
        : `[스탁가드 신호] 추세일 하방 확정${late} (${stat})\n인버스 진입 검토 — 총자산 ${j.risk.inverseCapPct}% 상한\n${stop} · 15:00 당일 청산`,
    };
  }
  if (j.dayType === "V반등후보" && (j.setups.long.verdict === "진입후보" || j.setups.long.verdict === "강한신호")) {
    return {
      key: "vrebound_long",
      severity: "high",
      text: `[스탁가드 신호] V반등 ${j.setups.long.verdict} (가점 ${j.setups.long.bonus}점, ${stat})\n반전 후 진행 확인됨 — 레버리지 검토, ${j.risk.sizeGuide}\n${stop} · 인버스 금지(XS1)`,
    };
  }
  if (j.dayType === "횡보일") {
    return {
      key: "range_day",
      severity: "low",
      text: `[스탁가드 신호] 횡보일 선언 (방향 전환 ${j.trend?.flips ?? "?"}회)\n당일 추세 매매 금지 — '안 하는 것'이 절반입니다.`,
    };
  }
  return null;
}

// 발송 실행 — state 라우트에서 판정마다 호출 (내부에서 중복·수신자 판단)
export async function maybeSendSignalSms(j: Judgment): Promise<{ sent: number; skipped: string | null }> {
  const alert = buildSignalAlert(j);
  if (!alert) return { sent: 0, skipped: "알림 대상 아님" };

  const admin = createAdminClient();

  // 오늘(KST) 이미 발송된 alertKey인지 확인
  const kstDayStartUtc = new Date(`${j.date}T00:00:00+09:00`).toISOString();
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
    // SMS — 알리고 IP 인증 실패 가능(유동 IP), 실패해도 이메일로 커버
    if (ch.sms) {
      const r = await sendSms({ to: ch.sms, text: alert.text }).catch(() => ({ ok: false as const, error: "예외" }));
      results.push(`sms:${r.ok ? "ok" : "fail"}`);
      if (r.ok) sent++;
    }
    if (ch.email) {
      const r = await sendEmail({
        to: ch.email,
        subject: alert.text.split("\n")[0], // 첫 줄 = 제목
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
      message: { alertKey: alert.key, dayType: j.dayType, text: alert.text, channels: results },
      market_snapshot: { headline: j.headline, ts: j.ts },
      is_sent: anyOk,
      sent_at: anyOk ? new Date().toISOString() : null,
    });
  }
  return { sent, skipped: sent === 0 ? (byUser.size ? "전원 기발송/실패" : "알림 채널 없음") : null };
}
