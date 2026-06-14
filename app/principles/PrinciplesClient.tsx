"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "../_components/Button";
import { savePrinciples, type PrincipleRow, type PrincipleKey } from "./actions";

export default function PrinciplesClient({
  initialItems,
}: {
  initialItems: PrincipleRow[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: PrincipleKey) {
    setItems((is) => is.map((p) => (p.id === id ? { ...p, on: !p.on } : p)));
  }

  function handleSave() {
    setError(null);
    const selections = Object.fromEntries(
      items.map((p) => [p.id, p.on]),
    ) as Record<PrincipleKey, boolean>;

    startTransition(async () => {
      const result = await savePrinciples(selections);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => router.push("/briefing"), 900);
      }
    });
  }

  return (
    <>
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
            <button
              onClick={() => toggle(p.id)}
              className="flex w-full items-start gap-3 text-left"
            >
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

      {error ? (
        <p className="mt-3 text-[13px] text-red-500">{error}</p>
      ) : null}

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          disabled={isPending}
          onClick={handleSave}
        >
          {saved ? "저장됐습니다 →" : isPending ? "저장 중…" : "저장하기"}
        </Button>
      </div>
    </>
  );
}
