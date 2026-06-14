"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, ScoreBar, SectionLabel } from "../../_components/primitives";
import { evidenceScores, supply, coreIssues } from "../../_data/mock";

export default function EvidencePage() {
  const router = useRouter();
  const [unavailable, setUnavailable] = useState(false);

  return (
    <PageShell title="판단 근거">
      <div className="mb-6 flex items-center gap-2 text-[13px] text-ink-48">
        <span>데모 상태:</span>
        <button
          onClick={() => setUnavailable(false)}
          className={`rounded-full border px-3 py-1 ${!unavailable ? "border-guard text-guard" : "border-hairline text-ink-48"}`}
        >
          기본
        </button>
        <button
          onClick={() => setUnavailable(true)}
          className={`rounded-full border px-3 py-1 ${unavailable ? "border-guard text-guard" : "border-hairline text-ink-48"}`}
        >
          일부 확인 불가
        </button>
      </div>

      {/* 위험 점수 */}
      <Card>
        <SectionLabel>위험 점수</SectionLabel>
        <div className="divide-y divide-divider">
          {evidenceScores.map((s, i) =>
            unavailable && i === 2 ? (
              <div key={s.label} className="flex items-center gap-3 py-2 text-ink-48">
                <span className="w-24 shrink-0 text-[15px]">{s.label}</span>
                <span className="text-[14px]">확인 불가 — 결론 신뢰도 낮춤</span>
              </div>
            ) : (
              <ScoreBar key={s.label} label={s.label} score={s.score} note={s.note} />
            ),
          )}
        </div>
        <p className="mt-3 text-[14px] text-ink-48">
          이슈 지속성: <span className="text-ink">높음</span> · 며칠 이상 이어질 리스크
        </p>
      </Card>

      {/* 2차원 맵 */}
      <Card className="mt-4">
        <SectionLabel>큰 장세 × 오늘 상황</SectionLabel>
        <p className="text-[15px] text-ink-80">
          큰 장세: 전쟁 리스크 확대 · 오늘 상황: 휴전 기대 단기 완화
        </p>
        <TwoAxisMap />
        <p className="mt-3 text-[15px] font-semibold">판단: 큰 압력 안의 단기 완화</p>
      </Card>

      {/* 수급 */}
      <Card className="mt-4">
        <SectionLabel>수급</SectionLabel>
        <ul className="space-y-1.5">
          {supply.map((s) => (
            <li key={s} className="flex gap-2 text-[16px]">
              <span className="text-ink-48">·</span>
              {s}
            </li>
          ))}
        </ul>
      </Card>

      {/* 핵심 이슈 */}
      <Card className="mt-4">
        <SectionLabel>핵심 이슈</SectionLabel>
        <ul className="space-y-1.5">
          {coreIssues.map((s) => (
            <li key={s} className="flex gap-2 text-[16px]">
              <span className="text-ink-48">·</span>
              {s}
            </li>
          ))}
        </ul>
      </Card>

      <div className="mt-6">
        <Button variant="primary" onClick={() => router.push("/positions")}>
          내 포지션 검토하기
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}

/* 큰 장세 압력(x) × 오늘 상황(y) 2차원 맵. 현재 위치: 좌상단(압력 낮음·완화) */
function TwoAxisMap() {
  return (
    <div className="mt-4">
      <div className="flex">
        <div className="flex w-6 flex-col items-center justify-between py-1 text-[12px] text-ink-48">
          <span>완화</span>
          <span className="[writing-mode:vertical-rl]">오늘 상황</span>
          <span>악화</span>
        </div>
        <div className="relative flex-1">
          <div className="relative aspect-[16/9] rounded-[8px] border border-hairline bg-pearl">
            {/* 사분면 구분선 */}
            <div className="absolute left-1/2 top-0 h-full w-px bg-hairline" />
            <div className="absolute left-0 top-1/2 h-px w-full bg-hairline" />
            {/* 현재 위치 점 — 좌상단 */}
            <div className="absolute left-[28%] top-[30%] -translate-x-1/2 -translate-y-1/2">
              <div className="size-3 rounded-full bg-guard ring-4 ring-guard/20" />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 whitespace-nowrap text-[12px] font-semibold text-guard">
                현재
              </span>
            </div>
          </div>
          <div className="mt-1 flex justify-between text-[12px] text-ink-48">
            <span>낮음</span>
            <span>큰 장세 압력</span>
            <span>높음</span>
          </div>
        </div>
      </div>
    </div>
  );
}
