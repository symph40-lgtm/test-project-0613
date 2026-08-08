// GET /api/g1b/run — G1B 라이브 60일 log-only (WORKORDER_G1B_live_week4 / 정본 {스펙+A1}).
// 크론 권장: 평일 06:00~11:00 KST, 5분 간격. 창구별 자동 진행 (수집→R1→수집→R2→라벨·학습·계기판).
// 인증: CRON_SECRET 또는 로그인 세션 (g1a/run과 동일 규약).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runG1BService } from "@/lib/g1b/service";

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
    return NextResponse.json(await runG1BService());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "g1b run 실패" }, { status: 500 });
  }
}
