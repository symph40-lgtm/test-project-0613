"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel } from "../../_components/primitives";
import { riskLines } from "../../_data/mock";

export default function RiskLinePage() {
  const router = useRouter();
  const [lines, setLines] = useState(riskLines);
  const [emailVerified, setEmailVerified] = useState(true);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [applied, setApplied] = useState(false);

  function toggle(id: string) {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, on: !l.on } : l)));
  }

  return (
    <PageShell title="위험선 / 알림 설정" width="narrow">
      <Card>
        <p className="text-[17px] font-semibold">SOXL 위험선 추천</p>
        <p className="mt-1 text-[14px] text-ink-48">
          현재 장세: 변동장 3단계 · 레버리지 적합도: 낮음
        </p>

        <div className="mt-5">
          <SectionLabel>추천 알림</SectionLabel>
          <p className="-mt-2 mb-3 text-[13px] text-ink-48">
            선택한 조건에 닿으면 저장한 원칙을 함께 알려드립니다.
          </p>
          <div className="space-y-2">
            {lines.map((l) => (
              <button
                key={l.id}
                onClick={() => toggle(l.id)}
                className={`flex w-full items-center gap-3 rounded-full border px-4 py-2.5 text-left text-[15px] ${
                  l.on ? "border-guard text-ink" : "border-hairline text-ink-80"
                }`}
              >
                <span
                  className={`grid size-5 place-items-center rounded-full border ${
                    l.on ? "border-guard bg-guard text-white" : "border-hairline"
                  }`}
                >
                  {l.on ? <Check size={13} /> : null}
                </span>
                {l.label}
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

      <Card className="mt-4">
        <SectionLabel>알림 채널</SectionLabel>
        <ChannelRow
          label="휴대폰"
          value="010-0000-0000"
          verified={phoneVerified}
          onVerify={() => setPhoneVerified(true)}
        />
        <ChannelRow
          label="이메일"
          value="hong@example.com"
          verified={emailVerified}
          onVerify={() => setEmailVerified(true)}
        />
        {!phoneVerified ? (
          <p className="mt-3 text-[13px] text-ink-48">
            인증 전에는 외부 발송 대신 앱 내 알림으로만 안내합니다.
          </p>
        ) : null}
      </Card>

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            setApplied(true);
            setTimeout(() => router.push("/principles"), 900);
          }}
        >
          {applied ? "적용됐습니다 →" : "적용하기"}
        </Button>
        {applied ? (
          <p className="mt-3 text-[14px] text-ink-80">
            위험선이 적용됐습니다. 이제 이 조건에 닿으면 원칙을 함께 알려드립니다.
          </p>
        ) : null}
      </div>

      <Disclaimer />
    </PageShell>
  );
}

function ChannelRow({
  label,
  value,
  verified,
  onVerify,
}: {
  label: string;
  value: string;
  verified: boolean;
  onVerify: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="w-14 shrink-0 text-[14px] text-ink-48">{label}</span>
      <span className="flex-1 text-[15px]">{value}</span>
      {verified ? (
        <span className="flex items-center gap-1 text-[13px] text-guard">
          <Check size={14} /> 인증완료
        </span>
      ) : (
        <Button variant="secondary" onClick={onVerify} className="!px-4 !py-1.5 !text-[14px]">
          인증
        </Button>
      )}
    </div>
  );
}
