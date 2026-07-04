// M7 신호 SMS 알림 — 판정 구간(session.observeEndMin~entryEndMin, 현재 09:30~13:30)에
// 행동 가능한 판정이 확정되면 문자 발송.
// 수신자: alert_channels에서 sms 채널 인증(verified) + 동의(consent_given)한 사용자 전체.
// 중복 방지: alerts 테이블(trigger_key='signal')에 오늘 같은 alertKey가 있으면 재발송 안 함.
// 알림은 판단 보조일 뿐 매매 지시가 아니다 — 문구에 항상 "검토" 수준으로 표현.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/sms";
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

  // 수신자: 인증·동의된 SMS 채널
  const { data: channels } = await admin
    .from("alert_channels")
    .select("user_id, contact")
    .eq("channel_type", "sms")
    .eq("verified", true)
    .eq("consent_given", true);

  let sent = 0;
  for (const ch of channels ?? []) {
    if (!ch.contact || alreadyByUser.has(ch.user_id)) continue;
    const r = await sendSms({ to: ch.contact, text: alert.text }).catch(() => ({ ok: false as const }));
    await admin.from("alerts").insert({
      user_id: ch.user_id,
      trigger_key: "signal",
      severity: alert.severity,
      message: { alertKey: alert.key, dayType: j.dayType, text: alert.text },
      market_snapshot: { headline: j.headline, ts: j.ts },
      is_sent: r.ok,
      sent_at: r.ok ? new Date().toISOString() : null,
    });
    if (r.ok) sent++;
  }
  return { sent, skipped: sent === 0 ? (channels?.length ? "전원 기발송/실패" : "SMS 채널 없음") : null };
}
