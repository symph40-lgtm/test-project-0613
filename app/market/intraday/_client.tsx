"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, RiskBadge } from "../../_components/primitives";
import type { NewsItem } from "@/lib/news/fetch";
import type { EarningsEvent } from "@/lib/market/earnings";
import { getIntradayConsult, type IntradayConsult } from "./actions";

type Ind = { price: number | null; changePercent: number | null };
type MarketBlock = {
  nasdaq: Ind; sox: Ind; kospi: Ind; usdkrw: Ind; oil: Ind; treasury10y: Ind;
  fetchedAt: string;
};
type Posture = { stance: string; aggressiveness: number; guidance: string };
type Session = { key: string; label: string; focus: string };
type BondPoint = { date: string; value: number };
type BondEtf = {
  symbol: string; name: string; price: number | null; changePercent: number | null;
  history: { date: string; value: number }[];
} | null;
type Holding = {
  ticker: string; weight: number; is_leverage: boolean; sector: string | null;
  risk_level: string | null; price: number | null; changePercent: number | null; currency: string | null;
};

// 한국식 색상: 상승=빨강, 하락=파랑
function colorOf(v: number | null): string {
  if (v === null || v === 0) return "text-ink-48";
  return v > 0 ? "text-red-600" : "text-blue-600";
}
function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function fmtNum(v: number | null, digits = 2): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPrice(v: number | null, currency: string | null): string {
  if (v === null) return "—";
  return currency === "KRW" ? `${Math.round(v).toLocaleString("ko-KR")}원` : `$${v.toFixed(2)}`;
}

