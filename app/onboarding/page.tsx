"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { PageShell, Disclaimer } from "../_components/Shell";
import { Button } from "../_components/Button";

type Row = { id: number; ticker: string; weight: string; leverage: boolean };

let nextId = 4;

const initialRows: Row[] = [
  { id: 1, ticker: "삼성전자", weight: "30", leverage: false },
  { id: 2, ticker: "SOXL", weight: "20", leverage: true },
  { id: 3, ticker: "SK하이닉스", weight: "15", leverage: false },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initialRows);

  const total = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const empty = rows.length === 0;

  function update(id: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function add() {
    if (rows.length >= 10) return;
    setRows((rs) => [...rs, { id: nextId++, ticker: "", weight: "", leverage: false }]);
  }
  function remove(id: number) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  return (
    <PageShell title="빠른 등록" width="narrow">
      <h2 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.374px] headline-tight">
        오늘 장에서 무엇을 줄이고
        <br />
        무엇을 하지 말아야 할지 먼저 봅니다.
      </h2>

      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-ink-48">주요 보유 종목</h3>
          <span className="text-[13px] text-ink-48">{rows.length} / 10</span>
        </div>

        {empty ? (
          <div className="rounded-[11px] border border-hairline bg-pearl p-5 text-center">
            <p className="text-[15px]">
              종목명과 비중만 입력해도 첫 판단을 시작할 수 있습니다.
            </p>
            <Button variant="secondary" className="mt-3" onClick={add}>
              <Plus size={16} /> 종목 추가
            </Button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2">
                <input
                  value={r.ticker}
                  onChange={(e) => update(r.id, { ticker: e.target.value })}
                  placeholder="종목명"
                  className="h-11 flex-1 rounded-[8px] border border-hairline px-3 text-[16px] outline-none focus:border-guard"
                />
                <div className="relative w-24">
                  <input
                    value={r.weight}
                    onChange={(e) => update(r.id, { weight: e.target.value.replace(/\D/g, "") })}
                    placeholder="비중"
                    inputMode="numeric"
                    className="h-11 w-full rounded-[8px] border border-hairline pl-3 pr-7 text-[16px] outline-none focus:border-guard"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[14px] text-ink-48">
                    %
                  </span>
                </div>
                <button
                  onClick={() => update(r.id, { leverage: !r.leverage })}
                  className={`h-11 shrink-0 rounded-[8px] border px-3 text-[13px] ${
                    r.leverage
                      ? "border-guard bg-guard text-white"
                      : "border-hairline text-ink-80"
                  }`}
                >
                  {r.leverage ? "레버리지" : "일반"}
                </button>
                <button
                  onClick={() => remove(r.id)}
                  aria-label="종목 삭제"
                  className="grid size-9 shrink-0 place-items-center rounded-full text-ink-48 hover:bg-divider"
                >
                  <X size={16} />
                </button>
              </div>
            ))}

            <button
              onClick={add}
              disabled={rows.length >= 10}
              className="flex items-center gap-1.5 px-1 py-2 text-[15px] text-guard disabled:text-ink-48"
            >
              <Plus size={16} /> 종목 추가
            </button>
          </div>
        )}

        {total > 100 ? (
          <p className="mt-2 text-[13px] text-ink-80">
            비중 합이 {total}%입니다. 합이 100%를 넘어도 판단은 시작할 수 있지만, 비중을
            확인해 주세요.
          </p>
        ) : null}
      </div>

      <div className="mt-8 flex flex-col items-stretch gap-2 sm:items-end">
        <Button
          variant="hero"
          size="lg"
          disabled={empty}
          onClick={() => router.push("/briefing")}
        >
          오늘 판단 보기
        </Button>
        <span className="text-[13px] text-ink-48 sm:text-right">
          손익률·현재가·알림 연락처는 나중에 보완해도 됩니다.
        </span>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
