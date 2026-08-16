// GET /api/mt/run — MT지수 일일 사이클 (specs/SPEC_MT_v04.md, 1단계 표시 전용).
// 호출 시점 기준으로 15:40~16:20 산출 / 09:05~10:30 라벨 소급을 알아서 처리한다.
// ⚠ 가동 전: cron-job.org에 이 URL 추가 필요 (권장 평일 15:40·16:00·09:10, /api/g1a/run과 동일 규약).
// 인증: 로그인 세션 또는 CRON_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runMtService } from "@/lib/mt/service";

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
    return NextResponse.json(await runMtService());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "mt run 실패" }, { status: 500 });
  }
}
