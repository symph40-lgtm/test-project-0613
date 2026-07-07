// 아침 브리핑 크론 (사용자 지정 2026-07-08) — 매일 08:30 KST 장문자 1~2건.
// vercel.json: "30 23 * * 0-4" (UTC) = 월~금 08:30 KST. Vercel이 CRON_SECRET을 Bearer로 자동 첨부.
// 수동 실행: /api/cron/morning-brief?secret=<CRON_SECRET>

import { NextRequest, NextResponse } from "next/server";
import { buildMorningBrief } from "@/lib/market/morningBrief";
import { dispatchToChannels } from "@/lib/alerts/dispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // AI 코멘트 포함 — 기본 10초로는 부족할 수 있음

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.nextUrl.searchParams.get("secret");
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const brief = await buildMorningBrief();
    const date = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

    // 장문(LMS)이라 제목 유지됨 — alertKey 기준 1일 1회 (재실행해도 중복 발송 없음)
    let sent = 0;
    sent += await dispatchToChannels(
      "intraday_summary",
      date,
      { key: "morning_brief_1", severity: "medium", text: brief.sms1, smsSubject: "아침브리핑 시장" },
      `아침 브리핑 ①시장 (${date})`,
    );
    if (brief.sms2) {
      sent += await dispatchToChannels(
        "intraday_summary",
        date,
        { key: "morning_brief_2", severity: "medium", text: brief.sms2, smsSubject: "아침브리핑 지표" },
        `아침 브리핑 ②지표 (${date})`,
      );
    }

    return NextResponse.json({ ok: true, sent, events: brief.events.length, parts: brief.sms2 ? 2 : 1 });
  } catch (e) {
    console.error("[cron/morning-brief] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
