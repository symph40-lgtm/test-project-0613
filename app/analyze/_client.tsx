"use client";

import { useState, useTransition } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Button } from "../_components/Button";
import { Card, SectionLabel } from "../_components/primitives";
import { TickerInput } from "../_components/TickerInput";
import { analyzeStock, type StockAnalysis } from "./actions";

function dirStyle(d: StockAnalysis["direction"]) {
  if (d === "단기 상승 우세") return { cls: "bg-red-50 text-red-600", Icon: TrendingUp };
  if (d === "단기 하락 우세") return { cls: "bg-blue-50 text-blue-600", Icon: TrendingDown };
  return { cls: "bg-ink/10 text-ink-80", Icon: Minus };
}

function fmtPrice(v: number | null, cur: string | null) {
  if (v === null) return "—";
  return cur === "KRW" ? `${Math.round(v).toLocaleString("ko-KR")}원` : `$${v.toFixed(2)}`;
}

function Spark({ points }: { points: { date: string; value: number }[] }) {
  if (points.length < 2) return null;
  const W = 600, H = 80, P = 4;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1;
  const step = (W - P * 2) / (points.length - 1);
  const coords = points.map((p, i) => [P + i * step, P + (1 - (p.value - min) / range) * (H - P * 2)] as const);
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" preserveAspectRatio="none" style={{ height: 80 }}>
      <polyline points={coords.map(([x, y]) => `${x},${y}`).join(" ")} fill="none"
        stroke={up ? "#dc2626" : "#2563eb"} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export default function AnalyzeClient() {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState<string | null>(null);
  const [result, setResult] = useState<StockAnalysis | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    if (!name.trim()) return;
    startTransition(async () => {
      setResult(await analyzeStock(name, symbol));
    });
  }

  const ds = result ? dirStyle(result.direction) : null;

  return (
    <div className="mt-6">
      <div className="flex flex-col gap-2 sm:flex-row">
        <TickerInput
          value={name}
          symbol={symbol}
          onChange={(n, s) => { setName(n); setSymbol(s); }}
          placeholder="종목명 검색 (예: 삼성전자, NVDA, 마이크론)"
        />
        <Button variant="primary" onClick={run} disabled={isPending || !name.trim()} className="shrink-0">
          {isPending ? "분석 중…" : "단기 분석"}
        </Button>
      </div>

      {result && result.error && (
        <Card className="mt-5">
          <p className="text-[15px] text-ink-80">{result.error}</p>
        </Card>
      )}

      {result && !result.error && ds && (
        <div className="mt-5 space-y-4">
          {/* 결론 */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[20px] font-semibold">{result.name}</h2>
                <p className="text-[13px] text-ink-48">{result.symbol}</p>
              </div>
              <div className="text-right">
                <p className="text-[20px] font-semibold tabular-nums">{fmtPrice(result.price, result.currency)}</p>
                <p className={`text-[14px] tabular-nums ${(result.changePercent ?? 0) > 0 ? "text-red-600" : (result.changePercent ?? 0) < 0 ? "text-blue-600" : "text-ink-48"}`}>
                  {result.changePercent !== null ? `${result.changePercent > 0 ? "+" : ""}${result.changePercent.toFixed(2)}%` : "—"}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[15px] font-semibold ${ds.cls}`}>
                <ds.Icon size={16} /> {result.direction}
              </span>
              <span className="text-[13px] text-ink-48">신뢰도 {result.confidence}</span>
            </div>

            <Spark points={result.history} />
            {result.summary && <p className="mt-2 text-[15px] leading-snug text-ink-80">{result.summary}</p>}
          </Card>

          {/* 근거 */}
          <Card>
            <SectionLabel>밸류에이션</SectionLabel>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-ink-80">
              <span>PER(후행) <b>{result.trailingPE?.toFixed(1) ?? "N/A"}</b></span>
              <span>PER(선행) <b>{result.forwardPE?.toFixed(1) ?? "N/A"}</b></span>
              <span>52주 위치 <b>{result.weekRangePos ?? "N/A"}%</b></span>
            </div>
            {result.valuationText && <p className="mt-2 text-[14px] leading-snug text-ink-80">{result.valuationText}</p>}
          </Card>

          <Card>
            <SectionLabel>기술적 분석</SectionLabel>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-ink-80">
              <span>이평 배열 <b>{result.aligned ?? "N/A"}</b></span>
              <span>RSI <b>{result.rsi14 ?? "N/A"}</b></span>
              <span>1개월 추세 <b className={(result.trend1m ?? 0) > 0 ? "text-red-600" : (result.trend1m ?? 0) < 0 ? "text-blue-600" : ""}>{result.trend1m ?? "N/A"}%</b></span>
              <span>20/60/200일선 <b>{result.ma20 ?? "-"} / {result.ma60 ?? "-"} / {result.ma200 ?? "-"}</b></span>
            </div>
            {result.patterns.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {result.patterns.map((p) => (
                  <span key={p} className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${
                    p.includes("골든") || p.includes("과매도") || p.includes("신고가") ? "bg-red-50 text-red-600"
                    : p.includes("데드") || p.includes("과매수") || p.includes("신저가") ? "bg-blue-50 text-blue-600"
                    : "bg-ink/10 text-ink-80"
                  }`}>{p}</span>
                ))}
              </div>
            )}
            {result.technicalText && <p className="mt-2 text-[14px] leading-snug text-ink-80">{result.technicalText}</p>}
          </Card>

          {/* 목표가 · 지지/저항 */}
          <Card>
            <SectionLabel>지지 · 저항 (목표 구간)</SectionLabel>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] text-red-600">저항선(고점)</span>
                <span className="text-[15px] tabular-nums">
                  {fmtPrice(result.resistance, result.currency)}
                  {result.upside !== null && <span className="ml-2 text-[13px] text-ink-48">상승 여력 +{result.upside}%</span>}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] text-ink-80">현재가</span>
                <span className="text-[15px] font-semibold tabular-nums">{fmtPrice(result.price, result.currency)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] text-blue-600">지지선(저점)</span>
                <span className="text-[15px] tabular-nums">
                  {fmtPrice(result.support, result.currency)}
                  {result.downside !== null && <span className="ml-2 text-[13px] text-ink-48">하락 여지 {result.downside}%</span>}
                </span>
              </div>
            </div>
            <p className="mt-2 text-[12px] text-ink-48">최근 60거래일 고점·저점 기준</p>
          </Card>

          {/* 거래량 */}
          <Card>
            <SectionLabel>거래량</SectionLabel>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-ink-80">
              <span>당일{result.volumeProjected ? "(장중 누적)" : ""} <b>{result.volume?.toLocaleString("ko-KR") ?? "N/A"}</b></span>
              {result.volumeProjected && (
                <span>종일 환산 <b>{result.projectedVolume?.toLocaleString("ko-KR") ?? "N/A"}</b></span>
              )}
              <span>20일 일평균 <b>{result.avgVolume?.toLocaleString("ko-KR") ?? "N/A"}</b></span>
              <span>평균 대비 <b className={(result.volumeRatio ?? 1) >= 1.5 ? "text-red-600" : ""}>{result.volumeRatio ?? "N/A"}배</b></span>
            </div>
            {result.volumeProjected ? (
              <p className="mt-2 text-[13px] text-ink-48">
                장 {result.sessionElapsed}% 경과 — 현재 누적 거래량을 종일 기준으로 환산해 20일 평균과 비교했습니다.
                {result.volumeRatio !== null && (result.volumeRatio >= 1.5 ? " 평소보다 활발한 거래 흐름입니다." : result.volumeRatio <= 0.7 ? " 평소보다 한산한 흐름입니다." : " 평소와 비슷한 흐름입니다.")}
              </p>
            ) : result.volumeRatio !== null ? (
              <p className="mt-2 text-[13px] text-ink-48">
                {result.volumeRatio >= 2 ? "평소의 2배 이상 — 강한 관심/변동 신호" : result.volumeRatio >= 1.3 ? "거래량 증가 — 관심 유입" : result.volumeRatio <= 0.7 ? "평소보다 한산" : "평소 수준의 거래량"}
              </p>
            ) : null}
          </Card>

          <Card>
            <SectionLabel>매크로 · 섹터</SectionLabel>
            <p className="text-[14px] leading-snug text-ink-80">{result.macroSectorText}</p>
          </Card>

          {result.risks && (
            <Card className="!bg-parchment">
              <SectionLabel>유의할 리스크</SectionLabel>
              <p className="text-[14px] leading-snug text-ink-80">{result.risks}</p>
            </Card>
          )}

          <p className="text-[12px] text-ink-48">
            {result.isFallback ? "AI 미사용 — 기술적·매크로 신호 기반 추정. " : ""}
            추정 분석이며 투자 권유가 아닙니다. 최종 판단·책임은 본인에게 있습니다.
          </p>
        </div>
      )}
    </div>
  );
}
