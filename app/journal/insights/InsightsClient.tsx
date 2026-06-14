"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, StateNote } from "../../_components/primitives";
import { savePersonalizationSettings, deleteAllLogs } from "./actions";
import type { PersonalizationSettings, InsightsData } from "./actions";

export default function InsightsClient({
  settings,
  insights,
}: {
  settings: PersonalizationSettings;
  insights: InsightsData;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      await savePersonalizationSettings(next);
    });
  }

  function handleDeleteAll() {
    startTransition(async () => {
      await deleteAllLogs();
      setDeleted(true);
      setShowDeleteConfirm(false);
      router.refresh();
    });
  }

  return (
    <PageShell title="개인화 인사이트" width="narrow">
      {!enabled ? (
        <StateNote title="개인화 반영이 꺼져 있습니다.">
          개인화 반영을 켜면 행동 기록 기반의 인사이트를 확인할 수 있습니다.
        </StateNote>
      ) : insights ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <SectionLabel>잘 맞았던 판단</SectionLabel>
            <p className="text-[16px] leading-snug">{insights.strong}</p>
          </Card>
          {insights.weak ? (
            <Card>
              <SectionLabel>취약했던 판단</SectionLabel>
              <p className="text-[16px] leading-snug">{insights.weak}</p>
            </Card>
          ) : null}
        </div>
      ) : (
        <StateNote title="인사이트를 생성할 수 없습니다.">
          행동 기록이 3건 이상 쌓이면 분석해드립니다.
        </StateNote>
      )}

      {insights?.reinforce && insights.reinforce.length > 0 ? (
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
      ) : null}

      {/* 개인화 설정 */}
      <Card className="mt-4 !bg-parchment">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[16px] font-semibold">개인화 반영</p>
            <p className="text-[14px] text-ink-48">다음 안내에 이 패턴을 반영합니다.</p>
          </div>
          <button
            role="switch"
            aria-checked={enabled}
            disabled={isPending}
            onClick={handleToggle}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
              enabled ? "bg-guard" : "bg-hairline"
            }`}
          >
            <span
              className={`absolute top-1 size-5 rounded-full bg-white transition-all ${
                enabled ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>
        <p className="mt-3 text-[13px] text-ink-48">
          기록은 이 사용자에게만 쓰는 참고 데이터입니다.
        </p>

        {/* 전체 삭제 */}
        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="mt-3 text-[13px] text-red-500 underline"
          >
            전체 기록 삭제 및 초기화
          </button>
        ) : deleted ? (
          <p className="mt-3 text-[13px] text-ink-80">기록이 삭제되었습니다.</p>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-[13px] font-semibold text-red-500">
              모든 행동 기록이 삭제됩니다. 되돌릴 수 없습니다.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDeleteAll}
                disabled={isPending}
                className="rounded-[8px] bg-red-500 px-3 py-1.5 text-[13px] text-white"
              >
                {isPending ? "삭제 중…" : "삭제 확인"}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-[8px] border border-hairline px-3 py-1.5 text-[13px]"
              >
                취소
              </button>
            </div>
          </div>
        )}
      </Card>

      <div className="mt-6">
        <Button variant="primary" size="lg" onClick={() => router.push("/briefing")}>
          브리핑으로 돌아가기
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
