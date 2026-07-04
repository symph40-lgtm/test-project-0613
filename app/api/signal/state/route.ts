// GET /api/signal/state — 신호 시스템 현재 상태.
// 흐름: 현재 시세 1틱 수집 → 장중이면 signal_ticks 적재(30초 가드) → 축적 시계열로 엔진 판정
// → 판정 스냅샷 로그 + daily_features 진행형 upsert → 전체 상태 반환.
// /signal 페이지가 60초 폴링. 무인 운용 시 외부 크론이 같은 주소를 호출해도 된다(CRON_SECRET 불필요 — 로그인 필요).

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { collectTick, buildPremarketContext, kstNow } from "@/lib/signal/data";
import { decide } from "@/lib/signal/engine/decide";
import { SIGNAL_CONFIG } from "@/lib/signal/config";
import { appendTick, loadTicks, logJudgment, upsertDailyFeatures, loadDailyFeatures, loadRecentFeatures } from "@/lib/signal/store";

export const dynamic = "force-dynamic";

export async function GET() {
  // 로그인 사용자만 (시장 데이터지만 무인 엔드포인트 남용 방지)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { date, minuteOfDay, iso } = kstNow();
    const S = SIGNAL_CONFIG.session;

    // 수동 주석 로드 (L7·L8) → 장전 컨텍스트
    const features = await loadDailyFeatures(date).catch(() => null);
    const [ctx, tick] = await Promise.all([
      buildPremarketContext({
        consensusIntact: features?.consensus_intact ?? null,
        causeNonEarnings: features?.cause_non_earnings ?? null,
      }),
      collectTick(),
    ]);

    // 장중(09:00~15:45)이면 틱 적재
    const inSession = minuteOfDay >= S.openMin && minuteOfDay <= S.endMin + 15;
    const isWeekday = [1, 2, 3, 4, 5].includes(new Date(Date.now() + 9 * 3600 * 1000).getUTCDay());
    if (inSession && isWeekday) {
      await appendTick(date, tick).catch(() => false);
    }

    // 축적 시계열 로드 (오늘 자) — 방금 적재분 포함
    const ticks = await loadTicks(date).catch((): Awaited<ReturnType<typeof loadTicks>> => []);
    // 적재 가드에 걸렸어도 최신 틱은 판정에 반영
    if (ticks.length === 0 || ticks[ticks.length - 1].ts !== tick.ts) ticks.push(tick);

    const judgment = decide(ctx, ticks, minuteOfDay, iso);

    // 기록 (실패해도 응답은 반환)
    if (isWeekday) {
      await Promise.all([
        logJudgment(judgment).catch(() => undefined),
        upsertDailyFeatures(judgment).catch(() => undefined),
      ]);
    }

    const recent = await loadRecentFeatures(15).catch(() => []);

    return NextResponse.json({
      judgment,
      tickCount: ticks.length,
      annotation: features
        ? {
            cause_tag: features.cause_tag,
            cause_note: features.cause_note,
            consensus_intact: features.consensus_intact,
            cause_non_earnings: features.cause_non_earnings,
          }
        : null,
      recentFeatures: recent,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "internal error" }, { status: 500 });
  }
}
