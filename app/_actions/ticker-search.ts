"use server";

import YahooFinance from "yahoo-finance2";
import { searchLocalTickers } from "@/lib/positions";

const yf = new YahooFinance();

export type TickerCandidate = {
  symbol: string;   // Yahoo 심볼 (예: 005930.KS, NVDA)
  name: string;     // 표시용 종목명
  exchange: string; // 거래소 표시명 (KOSPI/KOSDAQ/NASDAQ 등)
};

// Yahoo 거래소 코드 → 표시명
const EXCHANGE_LABEL: Record<string, string> = {
  KSC: "KOSPI",
  KOE: "KOSDAQ",
  KOQ: "KOSDAQ",
  NMS: "NASDAQ",
  NGM: "NASDAQ",
  NYQ: "NYSE",
  PCX: "NYSE Arca",
  ASE: "AMEX",
  HKG: "홍콩",
  TYO: "도쿄",
};

async function fetchYahooCandidates(q: string): Promise<TickerCandidate[]> {
  try {
    const r = await yf.search(q, { quotesCount: 10, newsCount: 0 });
    const quotes = (r.quotes ?? []).filter(
      (x): x is typeof x & { symbol: string } => "symbol" in x && !!x.symbol,
    );

    return quotes
      .filter((x) => {
        const t = "quoteType" in x ? x.quoteType : "";
        return t === "EQUITY" || t === "ETF" || t === "MUTUALFUND" || t === "INDEX";
      })
      .map((x) => {
        const exchangeCode = "exchange" in x ? String(x.exchange) : "";
        const name =
          ("shortname" in x && x.shortname) ||
          ("longname" in x && x.longname) ||
          x.symbol;
        return {
          symbol: x.symbol,
          name: String(name),
          exchange: EXCHANGE_LABEL[exchangeCode] ?? exchangeCode,
        };
      });
  } catch {
    // Yahoo는 순수 한글 쿼리를 거부할 수 있음 → 빈 배열
    return [];
  }
}

export async function searchTickers(query: string): Promise<TickerCandidate[]> {
  const q = query.trim();
  if (q.length < 1) return [];

  // 1) 로컬 사전 (순수 한글도 동작) + 2) Yahoo 검색 (영문/ETF/미국주) 병합
  const [local, yahoo] = await Promise.all([
    Promise.resolve(searchLocalTickers(q)),
    fetchYahooCandidates(q),
  ]);

  const merged: TickerCandidate[] = [...local];
  for (const c of yahoo) {
    if (!merged.some((m) => m.symbol === c.symbol)) merged.push(c);
  }

  // 한국 거래소를 상단으로
  merged.sort((a, b) => {
    const ak = a.symbol.endsWith(".KS") || a.symbol.endsWith(".KQ") ? 0 : 1;
    const bk = b.symbol.endsWith(".KS") || b.symbol.endsWith(".KQ") ? 0 : 1;
    return ak - bk;
  });

  return merged.slice(0, 8);
}
