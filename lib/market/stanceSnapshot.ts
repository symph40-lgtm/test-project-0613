// EOD 스탠스 스냅샷 — 보유 매매 판단(holdingScore)의 "판정 vs 실제" 자동 대조 루프 (2026-07-13
// 사용자 지정: 오판이 반복되는 요인을 수치로 찾아 기준값을 점차 조정하기 위한 데이터 축적).
// 매일 15:40 signal-eod 크론이 호출: ①오늘 스탠스 저장 ②직전 거래일 스냅샷에 오늘 수익률 백필.
// AI 의견(aiBias)은 제외하고 저장 — 재현 가능한 규칙 점수만 캘리브레이션 대상으로 삼는다.
// 마이그레이션 021 미적용이면 저장을 건너뛰고 note로 알린다 (크론 본 작업은 계속).

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchMarketData, fetchPositionQuotes } from "./fetch";
import { calculateRiskScores, calculateCompositeScore, intradayDropRisk } from "./risk";
import { fetchKospi200Futures } from "./naver-flow";
import { scoreHolding } from "./holdingScore";

export async function snapshotStances(date: string): Promise<{ saved: number; backfilled: number; note: string | null }> {
  const admin = createAdminClient();
  const { data: positions } = await admin
    .from("positions")
    .select("user_id, ticker, name, weight, is_leverage, sector");
  if (!positions || positions.length === 0) return { saved: 0, backfilled: 0, note: "보유 종목 없음" };

  const uniq = new Map(positions.map((p) => [p.ticker as string, { ticker: p.ticker as string, symbol: p.name as string | null }]));
  const [market, quotes, kospiFut] = await Promise.all([
    fetchMarketData(),
    fetchPositionQuotes([...uniq.values()]).catch(() => []),
    fetchKospi200Futures().catch(() => null),
  ]);
  const qMap = new Map(quotes.map((q) => [q.ticker, q]));
  const baseComposite = calculateCompositeScore(calculateRiskScores(market));

  // 사용자별 보유 가중 평균 등락 → composite 오버레이·marketDrop (intraday 페이지와 동일 산식)
  const byUser = new Map<string, typeof positions>();
  for (const p of positions) {
    const arr = byUser.get(p.user_id) ?? [];
    arr.push(p);
    byUser.set(p.user_id, arr);
  }

  let saved = 0;
  let note: string | null = null;
  for (const [userId, ps] of byUser) {
    const hw = ps.map((p) => ({ w: Number(p.weight), c: qMap.get(p.ticker)?.changePercent ?? null }))
      .filter((h): h is { w: number; c: number } => typeof h.c === "number");
    const wSum = hw.reduce((a, h) => a + h.w, 0);
    const holdingsAvg = hw.length > 0 && wSum > 0 ? hw.reduce((a, h) => a + h.c * h.w, 0) / wSum : null;
    const dropRisk = intradayDropRisk({
      kospi: market.kospi.changePercent,
      kospiFut: kospiFut && !kospiFut.stale ? kospiFut.changePercent : null,
      nasdaqFut: market.nasdaq.stale ? null : market.nasdaq.changePercent,
      holdingsAvg,
    });
    const composite = Math.max(0, Math.min(100, baseComposite + dropRisk));
    const marketDrop = Math.min(
      ...[
        market.kospi.changePercent,
        kospiFut && !kospiFut.stale ? kospiFut.changePercent : null,
        market.nasdaq.stale ? null : market.nasdaq.changePercent,
        holdingsAvg,
      ].filter((v): v is number => typeof v === "number"),
      0,
    );

    const recs = await Promise.all(
      ps.map(async (p) => {
        const q = qMap.get(p.ticker);
        const r = await scoreHolding({
          ticker: p.ticker,
          symbol: q?.symbol ?? null,
          isLeverage: Boolean(p.is_leverage),
          sector: p.sector as string | null,
          changePercent: q?.changePercent ?? null,
          marketDropPct: marketDrop,
          composite,
          soxChange: market.sox.changePercent,
          macro: {
            rateChgPct: market.treasury10y.changePercent,
            oilChgPct: market.oil.changePercent,
            dollarChgPct: market.dollarIndex.changePercent,
          },
        });
        return { p, q, r };
      }),
    );

    const rows = recs.map(({ p, q, r }) => ({
      date,
      user_id: userId,
      ticker: p.ticker,
      stance: r.stance,
      score: r.score,
      tone: r.tone,
      day_change_pct: q?.changePercent ?? null,
      market_drop_pct: marketDrop,
      composite,
      reason: r.reason.slice(0, 500),
      factors: r.factors,
    }));
    const { error } = await admin.from("stance_snapshots").upsert(rows, { onConflict: "date,user_id,ticker" });
    if (error) {
      note = /stance_snapshots/.test(error.message) && /find|exist|schema/.test(error.message)
        ? "마이그레이션 021(stance_snapshots) 미적용 — 스냅샷 건너뜀"
        : `저장 오류: ${error.message.slice(0, 120)}`;
      return { saved: 0, backfilled: 0, note };
    }
    saved += rows.length;
  }

  // ── 백필: 직전 스냅샷 날짜(오늘 이전 최근 1개 거래일)의 next_day_pct에 오늘 등락을 기록.
  // 그보다 오래된 미기록 행은 채우지 않는다 — 오늘 등락은 '그 다음 날' 수익률이 아니므로.
  let backfilled = 0;
  const { data: prevDateRow } = await admin
    .from("stance_snapshots")
    .select("date")
    .lt("date", date)
    .order("date", { ascending: false })
    .limit(1);
  const prevDate = prevDateRow?.[0]?.date as string | undefined;
  if (prevDate) {
    const { data: prevRows } = await admin
      .from("stance_snapshots")
      .select("id, ticker")
      .eq("date", prevDate)
      .is("next_day_pct", null);
    for (const row of prevRows ?? []) {
      const chg = qMap.get(row.ticker)?.changePercent ?? null;
      if (chg === null) continue;
      const { error } = await admin.from("stance_snapshots").update({ next_day_pct: chg }).eq("id", row.id);
      if (!error) backfilled++;
    }
  }

  return { saved, backfilled, note };
}
