// GET /api/signal/us/state — 미국 반도체 신호 (USD/SSG) 현재 상태.
// 흐름: 시세 1틱 수집 → 미국 정규장(09:30~16:00 ET)이면 us_signal_ticks 적재(30초 가드) →
// 축적 시계열로 판정 → 판정·급변 문자 발송 → 상태 반환.
// 인증 2경로: ①로그인 세션 (/signal/us 페이지) ②CRON_SECRET — cron-job.org가 한국 야간
// (22:30~05:00 KST, 서머타임 기준. 겨울 23:30~06:00)에 1분마다 호출하면 무인 수집·발송된다.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { collectUsTick, appendUsTick, loadUsTicks, fetchSmhDaily, etNow, toVirtualMin } from "@/lib/signal/us/data";
import { decideUs, buildUsSignalAlert, buildUsMoveAlerts } from "@/lib/signal/us/engine";
import { maybeSendUsReversalAlert, maybeSendUsTrendCancel } from "@/lib/signal/us/alerts";
import { runUsPredictStream } from "@/lib/signal/us/predictStream";
import { runUsDailyService } from "@/lib/signal/us/daily";
import { US_SIGNAL_CONFIG } from "@/lib/signal/us/config";

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
    const { date, minuteOfDay, iso } = etNow();
    const S = US_SIGNAL_CONFIG.session;
    const etDow = new Date(`${date}T12:00:00Z`).getUTCDay(); // ET 거래일의 요일
    const isWeekday = etDow >= 1 && etDow <= 5;
    const inSession = minuteOfDay >= S.openEt && minuteOfDay <= S.closeEt + 5;

    // 미장 예측 스트림 (사용자 지정 2026-07-21 2차: 국장과 동일 구조 — 프리장 user·정규장 피셔)
    // + 채점 백필. 실패해도 신호 흐름 무관. 라이브 판정 08:31~14:33 ET (KST 21:31~03:33 서머타임)
    // — 크론 시작을 20:55 KST로 당기면 프리장 체크포인트(21:30~)부터 실시간 커버.
    const predict = isWeekday ? await runUsPredictStream().catch(() => null) : null;

    // 미장 일봉 스윙 (사용자 지시 2026-07-23) — 마감 판정(16:05~ ET)·애프터장 마감 지침 문자
    // (19:55~20:15 ET = 08:55~09:15 KST 여름). 창 밖이면 함수가 즉시 반환. ⚠크론 KST 9~10시 필요.
    const daily = isWeekday ? await runUsDailyService().catch(() => null) : null;

    const tick = await collectUsTick();
    let stored = false;
    if (inSession && isWeekday) stored = await appendUsTick(tick).catch(() => false);

    const rows = await loadUsTicks(date).catch(() => [] as Awaited<ReturnType<typeof loadUsTicks>>);
    if (rows.length === 0 || rows[rows.length - 1].ts !== tick.ts) rows.push(tick);

    const smhDaily = await fetchSmhDaily(15);
    const nowVirtual = toVirtualMin(minuteOfDay);
    const judgment = decideUs(rows, smhDaily, nowVirtual, iso, date);

    // 지속 확인용 — confirmPersistMin분 전 시점 판정 (한 틱 확정/해제 채터링 방지, 2026-07-13)
    const persistCut = nowVirtual - US_SIGNAL_CONFIG.confirmPersistMin;
    const prevRows = rows.filter((r) => r.minute_of_day <= persistCut);
    const prevJudgment = prevRows.length >= 5 ? decideUs(prevRows, smhDaily, persistCut, iso, date) : null;

    // 문자 — 판정 확정(1일 1회) + SMH 급변·스윙 (에피소드별 1일 1회는 dispatch가 보장).
    // 조용 시간(01:00~07:00 KST)엔 문자만 억제하고 이메일은 발송 — 수집·판정은 계속 (사용자 지정)
    const kst = new Date(Date.now() + 9 * 3600e3);
    const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const Q = US_SIGNAL_CONFIG.quietSms;
    const quiet = kstMin >= Q.fromKstMin && kstMin < Q.toKstMin;
    let sent = 0;
    if (isWeekday && inSession) {
      // 확정 문자는 N분 전 판정도 같은 방향 추세일일 때만 (지속 확인 — 실측 23:05 채터링 수정)
      const sig = buildUsSignalAlert(judgment);
      const persisted =
        prevJudgment !== null && prevJudgment.dayType === judgment.dayType && prevJudgment.trend?.grade === "추세일";
      if (sig && persisted) sent += await dispatchToChannels("signal", date, { ...sig, suppressSms: quiet }, undefined, { us: true, dayType: judgment.dayType, ts: iso }).catch(() => 0);
      // 확정 후 추세 훼손 시 해제 문자 (1일 1회)
      sent += await maybeSendUsTrendCancel(judgment, prevJudgment, quiet).catch(() => 0);
      for (const alert of buildUsMoveAlerts(rows)) {
        sent += await dispatchToChannels("signal", date, { ...alert, suppressSms: quiet }, `미국 급변 — ${alert.text.slice(10, 40)}`).catch(() => 0);
      }
      // RV1 미국판 — SMH 분봉 모멘텀 즉시 신호 (반복·쿨다운·추가 진행은 함수 내부에서)
      sent += await maybeSendUsReversalAlert(judgment, quiet).catch(() => 0);
    }

    return NextResponse.json({ judgment, predict, daily, tickCount: rows.length, stored, sent });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "internal error" }, { status: 500 });
  }
}
