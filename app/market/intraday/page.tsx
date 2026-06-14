"use client";

import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, MetaRow, SectionLabel, RiskBadge } from "../../_components/primitives";

export default function IntradaySummaryPage() {
  const router = useRouter();
  return (
    <PageShell title="장중 시황 요약" width="narrow">
      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[21px] font-semibold tracking-[0.231px]">13:00 장중 요약</h2>
          <span className="text-[13px] text-ink-48">하루 3회 발송</span>
        </div>

        <div className="mt-4 border-t border-divider pt-3">
          <MetaRow label="시장 단계" value="변동장 2단계" />
          <MetaRow label="기준 포지션" value="13:12 최신 상태" />
          <MetaRow label="주요 변화" value="금리 상승, 반도체 약세" />
          <div className="flex items-center justify-between py-1.5">
            <span className="text-[14px] text-ink-48">내 종목 주의</span>
            <span className="flex gap-1.5">
              <RiskBadge level="주의" />
              <span className="text-[15px]">SOXL · SK하이닉스</span>
            </span>
          </div>
        </div>

        <div className="mt-4 rounded-[11px] border border-hairline bg-pearl p-4">
          <SectionLabel>지금 피할 행동</SectionLabel>
          <ul className="space-y-1.5">
            <li className="flex gap-2 text-[16px]">
              <span className="text-ink-48">×</span> 장중 반등 추격 매수
            </li>
            <li className="flex gap-2 text-[16px]">
              <span className="text-ink-48">×</span> 레버리지 추가 진입
            </li>
          </ul>
        </div>

        <p className="mt-4 text-[15px] leading-snug text-ink-80">
          변동장 2단계입니다. 반도체 약세가 커졌고, 장중 추격 매수는 보류 구간입니다.
        </p>
      </Card>

      <div className="mt-6">
        <Button variant="primary" size="lg" onClick={() => router.push("/briefing/preclose")}>
          자세히 보기
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
