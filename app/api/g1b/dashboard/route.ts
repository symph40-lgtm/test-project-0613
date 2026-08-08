// GET /api/g1b/dashboard — 게이트 계기판 (T4). Vercel엔 파일 쓰기가 없어 gate_dashboard.md 대신
// DB 집계를 그대로 서빙한다 (발주서 §4의 형식 대체 — 근거는 WEEK4 보고 기재). ?format=md 로 마크다운.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.nextUrl.searchParams.get("secret");
  if (!(cronSecret && provided === cronSecret)) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data } = await admin.from("g1b_gate").select("*").order("date", { ascending: false }).limit(1);
  const g = data?.[0];
  if (!g) return NextResponse.json({ error: "계기판 없음 — 첫 라벨 창 이후 생성" }, { status: 404 });
  if (req.nextUrl.searchParams.get("format") === "md") {
    const m = g.metrics as Record<string, unknown>;
    const md = [
      `# G1B 게이트 계기판 (${g.date})`,
      `- 추적일: ${m.days_tracked} · 가동률: ${m.uptime_pct}% · 드라이런: ${m.dryrun}`,
      `- TE_r1 중앙값: ${m.te_r1_median_pct ?? "—"}% · 오프라인 1.5배 정합: ${m.offline_pred_x15 ?? "—"}`,
      `- late_arrival 누적: ${m.late_arrival_total}`,
    ].join("\n");
    return new NextResponse(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  return NextResponse.json(g);
}
