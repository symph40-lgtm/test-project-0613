import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarketData } from "@/lib/market/fetch";
import { calculateRiskScores, calculateCompositeScore, classifyStage } from "@/lib/market/risk";
import { evaluateAlertTriggers } from "@/lib/alerts/triggers";
import { composeAlertMessage, alertMessageToText } from "@/lib/alerts/compose";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    const body = (await req.json()) as { userId?: string };
    userId = body.userId ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 포지션·risk_lines·원칙·알림 채널 조회
  const [positionsRes, riskLinesRes, principlesRes, channelsRes] = await Promise.all([
    admin.from("positions").select("ticker, is_leverage, sector").eq("user_id", userId),
    admin.from("risk_lines").select("trigger_key, is_on").eq("user_id", userId),
    admin.from("principles").select("principle_key, is_on").eq("user_id", userId),
    admin
      .from("alert_channels")
      .select("channel_type, contact, verified, consent_given")
      .eq("user_id", userId)
      .eq("verified", true)
      .eq("consent_given", true),
  ]);

  const positions = positionsRes.data ?? [];
  const riskLines = riskLinesRes.data ?? [];
  const principles = principlesRes.data ?? [];
  const channels = channelsRes.data ?? [];

  const enabledLines = riskLines
    .filter((r) => r.is_on)
    .map((r) => r.trigger_key as string);

  if (enabledLines.length === 0) {
    return NextResponse.json({ sent: 0, reason: "no enabled risk lines" });
  }

  // 오늘 이미 발송된 trigger_key 조회 (중복 방지)
  const today = new Date().toISOString().slice(0, 10);
  const { data: todaySent } = await admin
    .from("alerts")
    .select("trigger_key")
    .eq("user_id", userId)
    .eq("is_sent", true)
    .gte("created_at", `${today}T00:00:00Z`);

  const alreadySentKeys = new Set((todaySent ?? []).map((a) => a.trigger_key as string));

  // 시장 데이터 + 리스크 점수
  const market = await fetchMarketData();
  const riskScores = calculateRiskScores(market);
  const composite = calculateCompositeScore(riskScores);
  const stage = classifyStage(composite);

  // 트리거 평가
  const triggers = evaluateAlertTriggers(
    market,
    positions.map((p) => ({
      ticker: p.ticker,
      is_leverage: p.is_leverage,
      sector: p.sector,
    })),
    enabledLines
  );

  const newTriggers = triggers.filter((t) => !alreadySentKeys.has(t.trigger_key));

  if (newTriggers.length === 0) {
    return NextResponse.json({ sent: 0, reason: "no new triggers" });
  }

  // 인증·동의 완료된 채널 조회
  const emailChannel = channels.find((c) => c.channel_type === "email");
  const smsChannel = channels.find((c) => c.channel_type === "sms");
  let sentCount = 0;

  for (const trigger of newTriggers) {
    const msg = composeAlertMessage(trigger, positions, principles, stage);
    const text = alertMessageToText(msg);
    let isSent = false;

    if (emailChannel?.contact) {
      const result = await sendEmail({
        to: emailChannel.contact,
        subject: msg.subject,
        text,
      });
      isSent = result.ok || isSent;
    }

    if (smsChannel?.contact) {
      // SMS는 길이 제한이 있어 핵심만 발송. 제목으로 트리거 종류 표시 (사용자 요청)
      const subjectByTrigger: Record<string, string> = {
        low: "위험선 도달",
        drop5: "급락트리거 미국발",
        futures: "급락트리거 선물",
        rebound: "반등실패 경보",
      };
      const smsText = `${msg.subject}\n${trigger.reason}`;
      const result = await sendSms({
        to: smsChannel.contact,
        text: smsText,
        subject: subjectByTrigger[trigger.trigger_key] ?? "스탁가드 경보",
      });
      isSent = result.ok || isSent;
    }

    if (!emailChannel?.contact && !smsChannel?.contact) {
      // 채널 미인증 — DB만 저장
      console.log(`[ALERT NO CHANNEL]\n${text}`);
    }

    await admin.from("alerts").insert({
      user_id: userId,
      trigger_key: trigger.trigger_key,
      ticker: trigger.ticker,
      severity: trigger.severity,
      message: msg,
      market_snapshot: { composite, stage },
      is_sent: isSent,
      sent_at: isSent ? new Date().toISOString() : null,
    });

    sentCount++;
  }

  return NextResponse.json({ sent: sentCount, triggers: newTriggers.map((t) => t.trigger_key) });
}
