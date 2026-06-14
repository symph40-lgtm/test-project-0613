"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel } from "../../_components/primitives";

const reasons = ["나스닥 선물 약세 확대", "금리 변동성 상승", "장중 반등 실패 후 재하락"];

const nonCompliance = [
  { k: "원인", v: "나스닥 약세 + 금리 상승 동시" },
  { k: "취약 종목", v: "SOXL (레버리지 반도체)" },
  { k: "손실 결과", v: "하락을 더 크게 반영, 손실 확대 가능" },
  { k: "확인할 지표", v: "나스닥 선물 · 미국 10년물 금리" },
];

export default function IntradayAlertPage() {
  const router = useRouter();
  const [openRisk, setOpenRisk] = useState(true);

  return (
    <PageShell title="장중 알림" width="narrow">
      <div className="overflow-hidden rounded-[18px] border border-hairline">
        {/* 헤더 — 우선 강도 */}
        <div className="flex items-center justify-between bg-ink px-5 py-4 text-white">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-guard-on-dark" />
            <span className="text-[17px] font-semibold">위험 알림: SOXL</span>
          </div>
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[12px]">
            우선 강도 높음
          </span>
        </div>

        <div className="space-y-5 p-5">
          {/* 행동 / 금지 — 3요소 핵심 */}
          <div className="space-y-2">
            <p className="text-[17px]">
              <span className="font-semibold">행동</span> · 레버리지 비중 축소 원칙 해당
            </p>
            <p className="text-[17px]">
              <span className="font-semibold">금지</span> · 손실 만회성 추가 매수 금지
            </p>
          </div>

          <div className="border-t border-divider pt-4">
            <SectionLabel>이유</SectionLabel>
            <ul className="space-y-1.5">
              {reasons.map((r) => (
                <li key={r} className="flex gap-2 text-[16px]">
                  <span className="text-ink-48">·</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-divider pt-4">
            <SectionLabel>복기</SectionLabel>
            <p className="text-[16px]">이전 급락 첫날 대응 지연 패턴과 유사합니다.</p>
          </div>

          {/* 미준수 리스크 — 원인 → 취약 종목 → 손실 결과 → 확인할 지표 */}
          <div className="rounded-[11px] border border-hairline bg-pearl">
            <button
              onClick={() => setOpenRisk((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-[15px] font-semibold">무시하면 생길 수 있는 리스크</span>
              {openRisk ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {openRisk ? (
              <ol className="space-y-2 px-4 pb-4">
                {nonCompliance.map((n, i) => (
                  <li key={n.k} className="flex gap-3 text-[15px]">
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] text-white">
                      {i + 1}
                    </span>
                    <span>
                      <span className="text-ink-48">{n.k}</span> · {n.v}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>

          <Card className="!rounded-[11px] !border-hairline !bg-parchment">
            <p className="text-[14px] font-semibold text-ink-48">버핏식 원칙 관점 · 대조 관점</p>
            <p className="mt-1.5 text-[16px] leading-snug">
              단기 반등을 맞히려는 레버리지보다 생존 가능한 현금 여력이 우선입니다.
            </p>
          </Card>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="secondary" onClick={() => router.push("/briefing/evidence")}>
              상세 보기
            </Button>
            <Button variant="primary" onClick={() => router.push("/principles")}>
              원칙 확인
            </Button>
          </div>

          <button
            onClick={() => router.push("/positions/intraday")}
            className="text-[14px] text-guard"
          >
            장중 체결을 입력하고 다시 판단하기 →
          </button>
        </div>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
