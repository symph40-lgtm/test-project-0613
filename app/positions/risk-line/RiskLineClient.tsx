"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "../../_components/Button";
import { Card, SectionLabel } from "../../_components/primitives";
import { saveRiskLines } from "./actions";
import type { RiskLineRow, RiskLineKey } from "./constants";

export default function RiskLineClient({
  initialLines,
  channelSection,
}: {
  initialLines: RiskLineRow[];
  channelSection: React.ReactNode;
}) {
  const router = useRouter();
  const [lines, setLines] = useState(initialLines);
  const [isPending, startTransition] = useTransition();
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: RiskLineKey) {
    setLines((ls) => ls.map((l) => (l.trigger_key === key ? { ...l, is_on: !l.is_on } : l)));
  }

  function handleApply() {
    setError(null);
    const selections = Object.fromEntries(
      lines.map((l) => [l.trigger_key, l.is_on]),
    ) as Record<RiskLineKey, boolean>;

    startTransition(async () => {
      const result = await saveRiskLines(selections);
      if (result.error) {
        setError(result.error);
      } else {
        setApplied(true);
        setTimeout(() => router.push("/principles"), 900);
      }
    });
  }

  return (
    <>
      <Card>
        <p className="text-[17px] font-semibold">위험선 추천</p>
        <p className="mt-1 text-[14px] text-ink-48">
          보유 종목과 비중 기반 자동 추천. 조건에 닿으면 원칙을 함께 알려드립니다.
        </p>

        <div className="mt-5">
          <SectionLabel>추천 알림</SectionLabel>
          <p className="-mt-2 mb-3 text-[13px] text-ink-48">
            선택한 조건에 닿으면 저장한 원칙을 함께 알려드립니다.
          </p>
          <div className="space-y-2">
            {lines.map((l) => (
              <button
                key={l.trigger_key}
                onClick={() => toggle(l.trigger_key)}
                className={`flex w-full items-center gap-3 rounded-full border px-4 py-2.5 text-left text-[15px] ${
                  l.is_on ? "border-guard text-ink" : "border-hairline text-ink-80"
                }`}
              >
                <span
                  className={`grid size-5 place-items-center rounded-full border ${
                    l.is_on ? "border-guard bg-guard text-white" : "border-hairline"
                  }`}
                >
                  {l.is_on ? <Check size={13} /> : null}
                </span>
                <span className="flex-1">{l.label}</span>
                {l.recommended ? (
                  <span className="rounded-full bg-pearl px-2 py-0.5 text-[11px] text-ink-48">
                    추천
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card className="mt-4">
        <SectionLabel>알림 문장 미리보기</SectionLabel>
        <p className="text-[17px] leading-[1.47]">
          레버리지 축소 원칙에 해당합니다. 손실 만회성 추가 매수는 멈추세요.
        </p>
      </Card>

      {channelSection}

      {error ? (
        <p className="mt-3 text-[13px] text-red-500">{error}</p>
      ) : null}

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          disabled={isPending}
          onClick={handleApply}
        >
          {applied ? "적용됐습니다 →" : isPending ? "저장 중…" : "적용하기"}
        </Button>
        {applied ? (
          <p className="mt-3 text-[14px] text-ink-80">
            위험선이 적용됐습니다. 이제 이 조건에 닿으면 원칙을 함께 알려드립니다.
          </p>
        ) : null}
      </div>
    </>
  );
}
