"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, MetaRow } from "../../_components/primitives";
import { misjudgment } from "../../_data/mock";

export default function MisjudgmentPage() {
  const router = useRouter();
  const [decision, setDecision] = useState<"none" | "applied" | "excluded">("none");

  return (
    <PageShell title="오판 분석 리포트" width="narrow">
      <Card>
        <MetaRow label="당시 판단" value={misjudgment.verdict} />
        <MetaRow label="실제 결과" value={misjudgment.result} />
      </Card>

      {/* 당시 근거 vs 이후 바뀐 변수 — 대조 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Card>
          <SectionLabel>판단 당시 근거</SectionLabel>
          <ul className="space-y-1.5">
            {misjudgment.basisThen.map((b) => (
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
            {misjudgment.changed.map((b) => (
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
        <p className="text-[16px] leading-snug">{misjudgment.cause}</p>
      </Card>

      <Card className="mt-4 !bg-parchment">
        <SectionLabel>다음 판단에 반영</SectionLabel>
        <p className="text-[16px] leading-snug">{misjudgment.nextApply}</p>
      </Card>

      {decision !== "none" ? (
        <p className="mt-4 text-[14px] text-ink-80">
          {decision === "applied"
            ? "이 사례를 학습에 반영했습니다. 개인화 인사이트에서 확인할 수 있습니다."
            : "이번 사례는 학습에서 제외했습니다."}
        </p>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button variant="secondary" onClick={() => setDecision("excluded")}>
          이번 사례 제외
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setDecision("applied");
            setTimeout(() => router.push("/journal/insights"), 900);
          }}
        >
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
