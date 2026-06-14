"use client";

import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, MetaRow, StateNote } from "../../_components/primitives";
import type { SimilarCaseData } from "./actions";

function formatResult(v: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export default function SimilarClient({ similarCase }: { similarCase: SimilarCaseData | null }) {
  const router = useRouter();

  if (!similarCase) {
    return (
      <PageShell title="유사 상황 회상" width="narrow">
        <StateNote title="아직 과거 기록이 없거나 유사한 상황을 찾지 못했습니다.">
          행동 기록이 쌓이면 현재 장세·보유 종목과 겹치는 과거 사례를 보여드립니다.
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

  const resultText = similarCase.result_day1 != null
    ? `다음날 ${formatResult(similarCase.result_day1)}`
    : "결과 미기록";

  return (
    <PageShell title="유사 상황 회상" width="narrow">
      <Card>
        <SectionLabel>현재 조건과 {similarCase.overlaps.length}개가 겹칩니다</SectionLabel>
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {similarCase.overlaps.map((o) => (
            <li key={o} className="flex items-center gap-2 text-[15px]">
              <Check size={15} className="text-guard" />
              {o}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4">
        <SectionLabel>{similarCase.date} 사례{similarCase.ticker ? ` · ${similarCase.ticker}` : ""}</SectionLabel>
        {similarCase.guidance_action ? (
          <MetaRow label="스탁가드 안내" value={similarCase.guidance_action} />
        ) : null}
        {similarCase.guidance_prohibition ? (
          <MetaRow label="금지" value={similarCase.guidance_prohibition} />
        ) : null}
        <MetaRow label="실제 행동" value={`${similarCase.actual_action} (${similarCase.follow_level})`} />
        <MetaRow label="결과" value={resultText} />
      </Card>

      {similarCase.stage ? (
        <Card className="mt-4">
          <SectionLabel>당시 장세</SectionLabel>
          <p className="text-[16px] leading-snug">{similarCase.stage}</p>
        </Card>
      ) : null}

      <Card className="mt-4 !bg-parchment">
        <SectionLabel>지금 참고할 점</SectionLabel>
        <p className="text-[16px] leading-snug">
          {similarCase.follow_level === "따르지 않음"
            ? `이 상황에서 안내를 따르지 않았을 때 결과는 ${resultText}였습니다. 현재 조건과 다른 변수도 함께 확인하세요.`
            : `이 상황에서 안내를 따랐을 때 결과는 ${resultText}였습니다. 과거 사례는 참고점이며 현재와 완전히 같지 않을 수 있습니다.`}
        </p>
      </Card>

      <p className="mt-3 text-[13px] text-ink-48">
        과거 사례는 정답이 아니라 참고점입니다. 현재와 겹치는 조건뿐 아니라 다른 조건도 함께
        확인하세요.
      </p>

      <div className="mt-6">
        <Button variant="primary" onClick={() => router.push("/journal/misjudgment")}>
          오판 분석 보기
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
