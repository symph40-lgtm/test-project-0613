"use client";

import { useRouter } from "next/navigation";
import { History, AlertOctagon } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, StateNote } from "../../_components/primitives";
import type { GapReportData } from "./actions";

export default function GapReportClient({ report }: { report: GapReportData }) {
  const router = useRouter();

  if (report.total === 0) {
    return (
      <PageShell title="판단 갭 리포트" width="narrow">
        <StateNote title="아직 기록이 없습니다.">
          행동 기록을 추가하면 준수 비율과 반복 패턴을 보여드립니다.
        </StateNote>
        <div className="mt-6">
          <Button variant="primary" onClick={() => router.push("/journal")}>
            첫 기록 추가하기
          </Button>
        </div>
        <Disclaimer />
      </PageShell>
    );
  }

  const bars = [
    { label: "안내 따름", n: report.followed },
    { label: "일부 따름", n: report.partial },
    { label: "따르지 않음", n: report.ignored },
  ];

  return (
    <PageShell title="판단 갭 리포트" width="narrow">
      {report.isSmallSample ? (
        <StateNote title="아직 기록이 적습니다.">
          기록이 더 쌓이면 준수 비율과 반복 패턴을 신뢰도 있게 보여드립니다. 지금 수치는
          참고용입니다.
        </StateNote>
      ) : null}

      <Card className={report.isSmallSample ? "mt-4 opacity-70" : "mt-0"}>
        <SectionLabel>최근 {report.total}건 기준</SectionLabel>
        <div className="space-y-2.5">
          {bars.map((b) => (
            <div key={b.label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[15px]">{b.label}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-divider">
                <div
                  className="h-full rounded-full bg-ink transition-all"
                  style={{ width: report.total > 0 ? `${(b.n / report.total) * 100}%` : "0%" }}
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
          <p className="mt-1 text-[28px] font-semibold tabular-nums">{report.winDespiteIgnore}건</p>
        </Card>
        <Card>
          <p className="text-[14px] font-semibold text-ink-48">따르지 않아 손실 난 사례</p>
          <p className="mt-1 text-[28px] font-semibold tabular-nums">{report.lossDespiteIgnore}건</p>
        </Card>
      </div>

      {report.pattern ? (
        <Card className="mt-4 !bg-parchment">
          <SectionLabel>반복 패턴</SectionLabel>
          <p className="text-[16px] leading-snug">{report.pattern}</p>
        </Card>
      ) : null}

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
