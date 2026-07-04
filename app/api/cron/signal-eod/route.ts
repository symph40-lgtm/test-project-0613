// GET /api/cron/signal-eod — 장후 배치 (마스터 8.3 "매일 15:40").
// 당일 틱 시계열로 DC1/DC2 최종 라벨 확정 + 일간 등락·갭 기록 → signal_daily_features 확정.
// 인증: Authorization: Bearer <CRON_SECRET> 또는 ?secret= (기존 /api/cron/intraday와 동일 방식).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDailyBars, kstNow } from "@/lib/signal/data";
import { SIGNAL_CONFIG } from "@/lib/signal/config";
import { loadTicks } from "@/lib/signal/store";
import { gapPct } from "@/lib/signal/engine/daily";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.nextUrl.searchParams.get("secret");
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const dateParam = req.nextUrl.searchParams.get("date");
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : kstNow().date;

    const [ticks, hynixDaily] = await Promise.all([
      loadTicks(date),
      fetchDailyBars(SIGNAL_CONFIG.symbols.hynix, 5),
    ]);

    // ── 최종 DC1/DC2 (10분봉, 선물 기준 — 틱이 없으면 라벨 미확정)
    const S = SIGNAL_CONFIG.session;
    const pts = ticks
      .filter((t) => t.futPx !== null && t.minuteOfDay >= S.openMin && t.minuteOfDay <= S.endMin)
      .map((t) => ({ min: t.minuteOfDay, px: t.futPx as number }));

    let dc1: number | null = null, dc2: number | null = null;
    if (pts.length >= 10) {
      const barMin = SIGNAL_CONFIG.dc.barMin;
      const bars = new Map<number, { open: number; close: number }>();
      for (const p of pts) {
        const b = Math.floor((p.min - S.openMin) / barMin);
        const cur = bars.get(b);
        if (!cur) bars.set(b, { open: p.px, close: p.px });
        else cur.close = p.px;
      }
      const arr = [...bars.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      const dayOpen = pts[0].px, dayClose = pts[pts.length - 1].px;
      const daySign = Math.sign(dayClose - dayOpen);
      if (daySign !== 0 && arr.length >= 3) {
        dc1 = arr.filter((b) => Math.sign(b.close - b.open) === daySign).length / arr.length;
        const path = arr.reduce((s, b) => s + Math.abs(b.close - b.open), 0);
        dc2 = path > 0 ? Math.abs(dayClose - dayOpen) / path : null;
      }
    }

    // ── 일간 라벨 (하닉 일봉 확정치)
    const today = hynixDaily.find((b) => b.date === date);
    const dayReturn = today ? ((today.close - today.open) / today.open) * 100 : null;
    const gap = today ? gapPct(hynixDaily) : null;
    const range = today ? ((today.high - today.low) / today.open) * 100 : null;

    // 3클래스 라벨 (2.5.6): DC1 ≥ θ AND DC2 ≥ 기준 동시 충족 + 방향
    let dayLabel: string | null = null;
    if (dc1 !== null && dc2 !== null) {
      const trendDay = dc1 >= SIGNAL_CONFIG.dc.dc1Theta && dc2 >= SIGNAL_CONFIG.dc.dc2Min;
      const dir = pts[pts.length - 1].px > pts[0].px ? "상방추세일" : "하방추세일";
      dayLabel = trendDay ? dir : "비추세일";
    }

    const admin = createAdminClient();
    const { error } = await admin.from("signal_daily_features").upsert(
      {
        date,
        dc1, dc2,
        day_return: dayReturn,
        gap,
        intraday_range: range,
        day_label: dayLabel,
      },
      { onConflict: "date" },
    );

    return NextResponse.json({
      ok: !error,
      date,
      label: { dc1, dc2, dayLabel, dayReturn, gap },
      tickCount: ticks.length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "internal error" }, { status: 500 });
  }
}
