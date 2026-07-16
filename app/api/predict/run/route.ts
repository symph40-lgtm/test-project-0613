// GET /api/predict/run — 대가 방법론 예측 모델 실행 (docs/predict-models-spec.md 5장).
// 호출 시점 기준으로 백필·판정·채점을 알아서 처리. 인증: 로그인 세션 또는 CRON_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runPredictService } from "@/lib/predict/service";

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
    const result = await runPredictService();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "predict run 실패" }, { status: 500 });
  }
}
