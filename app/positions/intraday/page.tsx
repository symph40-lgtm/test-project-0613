"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Plus } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { SectionLabel, StateNote } from "../../_components/primitives";

type FillType = "매도" | "매수" | "신규";
type Fill = { id: number; type: FillType; ticker: string; detail: string };

let nextId = 4;
const initial: Fill[] = [
  { id: 1, type: "매도", ticker: "SOXL", detail: "50% 축소" },
  { id: 2, type: "매수", ticker: "삼성전자", detail: "10주 추가" },
  { id: 3, type: "신규", ticker: "한화에어로", detail: "비중 8%" },
];

const afterPositions = [
  { ticker: "삼성전자", weight: 34, leverage: false },
  { ticker: "SOXL", weight: 10, leverage: true },
  { ticker: "한화에어로", weight: 8, leverage: false },
];

const typeStyle: Record<FillType, string> = {
  매도: "bg-ink text-white",
  매수: "bg-guard text-white",
  신규: "bg-pearl text-ink border border-hairline",
};

export default function IntradayPositionPage() {
  const router = useRouter();
  const [fills, setFills] = useState<Fill[]>(initial);
  const empty = fills.length === 0;

  function addFill() {
    setFills((f) => [...f, { id: nextId++, type: "매수", ticker: "", detail: "" }]);
  }
  function update(id: number, patch: Partial<Fill>) {
    setFills((f) => f.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  function remove(id: number) {
    setFills((f) => f.filter((x) => x.id !== id));
  }

  return (
    <PageShell title="장중 포지션 변경" width="narrow">
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
                placeholder="수량 / 비중"
                className="h-11 w-28 rounded-[8px] border border-hairline px-3 text-[15px] outline-none focus:border-guard"
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
      <button onClick={addFill} className="mt-2 flex items-center gap-1.5 px-1 py-2 text-[15px] text-guard">
        <Plus size={16} /> 체결 추가
      </button>

      {!empty ? (
        <div className="mt-6 rounded-[18px] border border-hairline bg-pearl p-5">
          <SectionLabel>변경 후 주요 포지션</SectionLabel>
          <ul className="divide-y divide-divider">
            {afterPositions.map((p) => (
              <li key={p.ticker} className="flex items-center justify-between py-2 text-[16px]">
                <span className="font-semibold">{p.ticker}</span>
                <span className="text-ink-80">
                  {p.weight}% · {p.leverage ? "레버리지" : "일반"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          disabled={empty}
          onClick={() => router.push("/briefing")}
        >
          최신 상태로 다시 판단
        </Button>
      </div>

      <p className="mt-3 text-[13px] text-ink-48">
        v1에서는 체결을 직접 입력합니다. 이후 증권 계좌 연동이 생기면 자동 반영합니다.
      </p>
      <Disclaimer />
    </PageShell>
  );
}
