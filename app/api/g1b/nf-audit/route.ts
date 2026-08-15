// GET /api/g1b/nf-audit — 야간선물 정본 대사 테스트 (발주자 승인 8/15 §4: "등록 통보 → 테스트 대사 1회").
// 배포 환경의 KRX_ID/KRX_PW 유효성 + KRX 로그인 + 정본 u1 조회를 실측 — 상설 진단용으로 유지.
// 인증: CRON_SECRET 또는 로그인 세션 (run 라우트와 동일 규약). 파라미터: ?date=YYYY-MM-DD (기본: 최근 라벨)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchKrxNightU1 } from "@/lib/market/krxNight";

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
  const envOk = Boolean(process.env.KRX_ID && process.env.KRX_PW);
  if (!envOk) return NextResponse.json({ env: false, verdict: "대사 불가 — KRX_ID/KRX_PW 미설정 (재배포 필요 여부 확인)" });
  const date = req.nextUrl.searchParams.get("date") ?? "2026-08-18"; // 기본: 최근 야간 세션 라벨 (금 8/14 밤)
  try {
    const r = await fetchKrxNightU1(date);
    return NextResponse.json({
      env: true, date, result: r,
      verdict: r ? "대사 무장 완료 — 로그인·정본 조회 정상" : "환경변수는 있으나 정본 미확보 (로그인 실패 또는 해당 라벨 야간 세션 없음)",
    });
  } catch (e) {
    return NextResponse.json({ env: true, date, error: e instanceof Error ? e.message : "예외" }, { status: 500 });
  }
}
