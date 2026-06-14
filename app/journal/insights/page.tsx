"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel } from "../../_components/primitives";
import { insights } from "../../_data/mock";

export default function InsightsPage() {
  const router = useRouter();
  const [apply, setApply] = useState(true);
  const [saved, setSaved] = useState(false);

  return (
    <PageShell title="개인화 인사이트" width="narrow">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <SectionLabel>잘 맞았던 판단</SectionLabel>
          <p className="text-[16px] leading-snug">{insights.strong}</p>
        </Card>
        <Card>
          <SectionLabel>취약했던 판단</SectionLabel>
          <p className="text-[16px] leading-snug">{insights.weak}</p>
        </Card>
      </div>

      <Card className="mt-4">
        <SectionLabel>다음부터 더 강하게 알려드릴 조건</SectionLabel>
        <ul className="space-y-1.5">
          {insights.reinforce.map((r) => (
            <li key={r} className="flex gap-2 text-[16px]">
              <span className="text-ink-48">·</span>
              {r}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4 !bg-parchment">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[16px] font-semibold">개인화 반영</p>
            <p className="text-[14px] text-ink-48">다음 안내에 이 패턴을 반영합니다.</p>
          </div>
          <button
            role="switch"
            aria-checked={apply}
            onClick={() => setApply((v) => !v)}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
              apply ? "bg-guard" : "bg-hairline"
            }`}
          >
            <span
              className={`absolute top-1 size-5 rounded-full bg-white transition-all ${
                apply ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>
        <p className="mt-3 text-[13px] text-ink-48">
          기록은 이 사용자에게만 쓰는 참고 데이터입니다. 특정 기록 제외·전체 삭제·학습
          초기화도 할 수 있습니다.
        </p>
      </Card>

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            setSaved(true);
            setTimeout(() => router.push("/briefing"), 900);
          }}
        >
          {saved ? "저장됐습니다 →" : "저장하기"}
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
