import { getBriefing } from "./actions";
import { hasTodayBookmark } from "./preclose/actions";
import { createClient } from "@/lib/supabase/server";
import { scoreHolding, type HoldingScore } from "@/lib/market/holdingScore";
import { fetchPositionQuotes } from "@/lib/market/fetch";
import { fetchBigtechAiNews, detectUrgentBigtechAlert } from "@/lib/market/urgentAlert";
import type { MarketData } from "@/lib/market/types";
import BriefingClient from "./BriefingClient";

export default async function BriefingPage() {
  const [snapshot, hasBookmark, semiQuotes, bigtechNews] = await Promise.all([
    getBriefing(),
    hasTodayBookmark(),
    fetchPositionQuotes([
      { ticker: "삼성전자", symbol: "005930.KS" },
      { ticker: "SK하이닉스", symbol: "000660.KS" },
    ]).catch(() => []),
    fetchBigtechAiNews(12).catch(() => []),
  ]);

  // AI 빅테크發 반도체 급등락 긴급 감지 — 빅테크 AI 뉴스 + 삼성·하이닉스 당일 ±3% 동시 성립 시 긴급 배너
  const urgentAlert = detectUrgentBigtechAlert({
    semis: semiQuotes.map((q) => ({ ticker: q.ticker, changePercent: q.changePercent })),
    news: bigtechNews,
    threshold: 3,
  });

  // 보유 종목별 매매 판단 — 애널리스트 6대 기준 실데이터 채점(종목마다 차등)
  let recs: HoldingScore[] = [];
  if (snapshot?.risk_score != null) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: positions } = await supabase
        .from("positions")
        .select("ticker, name, weight, is_leverage, sector, risk_level")
        .eq("user_id", user.id)
        .order("weight", { ascending: false });
      const md = snapshot.market_data as MarketData | null;
      // SOX가 stale이면 스냅샷 생성 시 fetchMarketData가 이미 SOXX/나스닥선물로 changePercent를 대체해 둠.
      const sox = md?.sox.changePercent ?? null;
      // 종목별 실시간 시세(해석된 심볼·당일 등락) — 종목마다 다른 점수를 위해
      const quotes = await fetchPositionQuotes(
        (positions ?? []).map((p) => ({ ticker: p.ticker, symbol: p.name as string | null })),
      ).catch(() => []);
      const qMap = new Map(quotes.map((q) => [q.ticker, q]));
      recs = await Promise.all(
        (positions ?? []).map((p) => {
          const q = qMap.get(p.ticker);
          return scoreHolding({
            ticker: p.ticker,
            symbol: q?.symbol ?? null,
            isLeverage: p.is_leverage,
            sector: p.sector,
            changePercent: q?.changePercent ?? null,
            marketDropPct: md?.kospi?.changePercent ?? null, // 급락일 감점·스탠스 상한용 (코스피 당일)
            composite: snapshot.risk_score!,
            soxChange: sox,
            macro: md
              ? {
                  rateChgPct: md.treasury10y.changePercent,
                  oilChgPct: md.oil.changePercent,
                  dollarChgPct: md.dollarIndex?.changePercent ?? null,
                }
              : undefined,
          });
        }),
      );
    }
  }

  return <BriefingClient snapshot={snapshot} hasBookmark={hasBookmark} recs={recs} urgentAlert={urgentAlert} />;
}
