import YahooFinance from "yahoo-finance2";
import type { MarketData, QuoteData } from "./types";
import { getYahooSymbol } from "../positions";

// deprecated static method 대신 인스턴스 사용 (static quote()는 never를 반환)
const yf = new YahooFinance();

export type PositionQuote = {
  ticker: string;       // 사용자가 입력한 원래 이름/티커
  symbol: string | null; // 해석된 Yahoo 심볼
  price: number | null;
  changePercent: number | null;
  currency: string | null;
};

// 한국 거래소 코드 (KOSPI=KSC, KOSDAQ=KOE/KOQ)
const KR_EXCHANGES = new Set(["KSC", "KOE", "KOQ"]);

// Yahoo 검색으로 종목명 → 심볼 해석 (매핑 실패 시 폴백)
async function resolveSymbolBySearch(query: string): Promise<string | null> {
  try {
    const r = await yf.search(query, { quotesCount: 6, newsCount: 0 });
    const quotes = (r.quotes ?? []).filter(
      (q): q is typeof q & { symbol: string } => "symbol" in q && !!q.symbol,
    );
    if (quotes.length === 0) return null;

    // 한국 거래소(.KS/.KQ) 결과 우선
    const kr = quotes.find(
      (q) =>
        ("exchange" in q && KR_EXCHANGES.has(String(q.exchange))) ||
        /\.(KS|KQ)$/.test(q.symbol),
    );
    if (kr) return kr.symbol;

    // 주식/ETF 타입 우선
    const equity = quotes.find(
      (q) => "quoteType" in q && (q.quoteType === "EQUITY" || q.quoteType === "ETF"),
    );
    return (equity ?? quotes[0]).symbol;
  } catch {
    return null;
  }
}

async function fetchOneQuote(
  ticker: string,
  knownSymbol?: string | null,
): Promise<PositionQuote> {
  // 0단계: 자동완성으로 이미 확정된 심볼이 있으면 그대로 사용
  let symbol = knownSymbol?.trim() || getYahooSymbol(ticker);

  // 3단계: 검색 폴백
  if (!symbol) {
    symbol = await resolveSymbolBySearch(ticker);
  }

  if (!symbol) {
    return { ticker, symbol: null, price: null, changePercent: null, currency: null };
  }

  try {
    const r = await yf.quote(symbol);
    return {
      ticker,
      symbol,
      price: r.regularMarketPrice ?? null,
      changePercent: r.regularMarketChangePercent ?? null,
      currency: r.currency ?? null,
    };
  } catch {
    return { ticker, symbol, price: null, changePercent: null, currency: null };
  }
}

// 사용자 보유 종목들의 실시간 시세를 조회한다 (한국·미국 모두 지원)
// 입력은 종목명 문자열 배열 또는 {ticker, symbol} 객체 배열 모두 허용
export async function fetchPositionQuotes(
  positions: string[] | { ticker: string; symbol?: string | null }[],
): Promise<PositionQuote[]> {
  const normalized = positions.map((p) =>
    typeof p === "string" ? { ticker: p.trim(), symbol: null } : { ticker: p.ticker.trim(), symbol: p.symbol ?? null },
  );

  // ticker 기준 중복 제거
  const seen = new Set<string>();
  const unique = normalized.filter((p) => {
    if (!p.ticker || seen.has(p.ticker)) return false;
    seen.add(p.ticker);
    return true;
  });

  return Promise.all(unique.map((p) => fetchOneQuote(p.ticker, p.symbol)));
}

const SYMBOLS = {
  sp500: "^GSPC",
  nasdaq: "^NDX",
  sox: "^SOX",
  kospi: "^KS11",
  usdkrw: "USDKRW=X",
  oil: "CL=F",
  treasury10y: "^TNX",
} as const;

async function fetchQuote(symbol: string): Promise<QuoteData> {
  try {
    const result = await yf.quote(symbol);

    return {
      symbol,
      price: result.regularMarketPrice ?? null,
      previousClose: result.regularMarketPreviousClose ?? null,
      changePercent: result.regularMarketChangePercent ?? null,
    };
  } catch {
    return { symbol, price: null, previousClose: null, changePercent: null };
  }
}

async function fetchFredRate(): Promise<number | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;

  try {
    const url =
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10` +
      `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=2`;
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = (await res.json()) as { observations: { value: string }[] };
    const latest = parseFloat(data.observations[0]?.value ?? "");
    return isNaN(latest) ? null : latest;
  } catch {
    return null;
  }
}

export async function fetchMarketData(): Promise<MarketData> {
  const [sp500, nasdaq, sox, kospi, usdkrw, oil, treasury10y, fredRate] =
    await Promise.all([
      fetchQuote(SYMBOLS.sp500),
      fetchQuote(SYMBOLS.nasdaq),
      fetchQuote(SYMBOLS.sox),
      fetchQuote(SYMBOLS.kospi),
      fetchQuote(SYMBOLS.usdkrw),
      fetchQuote(SYMBOLS.oil),
      fetchQuote(SYMBOLS.treasury10y),
      fetchFredRate(),
    ]);

  // FRED 금리가 있으면 Yahoo ^TNX 값 교체
  if (fredRate !== null && treasury10y.price !== null) {
    const prevRate = treasury10y.previousClose ?? treasury10y.price;
    treasury10y.previousClose = prevRate;
    treasury10y.price = fredRate;
    treasury10y.changePercent =
      prevRate !== 0 ? ((fredRate - prevRate) / prevRate) * 100 : 0;
  }

  return {
    sp500,
    nasdaq,
    sox,
    kospi,
    usdkrw,
    oil,
    treasury10y,
    fetchedAt: new Date().toISOString(),
  };
}
