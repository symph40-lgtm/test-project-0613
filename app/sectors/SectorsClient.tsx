"use client";

import { useState, useTransition } from "react";
import { Sparkles, TrendingUp, Check, X } from "lucide-react";
import { Button } from "../_components/Button";
import { Card, SectionLabel, StateNote } from "../_components/primitives";
import type { SectorFlow } from "@/lib/market/sectors";
import { recommendSectors, type SectorReco } from "./actions";

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

export default function SectorsClient({ sectors }: { sectors: SectorFlow[] }) {
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
          <SectionLabel>주도 섹터 발굴 (반도체 외)</SectionLabel>
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
            {reco.picks.map((p, i) => (
              <div key={i} className="rounded-[12px] border border-hairline bg-pearl p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <TrendingUp size={16} className="text-guard" />
                  <span className="text-[16px] font-semibold">{p.sector}</span>
                  <span className="text-[13px] text-ink-48">{p.etf}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${scoreCls(p.score)}`}>{p.score}점</span>
                  <span className="text-[12px] text-ink-48">{p.verdict}</span>
                </div>
                <p className="mt-1.5 text-[14px] leading-snug text-ink-80">{p.reason}</p>
                {p.checklist.length > 0 && (
                  <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                    {p.checklist.map((c, j) => (
                      <li key={j} className="flex items-center gap-1.5 text-[13px]">
                        {c.ok ? <Check size={13} className="text-red-600" /> : <X size={13} className="text-ink-48" />}
                        <span className={c.ok ? "text-ink-80" : "text-ink-48"}>{c.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[14px] leading-snug">
                  <span className="font-semibold text-guard">매수 타이밍 · </span>{p.buyTiming}
                </p>
                {p.watch && <p className="mt-1 text-[12px] text-ink-48">모니터링: {p.watch}</p>}
              </div>
            ))}
            <p className="text-[11px] text-ink-48">
              {reco.isFallback ? "AI 미사용 — 신호 점수 기준. " : ""}실적 전망·정책·확산은 AI 정성평가입니다. 투자 권유가 아니며 최종 판단·책임은 본인에게 있습니다.
            </p>
          </div>
        )}
      </Card>

      {/* 섹터 신호 모니터 */}
      <Card>
        <SectionLabel>섹터 신호 모니터 (신호점수 순)</SectionLabel>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-pearl text-[12px] text-ink-48">
              <tr>
                <th className="px-2 py-2 text-left font-medium">섹터</th>
                <th className="px-2 py-2 text-right font-medium">당일</th>
                <th className="px-2 py-2 text-right font-medium">외인5일</th>
                <th className="px-2 py-2 text-center font-medium">동시수급</th>
                <th className="px-2 py-2 text-right font-medium">거래대금</th>
                <th className="px-2 py-2 text-right font-medium">상대강도</th>
                <th className="px-2 py-2 text-center font-medium">정배열</th>
                <th className="px-2 py-2 text-right font-medium">신호</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {sectors.map((s) => {
                const f5 = flowText(s.foreign5d);
                return (
                  <tr key={s.code}>
                    <td className="px-2 py-1.5"><span className="font-medium">{s.sector}</span></td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pctCls(s.changePercent)}`}>
                      {s.changePercent !== null ? `${s.changePercent > 0 ? "+" : ""}${s.changePercent.toFixed(1)}%` : "—"}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${f5.cls}`}>{f5.text}</td>
                    <td className="px-2 py-1.5 text-center">{s.bothBuying ? "🔴" : "·"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-ink-80">{s.tradingValueEok != null ? `${s.tradingValueEok.toLocaleString("ko-KR")}억` : "—"}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pctCls(s.relStrength)}`}>{s.relStrength != null ? `${s.relStrength > 0 ? "+" : ""}${s.relStrength}` : "—"}</td>
                    <td className="px-2 py-1.5 text-center">{s.maAligned ? "✓" : "·"}{s.near52wHigh ? "↑" : ""}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{s.dataScore}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[12px] leading-snug text-ink-48">
          동시수급🔴=외국인·기관 5일 동시 순매수 · 상대강도=코스피 대비 등락(%p) · 정배열✓(↑=신고가근접) · 신호=계산 신호 점수(/55).
          나머지(실적 상향·정책·확산)는 위 AI 분석이 보완합니다. 출처: 네이버·Yahoo.
        </p>
      </Card>
    </div>
  );
}
