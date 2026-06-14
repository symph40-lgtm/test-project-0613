import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarketData } from "@/lib/market/fetch";
import { calculateRiskScores, calculateCompositeScore, classifyStage } from "@/lib/market/risk";
import { sendEmail } from "@/lib/email";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  // 인증: Authorization: Bearer <secret> 또는 ?secret=<secret>
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : querySecret;

  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const market = await fetchMarketData();
    const scores = calculateRiskScores(market);
    const composite = calculateCompositeScore(scores);
    const stage = classifyStage(composite);

    const lines: string[] = [];
    if (market.nasdaq.changePercent != null)
      lines.push(`나스닥 ${market.nasdaq.changePercent > 0 ? "+" : ""}${market.nasdaq.changePercent.toFixed(2)}%`);
    if (market.kospi.changePercent != null)
      lines.push(`KOSPI ${market.kospi.changePercent > 0 ? "+" : ""}${market.kospi.changePercent.toFixed(2)}%`);
    if (market.sox.changePercent != null)
      lines.push(`SOX ${market.sox.changePercent > 0 ? "+" : ""}${market.sox.changePercent.toFixed(2)}%`);
    if (market.treasury10y.changePercent != null)
      lines.push(`미국채 10Y ${market.treasury10y.changePercent > 0 ? "+" : ""}${market.treasury10y.changePercent.toFixed(2)}%`);

    const summaryText = lines.join(" | ");
    const emailText = `[장중 시황] ${stage} (리스크 점수: ${composite})\n\n${summaryText}\n\n스탁가드 앱에서 오늘의 투자 판단을 확인하세요.`;

    const admin = createAdminClient();
    const { data: channels } = await admin
      .from("alert_channels")
      .select("user_id, email")
      .eq("channel_type", "email")
      .eq("verified", true)
      .eq("consent_given", true);

    let sent = 0;
    const now = new Date().toISOString();

    for (const ch of channels ?? []) {
      if (!ch.email) continue;

      const emailResult = await sendEmail({
        to: ch.email,
        subject: `[스탁가드] 장중 시황 — ${stage}`,
        text: emailText,
      });

      await admin.from("alerts").insert({
        user_id: ch.user_id,
        trigger_key: "intraday_summary",
        severity: composite >= 50 ? "high" : composite >= 25 ? "medium" : "low",
        message: { subject: `장중 시황 — ${stage}`, action: "", prohibition: "", reasons: lines, nonCompliance: { cause: "", vulnerableTicker: "", lossOutcome: "", indicatorsToCheck: "" }, buffett: "" },
        market_snapshot: { composite, stage },
        is_sent: emailResult.ok,
        sent_at: emailResult.ok ? now : null,
      });

      if (emailResult.ok) sent++;
    }

    return NextResponse.json({ ok: true, sent, stage, composite });
  } catch (e) {
    console.error("[cron/intraday] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
