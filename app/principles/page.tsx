"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { PageShell, Disclaimer } from "../_components/Shell";
import { Button } from "../_components/Button";
import { principles as seed } from "../_data/mock";

export default function PrinciplesPage() {
  const router = useRouter();
  const [items, setItems] = useState(seed);
  const [saved, setSaved] = useState(false);

  function toggle(id: string) {
    setItems((is) => is.map((p) => (p.id === id ? { ...p, on: !p.on } : p)));
  }

  return (
    <PageShell title="매매 원칙" width="narrow">
      <h2 className="text-[17px] font-semibold">내 원칙</h2>
      <p className="mt-1 text-[15px] text-ink-48">
        위험 상황에서 스탁가드가 이 문장으로 알려드립니다.
      </p>

      <div className="mt-5 space-y-2.5">
        {items.map((p) => (
          <div
            key={p.id}
            className={`rounded-[18px] border p-4 ${
              p.active ? "border-guard bg-pearl" : "border-hairline"
            }`}
          >
            <button onClick={() => toggle(p.id)} className="flex w-full items-start gap-3 text-left">
              <span
                className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] border ${
                  p.on ? "border-guard bg-guard text-white" : "border-hairline"
                }`}
              >
                {p.on ? <Check size={13} /> : null}
              </span>
              <span className="text-[16px] leading-snug">{p.label}</span>
            </button>
            {p.active ? (
              <p className="ml-8 mt-1.5 text-[13px] font-semibold text-guard">
                지금 이 원칙에 해당합니다
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            setSaved(true);
            setTimeout(() => router.push("/briefing"), 900);
          }}
        >
          {saved ? "저장됐습니다 →" : "저장하기"}
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
