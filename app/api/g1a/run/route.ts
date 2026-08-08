// GET /api/g1a/run — G1A v0.3 저녁 갭 판정 (specs/SPEC_G1A_gap_forecast.md, log-only 60일).
// 호출 시점 기준으로 T1 스냅샷(15:05~)·T2 감시(16:30~19:55)·라벨 채점(09:05~)을 알아서 처리.
// 기존 cron-job.org 장중 크론에 이 URL 추가 필요 — 권장 스케줄: 평일 09:05~10:30·15:05~15:25·16:30~19:55, 10분 간격.
// 인증: 로그인 세션 또는 CRON_SECRET (predict-daily/run과 동일 규약).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runG1AService } from "@/lib/g1a/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.nextUrl.searchParams.get("secret");
  const isCron = Boolean(cronSecret && provided === cronSecret);
  if (!isCron) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runG1AService();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "g1a run 실패" }, { status: 500 });
  }
}
