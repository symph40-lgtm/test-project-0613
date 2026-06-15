"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, MetaRow } from "../../_components/primitives";
import { bookmarkNextBriefing } from "./actions";
import type { BriefingSnapshot, AiPrecloseOutput } from "@/lib/market/types";
import type { EconEvent } from "@/lib/calendar/fred";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function fmtEventDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);
  const label = dateStr === today ? "오늘" : `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
  return label;
}

export default function PrecloseClient({
  snapshot,
  preclose,
  econEvents,
  fredConfigured,
}: {
  snapshot: BriefingSnapshot | null;
  preclose: AiPrecloseOutput | null;
  econEvents: EconEvent[];
  fredConfigured: boolean;
}) {
  const router = useRouter();
  const [booked, setBooked] = useState(false);
  const [isPending, startTransition] = useTransition();
  const ai = snapshot?.ai_output;
  const riskScore = snapshot?.risk_score ?? 0;

  return (
    <PageShell title="마감 전 판단" width="default">
      {/* 결론 */}
      <div className="rounded-[18px] bg-tile-1 p-6 text-white sm:p-8">
        <p className="text-[13px] text-body-muted">
          기준 포지션 · 리스크 {riskScore}점
        </p>
        <h2 className="mt-2 text-[28px] font-semibold leading-tight">
          {riskScore >= 65
            ? "다음날 갭하락 위험: 높음"
            : riskScore >= 35
              ? "변동 가능성 있음: 주의 구간"
              : "상대적 안정 구간"}
        </h2>
        <p className="mt-2 text-[17px] text-body-muted">
          {riskScore >= 65 ? "권장 대응: 비중 축소 검토" : "권장 대응: 현황 유지 검토"}
        </p>
      </div>

      {/* 오늘 장 요약 */}
      {preclose?.todaySummary && (
        <Card className="mt-4">
          <SectionLabel>오늘 장 요약</SectionLabel>
          <p className="text-[15px] text-ink-80">{preclose.todaySummary}</p>
        </Card>
      )}

      {/* 주요 경제지표 일정 — 실제 캘린더(FRED) 우선, 없으면 AI 예측 */}
      {econEvents.length > 0 ? (
        <Card className="mt-4">
          <SectionLabel>향후 5일 주요 경제지표 (실제 일정)</SectionLabel>
          <ul className="divide-y divide-divider">
            {econEvents.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2">
                  {e.importance === "high" ? (
                    <span className="rounded bg-ink px-1.5 py-0.5 text-[11px] text-white">중요</span>
                  ) : null}
                  <span className="text-[15px] font-medium">{e.name}</span>
                </div>
                <span className="shrink-0 text-[14px] text-ink-48 tabular-nums">
                  {fmtEventDate(e.date)} · {e.timeKst} (한국시간)
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-ink-48">
            출처: FRED 공식 릴리즈 캘린더. 발표 시각은 한국시간 환산값(서머타임 반영)입니다.
          </p>
        </Card>
      ) : preclose?.nightEvents && preclose.nightEvents.length > 0 ? (
        <Card className="mt-4">
          <SectionLabel>오늘 밤 주요 이벤트 · AI 예측</SectionLabel>
          <div className="space-y-3">
            {preclose.nightEvents.map((e, i) => (
              <div key={i}>
                <p className="text-[15px] font-semibold">{e.event}</p>
                <p className="text-[14px] text-ink-48">예상 시각: {e.expectedTime}</p>
              </div>
            ))}
          </div>
          {!fredConfigured && (
            <p className="mt-3 text-[12px] text-ink-48">
              FRED_API_KEY를 설정하면 실제 발표 일정·시각이 표시됩니다.
            </p>
          )}
        </Card>
      ) : null}

      {/* 결과별 시나리오 */}
      {preclose?.scenarios && preclose.scenarios.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>결과별 시나리오</SectionLabel>
          <ul className="divide-y divide-divider">
            {preclose.scenarios.map((s) => (
              <li key={s.result} className="flex gap-3 py-2.5">
                <span className="w-20 shrink-0 text-[15px] font-semibold">{s.result}</span>
                <span className="text-[15px] text-ink-80">{s.impact}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 수급 + 큰 장세 */}
      {ai && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Card>
            <SectionLabel>큰 장세 × 오늘 상황</SectionLabel>
            <p className="text-[15px] text-ink-80">{(ai.coreIssues ?? []).join(" · ")}</p>
            <p className="mt-2 text-[15px] font-semibold">{snapshot?.stage ?? ai.stage}</p>
          </Card>
          <Card>
            <SectionLabel>수급</SectionLabel>
            <p className="text-[15px] text-ink-80">{(ai.supplyNotes ?? []).join(" · ")}</p>
          </Card>
        </div>
      )}

      {/* 종목별 판단 */}
      {preclose?.perStockCalls && preclose.perStockCalls.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>종목별 판단</SectionLabel>
          {preclose.perStockCalls.map((p) => (
            <MetaRow key={p.ticker} label={p.ticker} value={p.call} />
          ))}
        </Card>
      )}

      {/* 원칙 위반 리스크 */}
      {ai?.donts && ai.donts.length > 0 && (
        <Card className="mt-4 !bg-parchment">
          <SectionLabel>원칙을 무시할 경우</SectionLabel>
          <p className="text-[15px] leading-snug">{ai.donts[0]}</p>
        </Card>
      )}

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          disabled={booked || isPending}
          onClick={() => {
            startTransition(async () => {
              await bookmarkNextBriefing();
              setBooked(true);
            });
          }}
        >
          <CalendarClock size={18} />
          {booked ? "내일 아침 다시 보기 예약됨" : isPending ? "예약 중…" : "내일 아침 다시 보기 예약"}
        </Button>
        {booked && (
          <p className="mt-3 text-[14px] text-ink-80">
            예약했습니다. 내일 아침 브리핑에서 오늘 판단과 함께 다시 보여드립니다.
          </p>
        )}
        <button
          onClick={() => router.push("/principles")}
          className="ml-1 mt-4 block text-[14px] text-guard"
        >
          원칙 다시 확인하기 →
        </button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
