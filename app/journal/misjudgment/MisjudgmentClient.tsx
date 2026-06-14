"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, MetaRow, StateNote } from "../../_components/primitives";
import { excludeLog } from "./actions";
import type { MisjudgmentData } from "./actions";

export default function MisjudgmentClient({ data }: { data: MisjudgmentData }) {
  const router = useRouter();
  const [decision, setDecision] = useState<"none" | "excluded">("none");
  const [isPending, startTransition] = useTransition();

  if (!data) {
    return (
      <PageShell title="오판 분석 리포트" width="narrow">
        <StateNote title="아직 분석할 오판 사례가 없습니다.">
          안내를 따르지 않은 후 손실이 발생한 기록이 생기면 분석해드립니다.
        </StateNote>
        <div className="mt-6">
          <Button variant="primary" onClick={() => router.push("/journal")}>
            기록 추가하기
          </Button>
        </div>
        <Disclaimer />
      </PageShell>
    );
  }

  const { log, report } = data;

  function handleExclude() {
    startTransition(async () => {
      await excludeLog(log.id);
      setDecision("excluded");
    });
  }

  return (
    <PageShell title="오판 분석 리포트" width="narrow">
      <Card>
        <MetaRow label="날짜" value={`${log.date}${log.ticker ? ` · ${log.ticker}` : ""}`} />
        <MetaRow label="당시 판단" value={report.verdict} />
        <MetaRow label="실제 결과" value={report.result} />
      </Card>

      {/* 당시 근거 vs 이후 바뀐 변수 대조 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Card>
          <SectionLabel>판단 당시 근거</SectionLabel>
          <ul className="space-y-1.5">
            {report.basisThen.map((b) => (
              <li key={b} className="flex gap-2 text-[15px]">
                <span className="text-ink-48">·</span>
                {b}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <SectionLabel>이후 바뀐 변수</SectionLabel>
          <ul className="space-y-1.5">
            {report.changed.map((b) => (
              <li key={b} className="flex gap-2 text-[15px]">
                <span className="text-ink-48">·</span>
                {b}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <SectionLabel>오판 원인</SectionLabel>
        <p className="text-[16px] leading-snug">{report.cause}</p>
      </Card>

      <Card className="mt-4 !bg-parchment">
        <SectionLabel>다음 판단에 반영</SectionLabel>
        <p className="text-[16px] leading-snug">{report.nextApply}</p>
      </Card>

      {decision === "excluded" ? (
        <p className="mt-4 text-[14px] text-ink-80">
          이번 사례는 학습에서 제외했습니다.
        </p>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button
          variant="secondary"
          disabled={isPending || decision === "excluded"}
          onClick={handleExclude}
        >
          {isPending ? "처리 중…" : "이번 사례 제외"}
        </Button>
        <Button variant="primary" onClick={() => router.push("/journal/insights")}>
          학습에 반영
        </Button>
      </div>

      <p className="mt-3 text-[13px] text-ink-48">
        학습 반영은 사용자가 동의한 경우에만 개인화 메모리에 적용됩니다.
      </p>
      <Disclaimer />
    </PageShell>
  );
}
