import YahooFinance from "yahoo-finance2";
import type { MarketData, QuoteData } from "./types";
import { getYahooSymbol } from "../positions";

// deprecated static method 대신 인스턴스 사용 (static quote()는 never를 반환)
const yf = new YahooFinance();

export type PositionQuote = {
  ticker: string;       // 사용자가 입력한 원래 이름/티커
  symbol: string;       // Yahoo 심볼
  price: number | null;
  changePercent: number | null;
  currency: string | null;
};

// 사용자 보유 종목들의 실시간 시세를 조회한다 (한국·미국 모두 지원)
export async function fetchPositionQuotes(
  tickers: string[],
): Promise<PositionQuote[]> {
  const unique = [...new Set(tickers.map((t) => t.trim()).filter(Boolean))];

  const results = await Promise.all(
    unique.map(async (ticker): Promise<PositionQuote> => {
      const symbol = getYahooSymbol(ticker);
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
    }),
  );

  return results;
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
