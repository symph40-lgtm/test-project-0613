import { getBriefing } from "./actions";
import { hasTodayBookmark } from "./preclose/actions";
import { createClient } from "@/lib/supabase/server";
import { recommendForHolding, type Recommendation } from "@/lib/market/recommend";
import type { MarketData } from "@/lib/market/types";
import BriefingClient from "./BriefingClient";

export default async function BriefingPage() {
  const [snapshot, hasBookmark] = await Promise.all([
    getBriefing(),
    hasTodayBookmark(),
  ]);

  // 보유 종목별 매매 판단 (매수/보유/매도 · 3단계)
  let recs: Recommendation[] = [];
  if (snapshot?.risk_score != null) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: positions } = await supabase
        .from("positions")
        .select("ticker, weight, is_leverage, sector, risk_level")
        .eq("user_id", user.id)
        .order("weight", { ascending: false });
      const md = snapshot.market_data as MarketData | null;
      // SOX는 미국 지수라 한국 낮 시간엔 지난 종가에 멈춤. 캐시된 스냅샷이라 marketTime으로 렌더 시점에 재판정.
      // stale이면 그 값으로 "반도체 강세/약세"를 단정하지 않도록 신호에서 제외(null).
      const soxTime = md?.sox.marketTime ?? null;
      const soxStale = soxTime ? Date.now() / 1000 - soxTime > 18 * 3600 : false;
      const sox = soxStale ? null : md?.sox.changePercent ?? null;
      recs = (positions ?? []).map((p) =>
        recommendForHolding(
          {
            ticker: p.ticker,
            weight: Number(p.weight),
            is_leverage: p.is_leverage,
            sector: p.sector,
            risk_level: p.risk_level as string | null,
          },
          { composite: snapshot.risk_score!, soxChange: sox },
        ),
      );
    }
  }

  return <BriefingClient snapshot={snapshot} hasBookmark={hasBookmark} recs={recs} />;
}
