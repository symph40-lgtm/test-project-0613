"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Sparkles, TrendingUp } from "lucide-react";
import { Button } from "../_components/Button";
import { Card, SectionLabel, StateNote } from "../_components/primitives";
import type { SectorFlow } from "@/lib/market/sectors";
import { recommendSectors, type SectorReco, type ScoredItem } from "./actions";

// 8항목 점수 막대
function ScoreBars({ items }: { items: ScoredItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {items.map((it, j) => {
        const pct = it.max > 0 ? Math.round((it.score / it.max) * 100) : 0;
        return (
          <div key={j} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-[12px] text-ink-48" title={it.note}>{it.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-divider">
              <div className={`h-full rounded-full ${pct >= 80 ? "bg-red-500" : pct >= 50 ? "bg-ink" : "bg-blue-400"}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="w-12 shrink-0 text-right text-[12px] font-semibold tabular-nums">{it.score}/{it.max}</span>
          </div>
        );
      })}
    </div>
  );
}

// 용어 설명 + 산식 토글
function HelpToggle() {
  const Term = ({ t, children }: { t: string; children: ReactNode }) => (
    <div className="border-l-2 border-divider pl-3">
      <p className="text-[13px] font-semibold text-ink">{t}</p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-80">{children}</p>
    </div>
  );
  return (
    <details className="mt-2 rounded-[10px] border border-hairline bg-pearl/40">
      <summary className="cursor-pointer list-none px-3 py-2 text-[13px] font-medium text-guard select-none">
        📖 용어 설명·산식 보기
      </summary>
      <div className="space-y-3 px-3 pb-3 pt-1">
        <Term t="상대강도 (%p)">
          섹터 ETF 당일 등락 − <b>코스피</b> 당일 등락. 양수면 시장보다 강함(주도), 음수면 약함.
          <br />예) ETF +2%, 코스피 −1% → <b>+3%p</b>.
        </Term>
        <Term t="정배열 / 역배열">
          <b>정배열</b> = 현재가 &gt; 20일선 &gt; 60일선 (상승추세). <b>역배열</b> = 반대(하락추세).
          정배열은 이미 오르는 중(주도), 역배열은 조정 중(반등 매력 후보).
        </Term>
        <Term t="거래량 (배수)">
          당일 거래량 ÷ 20일 평균. <b>🔥 ≥2배(급증)</b>, <b>↑ ≥1.5배</b>. 자금 유입 강도.
        </Term>
        <Term t="주도력 (0~100) — '지금 강한 섹터인가'">
          상대강도(0~22) + 전고점 위치(0~22) + 정배열(12) + 당일 모멘텀(0~12) + 거래량 급증(0~12) + 외인·기관 수급(0~20).
          신고가권·정배열·수급유입일수록 높음.
        </Term>
        <Term t="매수매력 (0~100) — '조정 후 반등할 매력'">
          기본 38점에서 가감:
          <br />· <b>낙폭</b>: 5~40% 빠질수록 ↑(최대 +26), 40%↑ 과대낙폭은 소폭 ↓
          <br />· <b>과매도</b> RSI&lt;35 +12 / &lt;45 +6 / &gt;70 −8
          <br />· <b>볼린저%B</b> &lt;25 +8 / &lt;40 +4 / &gt;90 −6
          <br />· <b>수급</b> 외인·기관 동시순매수 +16 / 한쪽+ +8 / <span className="text-blue-600">둘다 이탈 −12</span>
          <br />· <b>반등 시작</b> 당일 +1%↑ &amp; 거래량 1.3배↑ +8
          <br />· <b>추가하락 위험</b> 역배열 &amp; 당일 −1%↓ −12
          <br />→ 많이 빠졌는데 과매도이고 <b>외인·기관이 바닥에서 사면 ↑</b>, 수급이 빠지면 ↓.
        </Term>
        <Term t="주도력 ↔ 매수매력 (반대 개념)">
          <b>주도력↑</b> = 이미 강세(신고가, 예: 반도체) → 추격 부담.
          <b>매수매력↑</b> = 많이 빠졌고 과매도인데 수급이 들어오는 섹터 → 반등 기대.
        </Term>
        <p className="text-[11px] text-ink-48">
          수급·전고점·상대강도·정배열·거래량은 실데이터(네이버·Yahoo). 실적(EPS 전망)만 미국 대표주 90일 리비전(실데이터)을 AI가 해석.
        </p>
      </div>
    </details>
  );
}

function flowText(v: number | null): { text: string; cls: string } {
  if (v === null) return { text: "—", cls: "text-ink-48" };
  const cls = v > 0 ? "text-red-600" : v < 0 ? "text-blue-600" : "text-ink-48";
  return { text: `${v > 0 ? "+" : ""}${v.toLocaleString("ko-KR")}`, cls };
}
function pctCls(v: number | null) {
  return v === null || v === 0 ? "text-ink-48" : v > 0 ? "text-red-600" : "text-blue-600";
}
function scoreCls(s: number) {
  return s >= 80 ? "bg-red-50 text-red-600" : s >= 65 ? "bg-amber-50 text-amber-600" : s >= 50 ? "bg-ink/10 text-ink-80" : "bg-blue-50 text-blue-600";
}

function TimingBadges({ buy, sell, attract }: { buy?: number; sell?: number; attract?: number }) {
  if (buy == null && sell == null && attract == null) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {attract != null && <span className="rounded-full bg-guard/15 px-2 py-0.5 text-[12px] font-bold text-guard">매수매력도 {attract}</span>}
      {buy != null && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[12px] font-semibold text-red-600">매수타이밍 {buy}</span>}
      {sell != null && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[12px] font-semibold text-blue-600">매도타이밍 {sell}</span>}
    </span>
  );
}

export default function SectorsClient({ sectors }: { sectors: SectorFlow[] }) {
  const byName = new Map(sectors.map((s) => [s.sector, s]));
  const semiSF = sectors.find((s) => s.isSemi);
  const [reco, setReco] = useState<SectorReco | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();

  function run() {
    setLoading(true);
    startTransition(async () => {
      try {
        setReco(await recommendSectors(sectors));
      } finally {
        setLoading(false);
      }
    });
  }

  if (sectors.length === 0) {
    return (
      <div className="mt-6">
        <StateNote title="섹터 수급 데이터를 불러오지 못했습니다.">잠시 후 다시 시도해 주세요.</StateNote>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {/* AI 주도 섹터 판정 */}
      <Card className="border-guard/40">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>섹터 채점 — ① 보유 반도체 진단 + ② 매수매력 후보</SectionLabel>
          <Button variant="primary" onClick={run} disabled={isPending} className="!px-4 !py-2 !text-[14px] shrink-0">
            <Sparkles size={15} />
            {loading ? "분석 중…" : reco ? "다시 분석" : "주도 섹터 분석 받기"}
          </Button>
        </div>

        {!reco && !loading && (
          <p className="text-[14px] leading-snug text-ink-48">
            단기 테마가 아니라 <b>구조적 주도 섹터</b>인지 100점 기준으로 채점합니다 — 실적 상향·기관/외국인 동시수급·거래대금 급증·상대강도·확산을 종합.
          </p>
        )}

        {reco && (
          <div className="space-y-3">
            {reco.overview && <p className="text-[14px] text-ink-80">{reco.overview}</p>}

            {/* 반도체 진단 (항목별 점수 + 보유 관점 매수/매도) */}
            {reco.semiconductor && (
              <div className="rounded-[12px] border border-ink/20 bg-canvas p-3">
                <p className="mb-1 text-[12px] font-semibold text-ink-48">① 내 보유 섹터 진단 (순위 아님 · 보유 관점)</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[16px] font-semibold">반도체 진단</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-bold ${scoreCls(reco.semiconductor.total)}`}>{reco.semiconductor.total}점 / 100</span>
                  <span className="text-[13px] text-ink-48">{reco.semiconductor.verdict}</span>
                </div>
                {semiSF && <div className="mt-1.5"><TimingBadges buy={semiSF.buyTiming} sell={semiSF.sellTiming} attract={semiSF.buyAttract} /></div>}
                <ScoreBars items={reco.semiconductor.items} />
                {reco.semiconductor.outlook && (
                  <p className="mt-2 text-[14px] leading-snug"><span className="font-semibold text-ink">방향 전망 · </span>{reco.semiconductor.outlook}</p>
                )}
                <p className="mt-1.5 text-[14px] leading-snug">
                  <span className="font-semibold text-guard">보유 관점 · </span>{reco.semiconductor.stance}
                </p>
                {reco.semiconductor.notes && <p className="mt-1 text-[12px] leading-snug text-ink-48">{reco.semiconductor.notes}</p>}
              </div>
            )}

            {reco.picks.length > 0 && <p className="pt-2 text-[13px] font-semibold text-ink-48">② 반도체 외 매수 매력 후보 (매수매력도 1·2위 · 반등 기대)</p>}
            {reco.picks.map((p, i) => (
              <div key={i} className="rounded-[12px] border border-guard/30 bg-pearl p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <TrendingUp size={16} className="text-guard" />
                  <span className="text-[16px] font-semibold">{p.sector}</span>
                  <span className="text-[13px] text-ink-48">{p.etf}</span>
                  {byName.get(p.sector) && <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-bold ${scoreCls(byName.get(p.sector)!.buyAttract)}`}>매수매력도 {byName.get(p.sector)!.buyAttract}</span>}
                  <span className="text-[12px] text-ink-48">{p.verdict}</span>
                </div>
                {byName.get(p.sector) && <div className="mt-1.5"><TimingBadges buy={byName.get(p.sector)!.buyTiming} sell={byName.get(p.sector)!.sellTiming} /></div>}
                <p className="mt-2 text-[12px] font-semibold text-ink-48">주도·펀더멘털 점검 (8항목 합계 {p.total}/100)</p>
                <ScoreBars items={p.items} />
                {p.reason && <p className="mt-2 text-[14px] leading-snug text-ink-80">{p.reason}</p>}
                {p.outlook && <p className="mt-1.5 text-[14px] leading-snug"><span className="font-semibold text-ink">방향 전망 · </span>{p.outlook}</p>}
                {p.keyIndicators.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[12px] font-semibold text-ink-48">핵심 점검 지표</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {p.keyIndicators.map((k, j) => (
                        <li key={j} className="flex gap-1.5 text-[13px] leading-snug text-ink-80"><span className="text-ink-48">·</span>{k}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="mt-2 text-[14px] leading-snug">
                  <span className="font-semibold text-guard">매수 타이밍 · </span>{p.buyTiming}
                </p>
                {p.risks && <p className="mt-1 text-[13px] leading-snug text-blue-600">리스크 · {p.risks}</p>}
                {p.watch && <p className="mt-1 text-[12px] text-ink-48">모니터링: {p.watch}</p>}
              </div>
            ))}
            <p className="text-[11px] leading-snug text-ink-48">
              <b>매수타이밍</b>=추세 유지+과열 아님+눌림+수급에서 높음 / <b>매도타이밍</b>=과매수·신고가 급등(climax)·추세 훼손에서 높음 (RSI·볼린저·전고점·수급 기반 0~100).
              {reco.isFallback ? " AI 미사용 — 신호 점수 기준." : ""} 실적 전망·정책·확산은 AI 정성평가. 투자 권유가 아니며 최종 판단·책임은 본인에게 있습니다.
            </p>
          </div>
        )}
      </Card>

      {/* 섹터 신호 모니터 */}
      <Card>
        <SectionLabel>섹터 신호 모니터 (매수매력도 순)</SectionLabel>
        <HelpToggle />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-pearl text-[12px] text-ink-48">
              <tr>
                <th className="px-2 py-2 text-left font-medium">섹터</th>
                <th className="px-2 py-2 text-right font-medium">당일</th>
                <th className="px-2 py-2 text-right font-medium">거래량</th>
                <th className="px-2 py-2 text-right font-medium">외인5일</th>
                <th className="px-2 py-2 text-center font-medium">동시수급</th>
                <th className="px-2 py-2 text-right font-medium">전고점대비</th>
                <th className="px-2 py-2 text-right font-medium">상대강도</th>
                <th className="px-2 py-2 text-center font-medium">정배열</th>
                <th className="px-2 py-2 text-right font-medium">주도력</th>
                <th className="px-2 py-2 text-right font-medium">매수매력</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {[...sectors].sort((a, b) => b.buyAttract - a.buyAttract).map((s) => {
                const f5 = flowText(s.foreign5d);
                return (
                  <tr key={s.code} className={s.isSemi ? "bg-guard/5" : ""}>
                    <td className="px-2 py-1.5"><span className="font-medium">{s.sector}{s.isSemi ? " ★" : ""}</span></td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pctCls(s.changePercent)}`}>
                      {s.changePercent !== null ? `${s.changePercent > 0 ? "+" : ""}${s.changePercent.toFixed(1)}%` : "—"}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${s.volRatio == null ? "text-ink-48" : s.volRatio >= 2 ? "text-red-600 font-semibold" : s.volRatio >= 1.5 ? "text-red-500" : s.volRatio < 0.8 ? "text-ink-48" : "text-ink-80"}`}>
                      {s.volRatio != null ? `${s.volRatio.toFixed(1)}x${s.volRatio >= 2 ? "🔥" : s.volRatio >= 1.5 ? "↑" : ""}` : "—"}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${f5.cls}`}>{f5.text}</td>
                    <td className="px-2 py-1.5 text-center">{s.bothBuying ? "🔴" : "·"}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${s.near52wHigh ? "text-red-600 font-semibold" : (s.drawdown ?? 0) <= -15 ? "text-blue-600" : "text-ink-48"}`}>
                      {s.drawdown != null ? `${s.drawdown}%` : "—"}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pctCls(s.relStrength)}`}>{s.relStrength != null ? `${s.relStrength > 0 ? "+" : ""}${s.relStrength}` : "—"}</td>
                    <td className="px-2 py-1.5 text-center">
                      {s.maAligned ? <span className="text-red-600 font-semibold">정배열{s.near52wHigh ? "↑" : ""}</span> : <span className="text-blue-600">역배열</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{s.dataScore}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${s.buyAttract >= 60 ? "text-guard" : "text-ink-80"}`}>{s.buyAttract}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[12px] leading-snug text-ink-48">
매수매력도 순 정렬. <b>주도력</b>=지금 강한 섹터(전고점 위치·상대강도·정배열·모멘텀·수급) / <b>매수매력</b>=조정 후 반등 매력(낙폭·과매도·수급유입). <b>둘은 다릅니다</b> — 반도체는 주도력↑·매수매력↓(신고가), 조정 섹터는 주도력↓·매수매력↑일 수 있음. 위 AI '후보'는 매수매력도 상위에서 선정됩니다. <b>정배열</b>(현재가&gt;20일선&gt;60일선)=상승추세, <b>역배열</b>=하락추세 — 후보 섹터는 대부분 역배열(조정 중)이라 반등 매력으로 봅니다.
          전고점대비 0%=신고가(빨강)·-15%↓=되돌림(파랑) · 동시수급🔴=ETF 외인·기관 5일 동시순매수 · 상대강도=코스피 대비(%p) · <b>거래량=20일 평균 대비 배수</b>(🔥≥2배 급증·↑≥1.5배).
          <b>주의: ETF 외인 수급·전고점은 개별주와 다를 수 있습니다.</b> 실적은 미국 대표주 EPS 리비전(실데이터). 출처: 네이버·Yahoo.
        </p>
      </Card>
    </div>
  );
}
