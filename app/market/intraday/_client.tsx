"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, RiskBadge } from "../../_components/primitives";
import type { NewsItem } from "@/lib/news/fetch";
import type { EarningsEvent } from "@/lib/market/earnings";
import { getIntradayConsult, type IntradayConsult, getMarketExplain, type MarketExplain } from "./actions";
import { HoldingCalls } from "../../_components/HoldingCalls";
import type { Recommendation } from "@/lib/market/recommend";
import type { OffHoursQuote } from "@/lib/market/fetch";

type Sess = string | null;
type Ind = { price: number | null; changePercent: number | null; session?: Sess };
type MarketBlock = {
  nasdaq: Ind; sox: Ind; kospi: Ind; usdkrw: Ind; oil: Ind; treasury10y: Ind; vix: Ind;
  fetchedAt: string;
};
type Posture = { stance: string; aggressiveness: number; guidance: string };
type Session = { key: string; label: string; focus: string };
type BondPoint = { date: string; value: number };
type BondEtf = {
  symbol: string; name: string; price: number | null; changePercent: number | null;
  session: "프리장" | "애프터장" | null;
  history: { date: string; value: number }[];
} | null;
type Holding = {
  ticker: string; weight: number; is_leverage: boolean; sector: string | null;
  risk_level: string | null; price: number | null; changePercent: number | null; currency: string | null; session?: Sess;
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
// 주의: 단계 숫자는 "상승의 강도"가 아니라 "그 국면 안에서의 위험 수준"입니다.
// 1단계 = 가장 안정(공격적 대응 가능), 3단계 = 후기·과열(신중) → 그래서 1단계 공격성이 가장 높음.
function stageMeaning(stage: string): string {
  if (stage.startsWith("상승장"))
    return "상승에 우호적인 국면입니다. 단, 단계가 높을수록(상승장 3단계) 상승 후기·과열로 위험이 커집니다. 즉 1단계가 가장 안정적이고 공격적으로 대응할 수 있으며, 3단계는 더 신중해야 합니다. (1단계 < 3단계 = 위험↑, 공격성↓)";
  if (stage.startsWith("변동장"))
    return "방향성이 뚜렷하지 않고 흔들리는 국면입니다. 단계가 높을수록 변동성·위험이 큽니다.";
  return "하방 압력이 우세한 국면입니다. 단계가 높을수록 위험이 큽니다.";
}

type SemiCmp = { ticker: string; price: number | null; changePercent: number | null; currency: string | null; session?: Sess };

// 세션 배지
function SessionTag({ session }: { session?: Sess }) {
  if (!session) return null;
  return (
    <span className="rounded bg-guard/15 px-1.5 py-0.5 text-[11px] font-medium text-guard">
      {session}
    </span>
  );
}

export default function IntradayClient({
  market, offHours, composite, stage, posture, session, bondHistory, bondEtf, semiCompare, earnings, holdings, recs, news,
}: {
  market: MarketBlock; offHours: OffHoursQuote[]; composite: number; stage: string; posture: Posture;
  session: Session; bondHistory: BondPoint[]; bondEtf: BondEtf; semiCompare: SemiCmp[];
  earnings: EarningsEvent[]; holdings: Holding[]; recs: Recommendation[]; news: NewsItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [consult, setConsult] = useState<IntradayConsult | null>(null);
  const [consulting, setConsulting] = useState(false);
  const [explain, setExplain] = useState<MarketExplain | null>(null);
  const [explaining, setExplaining] = useState(false);

  function runExplain() {
    setExplaining(true);
    startTransition(async () => {
      try {
        setExplain(await getMarketExplain());
      } finally {
        setExplaining(false);
      }
    });
  }

  // 급변 감지 (지수 ±1.5% 또는 VIX 급등)
  const maxMove = Math.max(
    Math.abs(market.nasdaq.changePercent ?? 0),
    Math.abs(market.sox.changePercent ?? 0),
    Math.abs(market.kospi.changePercent ?? 0),
  );
  const sharpMove = maxMove >= 1.5 || (market.vix.changePercent ?? 0) > 8;

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
    { label: "나스닥100 선물", ind: market.nasdaq, digits: 2 },
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

      {/* 시황 급변 해설 */}
      <Card className={`mt-4 ${sharpMove ? "border-guard" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>
            {sharpMove ? "⚠ 시황 급변 감지 — 왜 움직였나" : "시황 해설 (왜 움직였나)"}
          </SectionLabel>
          <Button variant={sharpMove ? "primary" : "secondary"} onClick={runExplain} disabled={isPending} className="!px-4 !py-2 !text-[14px] shrink-0">
            {explaining ? "분석 중…" : explain ? "다시 해설" : "원인 해설 받기"}
          </Button>
        </div>

        {!explain && !explaining && (
          <p className="text-[14px] text-ink-48">
            {sharpMove
              ? "지수가 급하게 움직였습니다. 지표·뉴스를 종합해 원인(수급인지 매크로·이벤트인지)과 대응을 분석합니다."
              : "현재 지표·뉴스를 종합해 시황 원인과 앞으로 볼 점을 해설합니다."}
          </p>
        )}

        {explain && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${
                explain.magnitude === "급변" ? "bg-ink text-white" : "bg-ink/10 text-ink-80"
              }`}>{explain.magnitude}</span>
              <span className="rounded-full bg-guard/15 px-2.5 py-0.5 text-[13px] font-medium text-guard">
                {explain.nature}
              </span>
              <span className="text-[13px] text-ink-48">{explain.moves}</span>
            </div>

            <div>
              <p className="text-[13px] font-semibold text-ink-48">원인 추정</p>
              <p className="text-[15px] leading-snug text-ink-80">{explain.driver}</p>
              {explain.natureReason && (
                <p className="mt-0.5 text-[13px] text-ink-48">{explain.natureReason}</p>
              )}
            </div>
            <div>
              <p className="text-[13px] font-semibold text-ink-48">앞으로 볼 것</p>
              <p className="text-[15px] leading-snug text-ink-80">{explain.whatNext}</p>
            </div>
            <div>
              <p className="text-[13px] font-semibold text-ink-48">대응</p>
              <p className="text-[15px] leading-snug text-ink-80">{explain.action}</p>
            </div>

            {explain.headlines.length > 0 && (
              <div>
                <p className="text-[13px] font-semibold text-ink-48">근거 뉴스</p>
                <ul className="mt-1 space-y-1">
                  {explain.headlines.slice(0, 4).map((h, i) => (
                    <li key={i}>
                      <a href={h.link} target="_blank" rel="noopener noreferrer" className="text-[13px] text-ink-80 hover:text-guard hover:underline">
                        · {h.title} <span className="text-ink-48">({h.source})</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[12px] text-ink-48">
              {explain.isFallback ? "AI 미사용 — 신호 기반 추정. " : ""}추정 해설이며 투자 권유가 아닙니다.
            </p>
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
                <SessionTag session={ind.session} />
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

      {/* 선물 · 시간외 지수 (프리장/애프터장 대용) */}
      {offHours.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>나스닥 선물 · 시간외 지수</SectionLabel>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {offHours.map((o) =>
              o.kind === "ETF" ? (
                <div key={o.label} className="border-b border-divider pb-2 sm:col-span-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[14px] text-ink-48">
                      {o.label}
                      <span className="rounded bg-ink/10 px-1 py-0.5 text-[10px] text-ink-80">{o.kind}</span>
                    </span>
                    <span className="text-[16px] font-medium tabular-nums">{fmtNum(o.price, 2)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-5 gap-y-0.5 text-[13px]">
                    <span className="text-ink-48">전날 정규장 <Chg v={o.regularChange ?? null} /></span>
                    <span className="text-ink-48">애프터장 <Chg v={o.afterChange ?? null} /></span>
                    <span className="text-ink-48 font-medium">합계 <Chg v={o.totalChange ?? null} /></span>
                  </div>
                </div>
              ) : (
                <div key={o.label} className="flex items-baseline justify-between border-b border-divider pb-2">
                  <span className="flex items-center gap-1.5 text-[14px] text-ink-48">
                    {o.label}
                    <span className="rounded bg-ink/10 px-1 py-0.5 text-[10px] text-ink-80">{o.kind}</span>
                  </span>
                  <span className="flex items-baseline gap-2">
                    <SessionTag session={o.session} />
                    <span className="text-[16px] font-medium tabular-nums">{fmtNum(o.price, 2)}</span>
                    <span className="w-20 text-right"><Chg v={o.changePercent} /></span>
                  </span>
                </div>
              ),
            )}
          </div>
          <p className="mt-3 text-[12px] leading-snug text-ink-48">
            지수(나스닥·SOX)는 시간외 시세가 없어, 24시간 거래되는 선물과 프리/애프터장이 반영되는 ETF로 시간외 흐름을 보여줍니다.
            ETF는 <b>전날 정규장</b>·<b>애프터장</b>·<b>합계</b>(전일 종가 대비)로 나눠 표시합니다.
          </p>
        </Card>
      )}

      {/* 채권(미국채 10Y) 흐름 */}
      <BondCard
        ind={market.treasury10y}
        history={bondHistory}
        etf={bondEtf}
        signals={{
          nasdaq: market.nasdaq.changePercent,
          sox: market.sox.changePercent,
          usdkrw: market.usdkrw.changePercent,
          vixLevel: market.vix.price,
          vixChange: market.vix.changePercent,
        }}
      />

      {/* 글로벌 반도체 비교 (한국 ↔ 미국 메모리/스토리지) */}
      {semiCompare.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>글로벌 반도체 비교 (실시간)</SectionLabel>
          <div className="space-y-1">
            {semiCompare.map((s) => (
              <div key={s.ticker} className="flex items-center justify-between gap-3 border-b border-divider py-2 last:border-0">
                <span className="text-[15px] font-medium">{s.ticker}</span>
                <div className="flex items-center gap-2 text-[15px]">
                  <SessionTag session={s.session} />
                  <span className="tabular-nums text-ink-80">{fmtPrice(s.price, s.currency)}</span>
                  <span className="w-20 text-right"><Chg v={s.changePercent} /></span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] leading-snug text-ink-48">
            마이크론·씨게이트·WD는 메모리·스토리지에서 삼성전자·SK하이닉스와 직접 경쟁·동조합니다.
            이들 미국 종목의 야간 등락은 다음날 한국 반도체주 시초가에 선행 지표가 되는 경우가 많습니다.
          </p>
        </Card>
      )}

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
                <div className="flex items-center gap-2 text-[15px]">
                  <SessionTag session={h.session} />
                  <span className="tabular-nums text-ink-80">{fmtPrice(h.price, h.currency)}</span>
                  <span className="w-20 text-right"><Chg v={h.changePercent} /></span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-ink-48">한국 종목: 네이버 실시간(시간외 단일가 자동 반영) · 미국 종목: 프리/애프터장 반영(Yahoo).</p>
        </Card>
      )}

      {/* 보유 종목별 매매 판단 (매수/보유/매도 · 3단계) */}
      {recs.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>보유 종목 매매 판단 (매수·보유·매도 · 3단계)</SectionLabel>
          <HoldingCalls recs={recs} />
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

type BondSignals = {
  nasdaq: number | null;
  sox: number | null;
  usdkrw: number | null;
  vixLevel: number | null;
  vixChange: number | null;
};

// 채권 가격 추세 + 동반 신호로 반도체 영향 국면 분류
function classifyBondRegime(
  priceTrend: "상승" | "하락" | "보합",
  s: BondSignals,
): { verdict: "긍정" | "주의" | "부정" | "중립"; headline: string; detail: string; action: string } {
  const equityUp = (s.nasdaq ?? 0) > 0 && (s.sox ?? 0) > 0;
  const equityDown = (s.nasdaq ?? 0) < 0 && (s.sox ?? 0) < 0;
  const wonWeak = (s.usdkrw ?? 0) > 0.3; // 원화 약세(달러 강세) = 한국 반도체 부담
  // 변동성 '급등'으로 판단 — VXN은 절대수준이 25~30으로 높아 변화율(vixChange)로만 본다
  const fearSpike = (s.vixChange ?? 0) > 8;

  if (priceTrend === "상승") {
    // 채권 가격 상승 = 금리 하락. 증시 실제 방향을 먼저 보고 판단 (변동성은 보조 신호)
    if (equityUp) {
      return {
        verdict: "긍정",
        headline: "금리 하락형 채권 강세 — 반도체에 우호적",
        detail:
          "채권 가격 상승(금리 하락)에 나스닥·반도체가 동반 상승합니다. 할인율 하락이 성장주·반도체 밸류에이션 부담을 덜어주는 '좋은 금리 하락' 국면입니다." +
          (wonWeak ? " 다만 원화 약세는 외국인 수급에 부담일 수 있습니다." : " 원/달러도 안정적이라 외국인 수급에 우호적입니다.") +
          (fearSpike ? " 단, 변동성(VXN)이 급등 중이라 변동에 유의하세요." : ""),
        action: "마이크론·삼성전자·SK하이닉스 등 비중 확대를 검토할 수 있는 구간. 단 분할 접근 권장.",
      };
    }
    if (equityDown) {
      return {
        verdict: "부정",
        headline: "위험회피형 채권 강세 — 반도체에 부정적 신호",
        detail:
          "채권 가격이 오르는데 나스닥·반도체가 동반 약세입니다. 금리 하락이 '경기 둔화·안전자산 도피' 때문일 가능성이 큽니다. 이런 국면에서는 반도체주에 부정적입니다." +
          (fearSpike ? " 변동성(VXN)도 급등 중입니다." : ""),
        action: "추격 매수보다 관망·비중 축소 검토. 반등해도 추세 전환 확인 후 대응이 안전합니다.",
      };
    }
    // 나스닥·SOX가 한 방향이 아님(엇갈림) — '동반 약세'로 단정하지 않는다
    return {
      verdict: fearSpike ? "주의" : "중립",
      headline: "채권 강세(금리 하락) — 증시 방향 혼조",
      detail:
        "금리 하락 자체는 반도체에 우호적이나, 나스닥과 반도체(SOX)가 같은 방향이 아닙니다(엇갈림). 동반 상승으로 정렬되는지 확인이 필요합니다." +
        (fearSpike ? " 변동성(VXN)이 급등 중이라 단기 흔들림에 주의하세요." : ""),
      action: "나스닥·SOX 동반 상승 확인 시 매수, 동반 하락 시 관망.",
    };
  }

  if (priceTrend === "하락") {
    // 채권 가격 하락 = 금리 상승
    if (equityDown || wonWeak) {
      return {
        verdict: "부정",
        headline: "금리 상승 부담 — 반도체에 부정적",
        detail:
          "채권 가격 하락(금리 상승)에 증시도 약하거나 원화가 약세입니다. 할인율·차입비용 상승으로 기술주·반도체·레버리지에 부담이 큰 국면입니다.",
        action: "레버리지·고비중 종목 축소 검토. 금리 진정 신호 전까지 신규 진입 보류.",
      };
    }
    if (equityUp) {
      return {
        verdict: "주의",
        headline: "금리 상승에도 위험선호 — 견조하나 주의",
        detail:
          "금리가 오르는데도 나스닥·반도체가 버티고 있습니다. 실적·업황 기대가 금리 부담을 상쇄하는 국면이나, 금리가 더 오르면 변동성이 커질 수 있습니다.",
        action: "보유는 유지 가능하나 신규 비중 확대는 신중히. 금리 추가 상승 여부 모니터링.",
      };
    }
    return {
      verdict: "주의",
      headline: "금리 상승 — 부담 누적 주의",
      detail: "채권 가격 하락(금리 상승)이 진행 중입니다. 증시 방향이 불확실해 반도체 변동성에 유의해야 합니다.",
      action: "추격 매수 자제, 금리·환율 안정 확인 후 대응.",
    };
  }

  return {
    verdict: "중립",
    headline: "채권 가격 보합 — 뚜렷한 신호 없음",
    detail: "채권 가격 변동이 크지 않아 금리발 방향성은 제한적입니다. 나스닥·SOX·환율 등 다른 신호를 우선 참고하세요.",
    action: "채권보다 증시·환율·업황 신호 중심으로 판단.",
  };
}

function BondCard({
  ind, history, etf, signals,
}: {
  ind: Ind; history: BondPoint[]; etf: BondEtf; signals: BondSignals;
}) {
  const yieldChange = ind.changePercent;
  const [showTable, setShowTable] = useState(false);

  // 채권 가격 방향: 실제 TLT 가격 추세(기간 시작 vs 끝) 기준 — 차트와 일치
  let trendDir: "상승" | "하락" | "보합" | null = null;
  let trendPct: number | null = null;
  if (etf && etf.history.length >= 2) {
    const first = etf.history[0].value;
    const last = etf.history[etf.history.length - 1].value;
    trendPct = first !== 0 ? ((last - first) / first) * 100 : 0;
    trendDir = trendPct > 0.3 ? "상승" : trendPct < -0.3 ? "하락" : "보합";
  } else if (etf?.changePercent != null) {
    trendDir = etf.changePercent > 0 ? "상승" : etf.changePercent < 0 ? "하락" : "보합";
  }

  return (
    <Card className="mt-4">
      <SectionLabel>채권 동향</SectionLabel>

      {/* 채권 가격 + 금리 — 좌우 배치 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* 채권 가격 (ETF) */}
        {etf && (
          <div className="rounded-[10px] border border-hairline bg-pearl p-3">
            <p className="text-[12px] text-ink-48">채권 가격 · {etf.name}</p>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[20px] font-semibold tabular-nums">
                {etf.price !== null ? `$${etf.price.toFixed(2)}` : "—"}
              </span>
              <span className="text-[13px]"><Chg v={etf.changePercent} /></span>
              {etf.session && (
                <span className="rounded-full bg-ink/10 px-1.5 py-0.5 text-[11px] text-ink-80">{etf.session}</span>
              )}
            </div>
            {etf.history.length >= 2 && <PriceSparkline points={etf.history} unit="$" />}
          </div>
        )}

        {/* 금리 */}
        <div className="rounded-[10px] border border-hairline bg-pearl p-3">
          <p className="text-[12px] text-ink-48">금리 · 미국채 10년물</p>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-[20px] font-semibold tabular-nums">
              {ind.price !== null ? `${ind.price.toFixed(2)}%` : "—"}
            </span>
            <span className="text-[13px]"><Chg v={yieldChange} /></span>
          </div>
          {history.length >= 2 && <BondSparkline points={history} />}
        </div>
      </div>

      {/* 표로 보기 토글 — 그래프 대신 날짜별 수치 표 */}
      {(history.length > 0 || (etf && etf.history.length > 0)) && (
        <div className="mt-3">
          <button
            onClick={() => setShowTable((v) => !v)}
            className="flex items-center gap-1 text-[13px] text-guard"
          >
            {showTable ? "표 접기 ▲" : "금리·채권가 표로 보기 ▼"}
          </button>
          {showTable && (() => {
            const rateMap = new Map(history.map((p) => [p.date, p.value]));
            const etfMap = new Map((etf?.history ?? []).map((p) => [p.date, p.value]));
            const dates = Array.from(new Set([...rateMap.keys(), ...etfMap.keys()]))
              .sort()
              .slice(-12)
              .reverse();
            return (
              <div className="mt-2 overflow-hidden rounded-[10px] border border-hairline">
                <table className="w-full text-[13px]">
                  <thead className="bg-pearl text-[12px] text-ink-48">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">날짜</th>
                      <th className="px-3 py-2 text-right font-medium">금리(10Y)</th>
                      <th className="px-3 py-2 text-right font-medium">채권가(TLT)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divider">
                    {dates.map((d) => (
                      <tr key={d}>
                        <td className="px-3 py-1.5">{d}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {rateMap.has(d) ? `${rateMap.get(d)!.toFixed(2)}%` : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {etfMap.has(d) ? `$${etfMap.get(d)!.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </div>
      )}

      {/* 추세 요약 — 실제 가격 기준 */}
      {trendDir && trendDir !== "보합" && (
        <p className="mt-3 text-[14px] text-ink-80">
          최근 {etf?.history.length ?? 0}거래일 동안{" "}
          <b className={trendDir === "상승" ? "text-red-600" : "text-blue-600"}>
            채권 가격이 {trendDir}
          </b>{" "}
          {trendPct !== null ? `(${trendPct > 0 ? "+" : ""}${trendPct.toFixed(1)}%)` : ""} 추세입니다.
          {trendDir === "상승" ? " 금리가 하락하는 흐름입니다." : " 금리가 상승하는 흐름입니다."}
        </p>
      )}

      {/* 동반 신호 */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <span className="text-ink-48">나스닥 <span className={colorOf(signals.nasdaq)}>{fmtPct(signals.nasdaq)}</span></span>
        <span className="text-ink-48">반도체SOX <span className={colorOf(signals.sox)}>{fmtPct(signals.sox)}</span></span>
        <span className="text-ink-48">달러/원 <span className={colorOf(signals.usdkrw)}>{fmtPct(signals.usdkrw)}</span></span>
        <span className="text-ink-48">VXN(나스닥 변동성) {signals.vixLevel?.toFixed(1) ?? "—"} <span className={colorOf(signals.vixChange)}>{fmtPct(signals.vixChange)}</span></span>
      </div>

      {/* 반도체 영향 국면 판단 */}
      {trendDir && (() => {
        const r = classifyBondRegime(trendDir, signals);
        const vColor =
          r.verdict === "긍정" ? "bg-red-50 text-red-600"
          : r.verdict === "부정" ? "bg-blue-50 text-blue-600"
          : "bg-ink/10 text-ink-80";
        return (
          <div className="mt-3 rounded-[10px] border border-hairline bg-pearl p-3">
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${vColor}`}>
                반도체 영향: {r.verdict}
              </span>
              <span className="text-[14px] font-semibold">{r.headline}</span>
            </div>
            <p className="mt-1.5 text-[14px] leading-snug text-ink-80">{r.detail}</p>
            <p className="mt-2 text-[14px] leading-snug">
              <span className="font-semibold text-ink-48">매매 시사점 · </span>
              {r.action}
            </p>
          </div>
        );
      })()}

      <p className="mt-2 text-[12px] text-ink-48">
        금리와 채권 가격은 반대로 움직입니다. 위 판단은 최근 가격 추세 + 동반 신호(나스닥·SOX·환율·VIX) 기준이며, 투자 권유가 아닙니다.
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
