"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../_components/Shell";
import { Button } from "../_components/Button";
import { Card, SectionLabel } from "../_components/primitives";
import { TODAY } from "../_data/mock";

const actions = ["축소했다", "유지했다", "추가 매수했다", "전량 매도했다"];
const followLevels = ["따름", "일부 따름", "따르지 않음"];
const results = [
  { label: "당일", value: "+2.1%" },
  { label: "다음날", value: "-6.8%" },
  { label: "3거래일", value: "-9.4%" },
  { label: "1주일", value: "—" },
];

export default function JournalPage() {
  const router = useRouter();
  const [action, setAction] = useState(2);
  const [follow, setFollow] = useState(2);

  return (
    <PageShell title="행동 기록" width="narrow">
      <h2 className="text-[21px] font-semibold tracking-[0.231px]">{TODAY} 행동 기록</h2>

      <Card className="mt-4 !bg-parchment">
        <SectionLabel>스탁가드 안내</SectionLabel>
        <p className="text-[16px]">SOXL: 레버리지 축소 원칙 해당</p>
        <p className="text-[16px] text-ink-80">금지: 손실 만회성 추가 매수 금지</p>
      </Card>

      <div className="mt-5">
        <SectionLabel>내가 실제 한 행동</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((a, i) => (
            <button
              key={a}
              onClick={() => setAction(i)}
              className={`rounded-[11px] border px-4 py-3 text-left text-[15px] ${
                action === i ? "border-guard bg-pearl" : "border-hairline"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <SectionLabel>따른 정도</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {followLevels.map((f, i) => (
            <button
              key={f}
              onClick={() => setFollow(i)}
              className={`rounded-full border px-4 py-2 text-[15px] ${
                follow === i ? "border-guard text-guard" : "border-hairline text-ink-80"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <textarea
          defaultValue="장중 반등이 강해 보여서"
          rows={2}
          placeholder="행동 이유를 적어주세요"
          className="mt-3 w-full rounded-[11px] border border-hairline p-3 text-[15px] outline-none focus:border-guard"
        />
      </div>

      <div className="mt-5">
        <SectionLabel>결과 기록</SectionLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {results.map((r) => (
            <div key={r.label} className="rounded-[11px] border border-hairline p-3 text-center">
              <p className="text-[12px] text-ink-48">{r.label}</p>
              <p className="mt-0.5 text-[17px] font-semibold tabular-nums">{r.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[13px] text-ink-48">
          결과는 직접 입력할 수 있고, 가격 데이터가 연결되면 자동 계산합니다.
        </p>
      </div>

      <div className="mt-6">
        <Button variant="primary" size="lg" onClick={() => router.push("/journal/gap-report")}>
          기록 저장
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
