// POST /api/signal/annotate — 정성 수동 입력 (마스터 8.1 "원인 주석" + L7·L8).
// body: { date?, cause_tag?, cause_note?, consensus_intact?, cause_non_earnings? }

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { kstNow } from "@/lib/signal/data";
import { saveAnnotation } from "@/lib/signal/store";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : kstNow().date;

    const fields: Parameters<typeof saveAnnotation>[1] = {};
    if ("cause_tag" in body) fields.cause_tag = body.cause_tag === null ? null : String(body.cause_tag).slice(0, 40);
    if ("cause_note" in body) fields.cause_note = body.cause_note === null ? null : String(body.cause_note).slice(0, 300);
    if ("consensus_intact" in body) fields.consensus_intact = typeof body.consensus_intact === "boolean" ? body.consensus_intact : null;
    if ("cause_non_earnings" in body) fields.cause_non_earnings = typeof body.cause_non_earnings === "boolean" ? body.cause_non_earnings : null;

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: "no fields" }, { status: 400 });
    }

    const ok = await saveAnnotation(date, fields);
    return NextResponse.json({ ok, date });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
