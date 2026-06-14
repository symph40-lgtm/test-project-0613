"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronUp, BellOff } from "lucide-react";
import { useState } from "react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel } from "../../_components/primitives";
import { markAlertRead } from "./actions";
import type { AlertRow } from "./actions";

const SEVERITY_LABEL: Record<string, string> = {
  high: "우선 강도 높음",
  medium: "우선 강도 보통",
  low: "참고 수준",
};

export default function IntradayAlertClient({ alert }: { alert: AlertRow | null }) {
  const router = useRouter();
  const [openRisk, setOpenRisk] = useState(true);

  useEffect(() => {
    if (alert && !alert.read_at) {
      markAlertRead(alert.id);
    }
  }, [alert]);

  if (!alert || !alert.message) {
    return (
      <PageShell title="장중 알림" width="narrow">
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <BellOff size={36} className="text-ink-48" />
          <p className="text-[17px] font-semibold">오늘 발동된 알림이 없습니다</p>
          <p className="text-[15px] text-ink-48">
            위험선 조건이 충족되면 이메일 또는 앱 내 알림으로 알려드립니다.
          </p>
          <Button variant="secondary" onClick={() => router.push("/positions/risk-line")}>
            위험선 설정 확인
          </Button>
        </div>
        <Disclaimer />
      </PageShell>
    );
  }

  const msg = alert.message;
  const stage = alert.market_snapshot?.stage ?? "판단 중";
  const nonCompliance = msg.nonCompliance;

  return (
    <PageShell title="장중 알림" width="narrow">
      <div className="overflow-hidden rounded-[18px] border border-hairline">
        {/* 헤더 */}
        <div className="flex items-center justify-between bg-ink px-5 py-4 text-white">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-guard-on-dark" />
            <span className="text-[17px] font-semibold">{msg.subject.replace(/^\[.*?\]\s*/, "")}</span>
          </div>
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[12px]">
            {SEVERITY_LABEL[alert.severity] ?? alert.severity}
          </span>
        </div>

        <div className="space-y-5 p-5">
          {/* 장세 */}
          <p className="text-[14px] text-ink-48">현재 장세: {stage}</p>

          {/* 행동 / 금지 */}
          <div className="space-y-2">
            <p className="text-[17px]">
              <span className="font-semibold">행동</span> · {msg.action}
            </p>
            <p className="text-[17px]">
              <span className="font-semibold">금지</span> · {msg.prohibition}
            </p>
          </div>

          {/* 이유 */}
          <div className="border-t border-divider pt-4">
            <SectionLabel>이유</SectionLabel>
            <ul className="space-y-1.5">
              {msg.reasons.map((r) => (
                <li key={r} className="flex gap-2 text-[16px]">
                  <span className="text-ink-48">·</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>

          {/* 미준수 리스크 */}
          <div className="rounded-[11px] border border-hairline bg-pearl">
            <button
              onClick={() => setOpenRisk((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-[15px] font-semibold">무시하면 생길 수 있는 리스크</span>
              {openRisk ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {openRisk && (
              <ol className="space-y-2 px-4 pb-4">
                {[
                  { k: "원인", v: nonCompliance.cause },
                  { k: "취약 종목", v: nonCompliance.vulnerableTicker },
                  { k: "손실 결과", v: nonCompliance.lossOutcome },
                  { k: "확인할 지표", v: nonCompliance.indicatorsToCheck },
                ].map((n, i) => (
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
            )}
          </div>

          {/* 버핏식 관점 */}
          <Card className="!rounded-[11px] !border-hairline !bg-parchment">
            <p className="text-[14px] font-semibold text-ink-48">버핏식 원칙 관점 · 대조 관점</p>
            <p className="mt-1.5 text-[16px] leading-snug">{msg.buffett}</p>
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
