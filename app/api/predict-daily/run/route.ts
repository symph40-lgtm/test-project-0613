// GET /api/predict-daily/run — 일봉 스윙 예측 실행 (docs/predict-daily-spec.md 7장).
// 호출 시점 기준으로 백필·마감 판정(15:05~16:00)·채점을 알아서 처리. 인증: 로그인 세션 또는 CRON_SECRET.
// 기존 장중 크론(cron-job.org ~2분 간격)에 이 URL을 추가하면 됨 — 창 밖 호출은 백필·채점만 수행.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runPredictDailyService } from "@/lib/predict-daily/service";

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
    const result = await runPredictDailyService();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "predict-daily run 실패" }, { status: 500 });
  }
}