function Chg({ v }: { v: number | null }) {
  if (v === null) return <span className="text-ink-48">—</span>;
  const up = v > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 tabular-nums ${colorOf(v)}`}>
      {up ? <TrendingUp size={13} /> : v < 0 ? <TrendingDown size={13} /> : null}
      {fmtPct(v)}
    </span>
  );
}

// 매매 액션 배지 색 (한국식: 매수=빨강, 매도=파랑)
function callStyle(action: string): string {
  if (action.includes("매수")) return "bg-red-50 text-red-600";
  if (action.includes("매도") || action.includes("축소")) return "bg-blue-50 text-blue-600";
  return "bg-ink/10 text-ink-80";
}

// 장세 단계 풀이
function stageMeaning(stage: string): string {
  if (stage.startsWith("상승장"))
    return "전반적으로 위험이 낮고 상승에 우호적인 국면입니다. 숫자가 낮은 단계일수록 더 안정적입니다.";
  if (stage.startsWith("변동장"))
    return "방향성이 뚜렷하지 않고 위아래로 흔들리는 국면입니다. 단계가 높을수록 변동성이 큽니다.";
  return "하방 압력이 우세한 국면입니다. 단계가 높을수록 위험이 큽니다.";
}

export default function IntradayClient({
  market, composite, stage, posture, session, bondHistory, bondEtf, earnings, holdings, news,
}: {
  market: MarketBlock; composite: number; stage: string; posture: Posture;
  session: Session; bondHistory: BondPoint[]; bondEtf: BondEtf; earnings: EarningsEvent[];
  holdings: Holding[]; news: NewsItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [consult, setConsult] = useState<IntradayConsult | null>(null);
  const [consulting, setConsulting] = useState(false);

  function runConsult() {
    setConsulting(true);
    startTransition(async () => {
      try {
        const r = await getIntradayConsult();
        setConsult(r);
      } finally {
        setConsulting(false);
      }
    });
  }

  const fetchedTime = new Date(market.fetchedAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit",
  });

  function refresh() {
    setRefreshing(true);
    startTransition(() => {
      router.refresh();
      setTimeout(() => setRefreshing(false), 1200);
    });
  }

  const watchTickers = holdings
    .filter((h) => h.risk_level === "주의" || h.risk_level === "취약")
    .map((h) => h.ticker);

  const indicators: { label: string; ind: Ind; unit?: string; digits?: number }[] = [
    { label: "나스닥100", ind: market.nasdaq, digits: 2 },
    { label: "반도체(SOX)", ind: market.sox, digits: 2 },
    { label: "코스피", ind: market.kospi, digits: 2 },
    { label: "달러/원", ind: market.usdkrw, unit: "원", digits: 1 },
    { label: "WTI 유가", ind: market.oil, unit: "$", digits: 2 },
    { label: "미국채 10Y 금리", ind: market.treasury10y, unit: "%", digits: 2 },
  ];

  return (
    <PageShell title="장중 시황 요약" width="default">
      {/* 헤더 + 새로고침 */}
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[21px] font-semibold tracking-[0.231px]">
              {fetchedTime} 기준 실시간 시황
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-48">
              {session.label}
            </p>
          </div>
          <Button variant="secondary" onClick={refresh} disabled={isPending} className="!px-4 !py-2 !text-[14px] shrink-0">
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "갱신 중…" : "실시간 새로고침"}
          </Button>
        </div>

        {/* 장세 단계 + 풀이 */}
        <div className="mt-4 rounded-[12px] border border-hairline bg-pearl p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[18px] font-semibold">{stage}</span>
            <span className="rounded-full bg-guard/15 px-2.5 py-0.5 text-[13px] font-medium text-guard">
              권장 자세: {posture.stance} · 공격성 {posture.aggressiveness}/100
            </span>
            <span className="text-[13px] text-ink-48">종합 리스크 {composite}/100</span>
          </div>
          <p className="mt-2 text-[14px] leading-snug text-ink-80">{stageMeaning(stage)}</p>
          <p className="mt-1 text-[14px] leading-snug text-ink-80">{posture.guidance}</p>
        </div>

        {watchTickers.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <RiskBadge level="주의" />
            <span className="text-[14px] text-ink-80">주의 종목: {watchTickers.join(" · ")}</span>
          </div>
        )}
      </Card>

      {/* 세션별 컨설팅 */}
      <Card className="mt-4">
        <SectionLabel>지금 ({session.label}) 무엇을 봐야 하나</SectionLabel>
        <p className="text-[15px] leading-relaxed text-ink-80">{session.focus}</p>
      </Card>

      {/* AI 매매 컨설팅 (클릭 시 그 시점 데이터로 종목별 판단 생성) */}
      <Card className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>AI 매매 컨설팅</SectionLabel>
          <Button variant="primary" onClick={runConsult} disabled={isPending} className="!px-4 !py-2 !text-[14px]">
            {consulting ? "분석 중…" : consult ? "다시 분석" : "지금 컨설팅 받기"}
          </Button>
        </div>

        {!consult && !consulting && (
          <p className="text-[14px] text-ink-48">
            현재 세션·장세·보유 종목을 종합해 종목별 매수/매도/유지 판단을 생성합니다.
          </p>
        )}

        {consult && (
          <div className="mt-1">
            <div className="rounded-[10px] border border-hairline bg-pearl p-3">
              <p className="text-[15px] leading-snug">{consult.overall}</p>
              <p className="mt-1.5 text-[12px] text-ink-48">
                {consult.session} · {consult.stage} ·{" "}
                {new Date(consult.generatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 생성
                {consult.isFallback ? " · AI 비활성(기본 판단)" : ""}
              </p>
            </div>

            {consult.calls.length > 0 && (
              <ul className="mt-3 divide-y divide-divider">
                {consult.calls.map((c) => (
                  <li key={c.ticker} className="py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[15px] font-medium">{c.ticker}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-medium ${callStyle(c.action)}`}>
                        {c.action}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] leading-snug text-ink-80">{c.reason}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[12px] text-ink-48">
              투자 권유가 아니라 리스크 코칭입니다. 최종 판단·책임은 본인에게 있습니다.
            </p>
          </div>
        )}
      </Card>

      {/* 주요 지표 — 값 + 등락률 */}
      <Card className="mt-4">
        <SectionLabel>주요 지표</SectionLabel>
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {indicators.map(({ label, ind, unit, digits }) => (
            <div key={label} className="flex items-baseline justify-between border-b border-divider pb-2">
              <span className="text-[14px] text-ink-48">{label}</span>
              <span className="flex items-baseline gap-2">
                <span className="text-[16px] font-medium tabular-nums">
                  {unit === "$" ? "$" : ""}{fmtNum(ind.price, digits)}{unit && unit !== "$" ? unit : ""}
                </span>
                <span className="w-20 text-right"><Chg v={ind.changePercent} /></span>
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-ink-48">색상: 상승=빨강, 하락=파랑 (한국식 표기)</p>
      </Card>

      {/* 채권(미국채 10Y) 흐름 */}
      <BondCard ind={market.treasury10y} history={bondHistory} etf={bondEtf} />

      {/* 미국 반도체·AI 실적 일정 */}
      {earnings.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>미국 반도체·AI 실적 발표 일정</SectionLabel>
          <ul className="divide-y divide-divider">
            {earnings.map((e) => (
              <li key={e.symbol} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-medium">{e.name}</span>
                  <span className="text-[12px] text-ink-48">{e.symbol}</span>
                </div>
                <div className="flex items-center gap-3 text-right">
                  {e.epsForward !== null && (
                    <span className="text-[12px] text-ink-48">예상 EPS {e.epsForward.toFixed(2)}</span>
                  )}
                  <span className="text-[14px] tabular-nums">{e.dateKst} (한국시간)</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-ink-48">
            반도체·AI 대형주 실적은 한국 반도체주(삼성전자·SK하이닉스 등)에 직접 영향을 줍니다. 발표일 전후 변동성에 유의하세요.
          </p>
        </Card>
      )}

      {/* 보유 종목 시세 */}
      {holdings.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>보유 종목 시세</SectionLabel>
          <div className="space-y-1">
            {holdings.map((h) => (
              <div key={h.ticker} className="flex items-center justify-between gap-3 border-b border-divider py-2 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-medium">{h.ticker}</span>
                  {h.is_leverage && (
                    <span className="rounded bg-ink/10 px-1.5 py-0.5 text-[11px] text-ink-80">레버리지</span>
                  )}
                  <span className="text-[13px] text-ink-48">비중 {h.weight}%</span>
                </div>
                <div className="flex items-center gap-3 text-[15px]">
                  <span className="tabular-nums text-ink-80">{fmtPrice(h.price, h.currency)}</span>
                  <span className="w-20 text-right"><Chg v={h.changePercent} /></span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-ink-48">한국 종목은 약 15분 지연 시세일 수 있습니다 (Yahoo Finance).</p>
        </Card>
      )}

      {/* 관련 뉴스 */}
      {news.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>관련 뉴스</SectionLabel>
          <ul className="space-y-3">
            {news.map((n, i) => (
              <li key={i}>
                <a href={n.link} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2">
                  <ExternalLink size={14} className="mt-1 shrink-0 text-ink-48" />
                  <span>
                    <span className="text-[15px] leading-snug group-hover:text-guard group-hover:underline">{n.title}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-48">
                      {n.source}{n.pubDate ? ` · ${new Date(n.pubDate).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })}` : ""}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6">
        <Button variant="primary" size="lg" onClick={() => router.push("/briefing/preclose")}>
          종목별 매수·매도 판단 보기
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}

function BondCard({ ind, history, etf }: { ind: Ind; history: BondPoint[]; etf: BondEtf }) {
  const yieldChange = ind.changePercent;
  // 금리 하락 = 채권 가격 상승 (역의 관계)
  const bondPriceDir =
    yieldChange === null ? null : yieldChange < 0 ? "상승" : yieldChange > 0 ? "하락" : "보합";

  return (
    <Card className="mt-4">
      <SectionLabel>채권 동향</SectionLabel>

      {/* 채권 가격 (ETF) — 실제 가격 */}
      {etf && (
        <div className="mb-4 rounded-[10px] border border-hairline bg-pearl p-3">
          <p className="text-[13px] text-ink-48">{etf.name} · 채권 가격</p>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3">
            <span className="text-[22px] font-semibold tabular-nums">
              {etf.price !== null ? `$${etf.price.toFixed(2)}` : "—"}
            </span>
            <span className="text-[14px]"><Chg v={etf.changePercent} /></span>
          </div>
          {etf.history.length >= 2 && <PriceSparkline points={etf.history} unit="$" />}
        </div>
      )}

      {/* 금리 (참고) */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[14px] text-ink-48">미국채 10년물 금리</span>
        <span className="text-[16px] font-semibold tabular-nums">{ind.price !== null ? `${ind.price.toFixed(2)}%` : "—"}</span>
        <span className="text-[14px]"><Chg v={yieldChange} /></span>
      </div>
      {history.length >= 2 && <BondSparkline points={history} />}

      {bondPriceDir && (
        <p className="mt-2 text-[14px] text-ink-80">
          금리가 {bondPriceDir === "상승" ? "내려" : bondPriceDir === "하락" ? "올라" : "거의 변동 없어"}{" "}
          <b className={bondPriceDir === "상승" ? "text-red-600" : bondPriceDir === "하락" ? "text-blue-600" : ""}>
            채권 가격은 {bondPriceDir}
          </b>{" "}
          압력입니다. (금리와 채권 가격은 반대로 움직입니다)
        </p>
      )}

      <p className="mt-2 text-[12px] text-ink-48">
        채권 가격 상승(금리 하락)은 보통 위험회피·금리인하 기대 신호, 가격 하락(금리 상승)은 인플레·긴축 신호로 해석됩니다.
      </p>
    </Card>
  );
}

// 가격 추이 스파크라인 (상승=빨강/하락=파랑)
function PriceSparkline({ points, unit = "" }: { points: BondPoint[]; unit?: string }) {
  const W = 320, H = 56, P = 4;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const stepX = (W - P * 2) / (points.length - 1);
  const coords = points.map((p, i) => [P + i * stepX, P + (1 - (p.value - min) / range) * (H - P * 2)] as const);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const first = points[0].value, last = points[points.length - 1].value;
  const rising = last >= first;
  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: 56 }}>
        <polyline points={coords.map(([x, y]) => `${x},${y}`).join(" ")} fill="none"
          stroke={rising ? "#dc2626" : "#2563eb"} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={`${path} L${coords[coords.length - 1][0]},${H - P} L${coords[0][0]},${H - P} Z`}
          fill={rising ? "#dc262611" : "#2563eb11"} />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-ink-48">
        <span>{points[0].date} · {unit}{first.toFixed(2)}</span>
        <span>최근 {points.length}거래일</span>
        <span>{points[points.length - 1].date} · {unit}{last.toFixed(2)}</span>
      </div>
    </div>
  );
}

function BondSparkline({ points }: { points: BondPoint[] }) {
  const W = 320, H = 64, P = 4;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const stepX = (W - P * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = P + i * stepX;
    const y = P + (1 - (p.value - min) / range) * (H - P * 2);
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1].value;
  const first = points[0].value;
  const rising = last >= first;

  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: 64 }}>
        <polyline
          points={coords.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke={rising ? "#dc2626" : "#2563eb"}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path d={`${path} L${coords[coords.length - 1][0]},${H - P} L${coords[0][0]},${H - P} Z`} fill={rising ? "#dc262611" : "#2563eb11"} />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-ink-48">
        <span>{points[0].date} · {first.toFixed(2)}%</span>
        <span>최근 {points.length}거래일</span>
        <span>{points[points.length - 1].date} · {last.toFixed(2)}%</span>
      </div>
    </div>
  );
}
