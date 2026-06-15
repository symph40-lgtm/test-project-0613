"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { searchTickers, type TickerCandidate } from "../_actions/ticker-search";

export function TickerInput({
  value,
  symbol,
  onChange,
  placeholder = "종목명 검색 (예: 삼성전자, NVDA)",
  autoFocus,
  className = "",
}: {
  value: string;
  symbol?: string | null;
  // name: 표시 종목명, sym: 확정된 Yahoo 심볼(직접 입력 시 null)
  onChange: (name: string, sym: string | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<TickerCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 외부 클릭 시 닫기
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function handleInput(next: string) {
    onChange(next, null); // 직접 입력 중에는 심볼 미확정
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (next.trim().length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    setOpen(true);
    debounceRef.current = setTimeout(async () => {
      const res = await searchTickers(next);
      setResults(res);
      setLoading(false);
    }, 300);
  }

  function pick(c: TickerCandidate) {
    onChange(c.name, c.symbol);
    setOpen(false);
    setResults([]);
  }

  return (
    <div ref={boxRef} className="relative flex-1">
      <div className="relative">
        <input
          value={value}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={`h-11 w-full rounded-[8px] border border-hairline px-3 pr-8 text-[16px] outline-none focus:border-guard ${className}`}
        />
        {symbol ? (
          <Check
            size={16}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-guard"
          />
        ) : loading ? (
          <Loader2
            size={15}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-48"
          />
        ) : null}
      </div>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-64 overflow-auto rounded-[10px] border border-hairline bg-canvas shadow-lg">
          {loading && results.length === 0 ? (
            <div className="px-3 py-3 text-[14px] text-ink-48">검색 중…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-[14px] text-ink-48">
              검색 결과가 없습니다. 직접 입력해도 됩니다.
            </div>
          ) : (
            results.map((c) => (
              <button
                key={c.symbol}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-pearl"
              >
                <span className="min-w-0 flex-1 truncate text-[15px]">{c.name}</span>
                <span className="shrink-0 text-[12px] text-ink-48">
                  {c.exchange} · {c.symbol}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
