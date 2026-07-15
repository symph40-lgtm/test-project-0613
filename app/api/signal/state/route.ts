// GET /api/signal/state — 신호 시스템 현재 상태.
// 흐름: 현재 시세 1틱 수집 → 장중이면 signal_ticks 적재(30초 가드) → 축적 시계열로 엔진 판정
// → 판정 스냅샷 로그 + daily_features 진행형 upsert → 전체 상태 반환.
// 인증 2경로: ①로그인 세션 (/signal 페이지 60초 폴링) ②CRON_SECRET (외부 크론 무인 수집 —
// PC·브라우저를 켜둘 필요 없이 cron-job.org 등이 장중 1분마다 호출하면 데이터가 쌓이고 문자도 발송됨).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { collectTick, buildPremarketContext, kstNow } from "@/lib/signal/data";
import { decide } from "@/lib/signal/engine/decide";
import { SIGNAL_CONFIG } from "@/lib/signal/config";
import { appendTick, loadTicks, logJudgment, upsertDailyFeatures, loadDailyFeatures, loadRecentFeatures } from "@/lib/signal/store";
import { maybeSendSignalSms, maybeSendMoveAlerts, maybeSendReversalAlert, maybeSendVolumeAlert, maybeSendFlowAlerts } from "@/lib/signal/alerts";
import { maybeSendEntryBrief } from "@/lib/signal/entryBrief";
import { autoAnnotateIfNeeded } from "@/lib/signal/autoAnnotate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // 인증: CRON_SECRET(무인 크론) 또는 로그인 세션
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
    const { date, minuteOfDay, iso } = kstNow();
    const S = SIGNAL_CONFIG.session;

    // AI 자동 정성 분석 (하루 1회, 사용자 입력 있으면 건너뜀) → 주석 로드 (L7·L8) → 장전 컨텍스트
    await autoAnnotateIfNeeded(date).catch(() => undefined);
    const features = await loadDailyFeatures(date).catch(() => null);
    const [ctx, tick] = await Promise.all([
      buildPremarketContext({
        consensusIntact: features?.consensus_intact ?? null,
        causeNonEarnings: features?.cause_non_earnings ?? null,
        qualSource: features?.annotation_source ?? null,
        macroSurprise: features?.macro_surprise ?? null,
        usNewsImpact: features?.us_news_impact ?? null,
        usNewsNote: features?.us_news_note ?? null,
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

    // 기록 + 신호 SMS (실패해도 응답은 반환. SMS는 판정 구간에 행동 가능 판정 확정 시 1일 1회)
    let sms: { sent: number; skipped: string | null } | null = null;
    if (isWeekday) {
      const [, , smsResult] = await Promise.all([
        logJudgment(judgment).catch(() => undefined),
        upsertDailyFeatures(judgment).catch(() => undefined),
        maybeSendSignalSms(judgment, ticks).catch((): { sent: number; skipped: string | null } => ({ sent: 0, skipped: "발송 오류" })),
        // 장중 급변 알림 — 절대 단계(하닉·삼전 ±3/5/7/10%, 선물 ±0.7% 등간격) +
        // 반전 스윙(당일 고점 대비 반락·저점 대비 반등 0.7%p 등간격, 단계별 1일 1회)
        maybeSendMoveAlerts(date, ticks).catch(() => 0),
        // RV1 하닉 분봉 반전 진입신호 — 상승=레버리지·하락=인버스, 즉시 문자
        // (반복 2·3차는 직전 발송 대비 추가 진행 시에만 — ticks로 현재 레벨 전달)
        maybeSendReversalAlert(judgment, ticks).catch(() => 0),
        // 거래량 급증 — 하닉 5분봉이 당일 평균 1.3배 이상 (30분 창 최대 2건)
        maybeSendVolumeAlert(date, ticks).catch(() => 0),
        // 외인·프로그램 수급 반전 — 극값 대비 스텝 이상 되돌림 (매수기회/매도기회 관찰)
        maybeSendFlowAlerts(date, ticks).catch(() => 0),
        // 장중 진입 브리핑 — 개장+1·3·5·10·15·20·30·50분 고정 + 이후 전환·감속·정기 1시간 (2026-07-10)
        maybeSendEntryBrief(judgment, ticks).catch(() => 0),
      ]);
      sms = smsResult;
    }

    const recent = await loadRecentFeatures(15).catch(() => []);

    return NextResponse.json({
      judgment,
      sms,
      tickCount: ticks.length,
      annotation: features
        ? {
            cause_tag: features.cause_tag,
            cause_note: features.cause_note,
            consensus_intact: features.consensus_intact,
            cause_non_earnings: features.cause_non_earnings,
            source: features.annotation_source,
          }
        : null,
      recentFeatures: recent,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "internal error" }, { status: 500 });
  }
}
