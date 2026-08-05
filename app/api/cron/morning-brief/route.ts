// 아침 브리핑 크론 (사용자 지정 2026-07-08) — 매일 아침 장문자 1~2건, 목표 08:30 KST 언저리.
// vercel.json: "45 22 * * 0-4" (UTC) = 월~금 07:45 KST. Vercel Hobby 크론은 지정 시각보다
// 34~54분 늦게 실행됨(실측 7/9~7/13: 08:30 지정 → 09:04·09:24·09:04 발송, 개장 후 도착) —
// 07:45로 당겨 지연 포함 08:00~08:40 사이 도착하도록 보정 (2026-07-13).
// 정확히 08:30에 받으려면 cron-job.org에 08:30 KST 작업 추가: /api/cron/morning-brief?secret=<CRON_SECRET>
// (alertKey 1일 1회 중복 방지가 있어 Vercel 크론과 병행해도 두 번 발송되지 않음)
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

    // ③레짐 브리핑 — 별도 문자 (사용자 지시 2026-07-25: 유사 레짐일 실측 + 비중 결론 동봉)
    let regimeSent = false;
    try {
      const { buildRegimeSms } = await import("@/lib/predict/regime");
      const regimeSms = await buildRegimeSms();
      if (regimeSms) {
        sent += await dispatchToChannels(
          "intraday_summary",
          date,
          { key: "morning_regime", severity: "medium", text: regimeSms, smsSubject: "레짐 브리핑" },
          `레짐 브리핑 (${date})`,
        );
        regimeSent = true;
      }
    } catch (e) {
      console.error("[cron/morning-brief] 레짐 브리핑 실패 (본 브리핑은 발송됨):", e);
    }

    // ④전일 이슈 브리핑 (사용자 지시 2026-07-29): 전날 실적·이벤트 영향 + 정책·지정학 변화 중
    // 비중 큰 것만 AI 선별 — 이슈 없으면 생략 (소음 방지)
    let issueSent = false;
    try {
      const { buildIssueBriefSms } = await import("@/lib/market/issueBrief");
      const issueSms = await buildIssueBriefSms();
      if (issueSms) {
        sent += await dispatchToChannels(
          "intraday_summary",
          date,
          { key: "morning_issues", severity: "medium", text: issueSms, smsSubject: "아침브리핑 이슈" },
          `전일 이슈 브리핑 (${date})`,
        );
        issueSent = true;
      }
    } catch (e) {
      console.error("[cron/morning-brief] 전일 이슈 브리핑 실패 (본 브리핑은 발송됨):", e);
    }

    // ⑤갭 추격 금지 경고 (사용자 지시 2026-08-06 — 저녁 SOXX 신호 검토(6b3dcfe) 부산물 반영):
    // 밤사이 SOXX ±2% 이상이면 국장 갭 출발 가능성 + 추격 금지 근거 동봉. 그 이하 밤은 생략(소음 방지)
    let gapWarnSent = false;
    try {
      const YahooFinance = (await import("yahoo-finance2")).default;
      const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
      const q = await yf.quote("SOXX");
      const chg = q.regularMarketChangePercent ?? 0;
      const post = q.postMarketPrice && q.regularMarketPrice ? ((q.postMarketPrice - q.regularMarketPrice) / q.regularMarketPrice) * 100 : 0;
      const tot = chg + post;
      if (Math.abs(tot) >= 2) {
        sent += await dispatchToChannels(
          "intraday_summary",
          date,
          {
            key: "morning_gapwarn", severity: "medium",
            text: `[아침브리핑 갭 경고] 밤사이 SOXX ${tot >= 0 ? "+" : ""}${tot.toFixed(1)}% — 오늘 하이닉스·삼성전자 갭 ${tot >= 0 ? "상승" : "하락"} 출발 가능성\n▶갭 방향 추격 매수 금지 — 시가에 이미 반영된 재료를 사는 것\n▶매매는 09시 이후 실전(신모델) 판정 문자 대기 (|갭| ≥4%면 정찰 절반 규칙 별도 문자)\n----\n근거(20일 실측 6b3dcfe): 갭 방향의 장중 지속 하이닉스 -17.5%p·삼성전자 -10.4%p — 갭은 시가에서 소진되고 장중 되돌림 우세. 기존 갭 실측(2~4%가 최적 구간·≥7%는 이익 0)과 정합.`,
            smsSubject: "아침브리핑 갭",
          },
          `아침 브리핑 갭 경고 (${date})`,
        );
        gapWarnSent = true;
      }
    } catch (e) {
      console.error("[cron/morning-brief] 갭 경고 실패 (본 브리핑은 발송됨):", e);
    }

    return NextResponse.json({ ok: true, sent, events: brief.events.length, parts: (brief.sms2 ? 2 : 1) + (regimeSent ? 1 : 0) + (issueSent ? 1 : 0) + (gapWarnSent ? 1 : 0) });
  } catch (e) {
    console.error("[cron/morning-brief] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
