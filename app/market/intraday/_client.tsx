"use client";

import { useRouter } from "next/navigation";
import { ExternalLink, TrendingUp, TrendingDown } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, MetaRow, SectionLabel, RiskBadge } from "../../_components/primitives";
import type { NewsItem } from "@/lib/news/fetch";

type MarketChanges = {
  nasdaq: number | null;
  sox: number | null;
  kospi: number | null;
  usdkrw: number | null;
  oil: number | null;
  treasury10y: number | null;
  fetchedAt: string;
};

type Holding = {
  ticker: string;
  weight: number;
  is_leverage: boolean;
  sector: string | null;
  risk_level: string | null;
  price: number | null;
  changePercent: number | null;
  currency: string | null;
};

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(v: number | null, currency: string | null): string {
  if (v === null) return "—";
  const isKrw = currency === "KRW";
  return isKrw
    ? `${Math.round(v).toLocaleString("ko-KR")}원`
    : `$${v.toFixed(2)}`;
}

function ChangeText({ v }: { v: number | null }) {
  if (v === null) return <span className="text-ink-48">—</span>;
  const up = v > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 tabular-nums ${up ? "text-emerald-600" : v < 0 ? "text-rose-600" : "text-ink-48"}`}>
      {up ? <TrendingUp size={13} /> : v < 0 ? <TrendingDown size={13} /> : null}
      {fmtPct(v)}
    </span>
  );
}

export default function IntradayClient({
  market,
  composite,
  stage,
  holdings,
  news,
}: {
  market: MarketChanges;
  composite: number;
  stage: string;
  holdings: Holding[];
  news: NewsItem[];
}) {
  const router = useRouter();

  const fetchedTime = new Date(market.fetchedAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  // 주의/취약 종목 추출
  const watchTickers = holdings
    .filter((h) => h.risk_level === "주의" || h.risk_level === "취약")
    .map((h) => h.ticker);

  return (
    <PageShell title="장중 시황 요약" width="narrow">
      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[21px] font-semibold tracking-[0.231px]">
            {fetchedTime} 기준 시황
          </h2>
          <span className="text-[13px] text-ink-48">실시간 시세</span>
        </div>

        <div className="mt-4 border-t border-divider pt-3">
          <MetaRow label="시장 단계" value={stage} />
          <MetaRow label="종합 리스크 점수" value={`${composite} / 100`} />
          {watchTickers.length > 0 ? (
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[14px] text-ink-48">내 종목 주의</span>
              <span className="flex items-center gap-1.5">
                <RiskBadge level="주의" />
                <span className="text-[15px]">{watchTickers.join(" · ")}</span>
              </span>
            </div>
          ) : null}
        </div>

        {/* 주요 지수 변화 */}
        <div className="mt-4 rounded-[11px] border border-hairline bg-pearl p-4">
          <SectionLabel>주요 지표</SectionLabel>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[15px]">
            <Row label="나스닥100" v={market.nasdaq} />
            <Row label="반도체(SOX)" v={market.sox} />
            <Row label="코스피" v={market.kospi} />
            <Row label="달러/원" v={market.usdkrw} />
            <Row label="WTI 유가" v={market.oil} />
            <Row label="미국채 10Y" v={market.treasury10y} />
          </div>
        </div>
      </Card>

      {/* 보유 종목 실시간 시세 */}
      {holdings.length > 0 ? (
        <Card className="mt-5">
          <SectionLabel>보유 종목 시세</SectionLabel>
          <div className="space-y-1">
            {holdings.map((h) => (
              <div
                key={h.ticker}
                className="flex items-center justify-between gap-3 border-b border-divider py-2 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-medium">{h.ticker}</span>
                  {h.is_leverage ? (
                    <span className="rounded bg-ink/10 px-1.5 py-0.5 text-[11px] text-ink-80">
                      레버리지
                    </span>
                  ) : null}
                  <span className="text-[13px] text-ink-48">비중 {h.weight}%</span>
                </div>
                <div className="flex items-center gap-3 text-[15px]">
                  <span className="tabular-nums text-ink-80">
                    {fmtPrice(h.price, h.currency)}
                  </span>
                  <span className="w-20 text-right">
                    <ChangeText v={h.changePercent} />
                  </span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-ink-48">
            한국 종목은 약 15분 지연 시세일 수 있습니다 (Yahoo Finance).
          </p>
        </Card>
      ) : null}

      {/* 관련 뉴스 */}
      {news.length > 0 ? (
        <Card className="mt-5">
          <SectionLabel>관련 뉴스</SectionLabel>
          <ul className="space-y-3">
            {news.map((n, i) => (
              <li key={i}>
                <a
                  href={n.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-2"
                >
                  <ExternalLink size={14} className="mt-1 shrink-0 text-ink-48" />
                  <span>
                    <span className="text-[15px] leading-snug group-hover:text-guard group-hover:underline">
                      {n.title}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-ink-48">
                      {n.source}
                      {n.pubDate
                        ? ` · ${new Date(n.pubDate).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })}`
                        : ""}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mt-6">
        <Button variant="primary" size="lg" onClick={() => router.push("/briefing/preclose")}>
          자세히 보기
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}

function Row({ label, v }: { label: string; v: number | null }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-48">{label}</span>
      <ChangeText v={v} />
    </div>
  );
}
