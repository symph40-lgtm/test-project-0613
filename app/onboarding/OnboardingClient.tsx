"use client";

import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { PageShell, Disclaimer } from "../_components/Shell";
import { Button } from "../_components/Button";
import { TickerInput } from "../_components/TickerInput";
import { savePositions, type SavePositionsRow } from "./actions";

type Market = "kr" | "us";

type Row = {
  id: number;
  ticker: string;
  symbol: string | null;
  weight: string;
  leverage: boolean;
  market: Market;
};

const MAX_ROWS = 15;

const SECTIONS: { market: Market; label: string }[] = [
  { market: "kr", label: "국내장 (한국)" },
  { market: "us", label: "해외장 (미국 등)" },
];

let nextId = 100;

// 종목명/코드로 국내·해외 추정 (한글이거나 6자리 코드면 국내)
function inferMarket(ticker: string): Market {
  return /[가-힣]/.test(ticker) || /^\d{6}$/.test(ticker.trim()) ? "kr" : "us";
}

function toClientRows(
  initial: { ticker: string; weight: number; is_leverage: boolean }[],
): Row[] {
  if (initial.length === 0) {
    return [];
  }
  return initial.map((p, i) => ({
    id: i + 1,
    ticker: p.ticker,
    symbol: null,
    weight: String(p.weight),
    leverage: p.is_leverage,
    market: inferMarket(p.ticker),
  }));
}

export default function OnboardingClient({
  initialPositions,
}: {
  initialPositions: { ticker: string; weight: number; is_leverage: boolean }[];
}) {
  const [rows, setRows] = useState<Row[]>(() => toClientRows(initialPositions));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const total = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const empty = rows.length === 0;

  function update(id: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function add(market: Market) {
    if (rows.length >= MAX_ROWS) return;
    setRows((rs) => [
      ...rs,
      { id: nextId++, ticker: "", symbol: null, weight: "", leverage: false, market },
    ]);
  }
  function remove(id: number) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  function renderRow(r: Row) {
    return (
      <div key={r.id} className="flex items-center gap-2">
        <TickerInput
          value={r.ticker}
          symbol={r.symbol}
          onChange={(name, sym) => update(r.id, { ticker: name, symbol: sym })}
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
            r.leverage ? "border-guard bg-guard text-white" : "border-hairline text-ink-80"
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
    );
  }

  function handleSubmit() {
    setError(null);
    const payload: SavePositionsRow[] = rows.map((r) => ({
      ticker: r.ticker,
      symbol: r.symbol,
      weight: r.weight,
      leverage: r.leverage,
    }));

    startTransition(async () => {
      try {
        await savePositions(payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : "저장 중 오류가 발생했습니다.");
      }
    });
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
          <span className="text-[13px] text-ink-48">{rows.length} / {MAX_ROWS}</span>
        </div>

        {empty && (
          <p className="mb-4 rounded-[11px] border border-hairline bg-pearl p-4 text-center text-[15px]">
            종목명과 비중만 입력해도 첫 판단을 시작할 수 있습니다. 아래에서 국내·해외로 나눠 추가하세요.
          </p>
        )}

        <div className="space-y-6">
          {SECTIONS.map(({ market, label }) => {
            const list = rows.filter((r) => r.market === market);
            return (
              <div key={market}>
                <h4 className="mb-2 text-[13px] font-semibold text-ink-80">{label}</h4>
                <div className="space-y-2.5">
                  {list.map(renderRow)}
                  <button
                    onClick={() => add(market)}
                    disabled={rows.length >= MAX_ROWS}
                    className="flex items-center gap-1.5 px-1 py-2 text-[15px] text-guard disabled:text-ink-48"
                  >
                    <Plus size={16} /> {label.split(" ")[0]} 종목 추가
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {total > 100 ? (
          <p className="mt-2 text-[13px] text-ink-80">
            비중 합이 {total}%입니다. 합이 100%를 넘어도 판단은 시작할 수 있지만, 비중을
            확인해 주세요.
          </p>
        ) : null}

        {error ? (
          <p className="mt-2 text-[13px] text-red-500">{error}</p>
        ) : null}
      </div>

      <div className="mt-8 flex flex-col items-stretch gap-2 sm:items-end">
        <Button
          variant="hero"
          size="lg"
          disabled={empty || isPending}
          onClick={handleSubmit}
        >
          {isPending ? "저장 중…" : "오늘 판단 보기"}
        </Button>
        <span className="text-[13px] text-ink-48 sm:text-right">
          손익률·현재가·알림 연락처는 나중에 보완해도 됩니다.
        </span>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
