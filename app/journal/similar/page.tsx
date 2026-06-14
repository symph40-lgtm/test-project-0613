"use client";

import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, MetaRow } from "../../_components/primitives";
import { similarCase } from "../../_data/mock";

export default function SimilarPage() {
  const router = useRouter();
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
        <SectionLabel>{similarCase.date} 사례</SectionLabel>
        <MetaRow label="스탁가드 안내" value={similarCase.guide} />
        <MetaRow label="실제 행동" value={similarCase.action} />
        <MetaRow label="결과" value={similarCase.result} />
      </Card>

      <Card className="mt-4">
        <SectionLabel>당시 놓친 신호</SectionLabel>
        <p className="text-[16px] leading-snug">{similarCase.missed}</p>
      </Card>

      <Card className="mt-4 !bg-parchment">
        <SectionLabel>지금 참고할 점</SectionLabel>
        <p className="text-[16px] leading-snug">{similarCase.takeaway}</p>
      </Card>

      <p className="mt-3 text-[13px] text-ink-48">
        과거 사례는 정답이 아니라 참고점입니다. 현재와 겹치는 조건뿐 아니라 다른 조건도 함께
        확인하세요.
      </p>

      <div className="mt-6">
        <Button variant="primary" onClick={() => router.push("/journal/misjudgment")}>
          상세 리포트 보기
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
