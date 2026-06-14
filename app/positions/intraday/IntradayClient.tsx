"use client";

import { useState, useTransition } from "react";
import { X, Plus } from "lucide-react";
import { Button } from "../../_components/Button";
import { SectionLabel, StateNote } from "../../_components/primitives";
import { applyFills, type Fill, type FillType } from "./actions";

type ClientFill = Fill & { id: number };

let nextId = 10;

const typeStyle: Record<FillType, string> = {
  매도: "bg-ink text-white",
  매수: "bg-guard text-white",
  신규: "bg-pearl text-ink border border-hairline",
};

export default function IntradayClient({
  initialPositions,
}: {
  initialPositions: { ticker: string; weight: number; is_leverage: boolean }[];
}) {
  const [fills, setFills] = useState<ClientFill[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [previewPositions] = useState(initialPositions);
  const empty = fills.length === 0;

  function addFill() {
    setFills((f) => [...f, { id: nextId++, type: "매수", ticker: "", detail: "" }]);
  }

  function update(id: number, patch: Partial<ClientFill>) {
    setFills((f) => f.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  function remove(id: number) {
    setFills((f) => f.filter((x) => x.id !== id));
  }

  function handleSubmit() {
    setError(null);
    const payload: Fill[] = fills.map(({ type, ticker, detail }) => ({
      type,
      ticker,
      detail,
    }));

    startTransition(async () => {
      try {
        await applyFills(payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : "저장 중 오류가 발생했습니다.");
      }
    });
  }

  return (
    <>
      <SectionLabel>오늘 체결한 내용</SectionLabel>
      {empty ? (
        <StateNote title="오늘 체결한 내용을 입력하면 최신 기준으로 다시 판단합니다.">
          매도·매수·신규 진입을 추가해 보세요.
        </StateNote>
      ) : (
        <div className="space-y-2">
          {fills.map((f) => (
            <div key={f.id} className="flex items-center gap-2">
              <select
                value={f.type}
                onChange={(e) => update(f.id, { type: e.target.value as FillType })}
                className={`h-11 shrink-0 rounded-[8px] px-2 text-[13px] font-semibold ${typeStyle[f.type]}`}
              >
                <option>매도</option>
                <option>매수</option>
                <option>신규</option>
              </select>
              <input
                value={f.ticker}
                onChange={(e) => update(f.id, { ticker: e.target.value })}
                placeholder="종목명"
                className="h-11 flex-1 rounded-[8px] border border-hairline px-3 text-[16px] outline-none focus:border-guard"
              />
              <input
                value={f.detail}
                onChange={(e) => update(f.id, { detail: e.target.value })}
                placeholder="수량 / 비중 (예: 비중 8%, 50% 축소)"
                className="h-11 w-44 rounded-[8px] border border-hairline px-3 text-[15px] outline-none focus:border-guard"
              />
              <button
                onClick={() => remove(f.id)}
                aria-label="체결 삭제"
                className="grid size-9 shrink-0 place-items-center rounded-full text-ink-48 hover:bg-divider"
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={addFill}
        className="mt-2 flex items-center gap-1.5 px-1 py-2 text-[15px] text-guard"
      >
        <Plus size={16} /> 체결 추가
      </button>

      {error ? (
        <p className="mt-2 text-[13px] text-red-500">{error}</p>
      ) : null}

      {!empty ? (
        <div className="mt-6 rounded-[18px] border border-hairline bg-pearl p-5">
          <SectionLabel>현재 주요 포지션</SectionLabel>
          <ul className="divide-y divide-divider">
            {previewPositions.map((p) => (
              <li key={p.ticker} className="flex items-center justify-between py-2 text-[16px]">
                <span className="font-semibold">{p.ticker}</span>
                <span className="text-ink-80">
                  {p.weight}% · {p.is_leverage ? "레버리지" : "일반"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-ink-48">
            제출 후 포지션이 체결 내용에 따라 갱신됩니다.
          </p>
        </div>
      ) : null}

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          disabled={empty || isPending}
          onClick={handleSubmit}
        >
          {isPending ? "처리 중…" : "최신 상태로 다시 판단"}
        </Button>
      </div>

      <p className="mt-3 text-[13px] text-ink-48">
        v1에서는 체결을 직접 입력합니다. 이후 증권 계좌 연동이 생기면 자동 반영합니다.
      </p>
    </>
  );
}
