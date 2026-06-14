"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { History, AlertOctagon } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, StateNote } from "../../_components/primitives";
import { gapReport } from "../../_data/mock";

export default function GapReportPage() {
  const router = useRouter();
  const [smallSample, setSmallSample] = useState(false);

  const bars = [
    { label: "안내 따름", n: gapReport.followed },
    { label: "일부 따름", n: gapReport.partial },
    { label: "따르지 않음", n: gapReport.ignored },
  ];

  return (
    <PageShell title="판단 갭 리포트" width="narrow">
      <div className="mb-6 flex items-center gap-2 text-[13px] text-ink-48">
        <span>데모 상태:</span>
        <button
          onClick={() => setSmallSample(false)}
          className={`rounded-full border px-3 py-1 ${!smallSample ? "border-guard text-guard" : "border-hairline text-ink-48"}`}
        >
          누적 충분
        </button>
        <button
          onClick={() => setSmallSample(true)}
          className={`rounded-full border px-3 py-1 ${smallSample ? "border-guard text-guard" : "border-hairline text-ink-48"}`}
        >
          소표본
        </button>
      </div>

      {smallSample ? (
        <StateNote title="아직 기록이 적습니다.">
          기록이 더 쌓이면 준수 비율과 반복 패턴을 신뢰도 있게 보여드립니다. 지금 수치는
          참고용입니다.
        </StateNote>
      ) : null}

      <Card className={smallSample ? "mt-4 opacity-60" : "mt-0"}>
        <div className="flex items-baseline justify-between">
          <SectionLabel>최근 {gapReport.total}건 기준</SectionLabel>
        </div>
        <div className="space-y-2.5">
          {bars.map((b) => (
            <div key={b.label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[15px]">{b.label}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-divider">
                <div
                  className="h-full rounded-full bg-ink"
                  style={{ width: `${(b.n / gapReport.total) * 100}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-[15px] font-semibold tabular-nums">
                {b.n}건
              </span>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Card>
          <p className="text-[14px] font-semibold text-ink-48">따르지 않았지만 수익 난 사례</p>
          <p className="mt-1 text-[28px] font-semibold tabular-nums">{gapReport.winDespiteIgnore}건</p>
          <p className="mt-1 text-[14px] text-ink-80">단기 반등 구간에서 유지 성공</p>
        </Card>
        <Card>
          <p className="text-[14px] font-semibold text-ink-48">따르지 않아 손실 난 사례</p>
          <p className="mt-1 text-[28px] font-semibold tabular-nums">{gapReport.lossDespiteIgnore}건</p>
          <p className="mt-1 text-[14px] text-ink-80">레버리지 유지 후 손실 확대</p>
        </Card>
      </div>

      <Card className="mt-4 !bg-parchment">
        <SectionLabel>반복 패턴</SectionLabel>
        <p className="text-[16px] leading-snug">{gapReport.pattern}</p>
      </Card>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button variant="primary" onClick={() => router.push("/journal/insights")}>
          인사이트 보기
        </Button>
        <Button variant="secondary" onClick={() => router.push("/journal/similar")}>
          <History size={16} /> 유사 상황
        </Button>
        <Button variant="text" onClick={() => router.push("/journal/misjudgment")}>
          <AlertOctagon size={16} /> 오판 분석
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
