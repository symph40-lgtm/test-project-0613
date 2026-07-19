// 미국 2년물 금리 급등락 알람 크론 (기획: docs/rate-alert.md)
// cron-job.org에 10분 간격 등록: /api/cron/rate-alert?secret=<CRON_SECRET>
// 매 호출: 현재 금리 샘플 저장 → 샘플 간 변동으로 급변·레벨 돌파 판정 → 문자+이메일 발송.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import {
  rateAlertConfig,
  evaluateRateAlerts,
  fetchUs2yYield,
  fetchUs10yYield,
  type RateSample,
} from "@/lib/market/rateAlert";

export const dynamic = "force-dynamic";

// KST 날짜 문자열 (중복 방지 기준일)
function kstDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : querySecret;
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [y2q, y10q] = await Promise.all([fetchUs2yYield(), fetchUs10yYield()]);
    if (y2q.value === null && y10q.value === null) {
      return NextResponse.json({ ok: false, reason: "시세 조회 실패 (네이버·야후 모두 무응답)" }, { status: 502 });
    }

    const admin = createAdminClient();
    const now = new Date();

    // 1) 샘플 저장 — 실패(예: 마이그레이션 018 미적용)면 판정도 무의미하므로 즉시 보고
    const ins = await admin.from("rate_samples").insert({
      ts: now.toISOString(),
      y2: y2q.value,
      y10: y10q.value,
      traded_at: y2q.tradedAt ?? y10q.tradedAt,
    });
    if (ins.error) {
      return NextResponse.json(
        { ok: false, reason: `샘플 저장 실패: ${ins.error.message} (supabase/migrations/018_rate_alert.sql 적용 확인)` },
        { status: 500 },
      );
    }

    // 2) 최근 25시간 샘플 로드 (레벨 돌파의 '직전 샘플' 24h 창 + 여유)
    const since = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
    const { data: rows } = await admin
      .from("rate_samples")
      .select("ts, y2, y10")
      .gte("ts", since)
      .order("ts", { ascending: true });
    const samples: RateSample[] = (rows ?? []).map((r) => ({
      ts: Date.parse(r.ts as string),
      y2: r.y2 as number | null,
      y10: r.y10 as number | null,
    }));

    // 3) 판정 → 발송 (알림 키별 1일 1회는 dispatch가 보장)
    const cfg = rateAlertConfig();
    const hits = evaluateRateAlerts(samples, cfg);
    const date = kstDate(now);
    let sent = 0;
    for (const hit of hits) {
      sent += await dispatchToChannels(
        "rate",
        date,
        { key: hit.key, severity: hit.severity, text: hit.text, smsSubject: hit.smsSubject, suppressSms: hit.suppressSms },
        hit.emailSubject,
        hit.snapshot,
      );
    }

    // 4) 7일 지난 샘플 정리
    await admin.from("rate_samples").delete().lt("ts", new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString());

    return NextResponse.json({
      ok: true,
      y2: y2q.value,
      y10: y10q.value,
      tradedAt: y2q.tradedAt,
      samples: samples.length,
      hits: hits.map((h) => h.key),
      sent,
      cfg,
    });
  } catch (e) {
    console.error("[cron/rate-alert] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
