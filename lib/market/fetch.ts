import YahooFinance from "yahoo-finance2";
import type { MarketData, QuoteData } from "./types";
import { getYahooSymbol } from "../positions";
import { toKrCode, fetchKoreanQuote, fetchKospi200Futures } from "./naver-flow";

// deprecated static method 대신 인스턴스 사용 (static quote()는 never를 반환)
const yf = new YahooFinance();

export type PositionQuote = {
  ticker: string;       // 사용자가 입력한 원래 이름/티커
  symbol: string | null; // 해석된 Yahoo 심볼
  price: number | null;
  changePercent: number | null;
  currency: string | null;
  session?: string | null; // 현재 표시 시세의 세션 (프리장/애프터장/장전/시간외)
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
  const empty: PositionQuote = {
    ticker,
    symbol: null,
    price: null,
    changePercent: null,
    currency: null,
  };

  try {
    // 한국 종목이면 네이버 실시간 시세 우선 (야후 15분 지연 + 시간외 미제공 회피)
    const krCode = toKrCode(knownSymbol ?? null, ticker);
    if (krCode) {
      const kq = await fetchKoreanQuote(krCode);
      if (kq && kq.price !== null) {
        return {
          ticker,
          symbol: `${krCode}.KS`,
          price: kq.price,
          changePercent: kq.changePercent,
          currency: "KRW",
          session: kq.session,
        };
      }
      // 네이버 실패 시 야후로 폴백 (아래 계속)
    }

    // 0단계: 자동완성으로 이미 확정된 심볼이 있으면 그대로 사용
    let symbol = knownSymbol?.trim() || getYahooSymbol(ticker);

    // 3단계: 검색 폴백
    if (!symbol) {
      symbol = await resolveSymbolBySearch(ticker);
    }

    if (!symbol) return empty;

    const r = await yf.quote(symbol);
    const eff = effectiveQuote({
      price: r.regularMarketPrice ?? null,
      changePercent: r.regularMarketChangePercent ?? null,
      marketState: r.marketState ?? null,
      preMarketPrice: r.preMarketPrice ?? null,
      preMarketChangePercent: r.preMarketChangePercent ?? null,
      postMarketPrice: r.postMarketPrice ?? null,
      postMarketChangePercent: r.postMarketChangePercent ?? null,
    });
    return {
      ticker,
      symbol,
      price: eff.price,
      changePercent: eff.changePercent,
      currency: r.currency ?? null,
      session: eff.session,
    };
  } catch {
    return empty;
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
  // 나스닥100은 지수(^NDX) 대신 연속 선물(NQ=F)을 사용 — 프리/애프터장 포함 ~24시간 실시간.
  // 지수는 정규장 외 시간외 시세가 없어 전일 종가로 멈춰 보였음. NQ=F는 야후가 최근월물 자동 롤오버.
  nasdaq: "NQ=F",
  sox: "^SOX",
  kospi: "^KS11",
  usdkrw: "USDKRW=X",
  oil: "CL=F",
  treasury10y: "^TNX",
  // 변동성: S&P 기준 ^VIX 대신 나스닥100 변동성지수 ^VXN 사용 (보유 반도체·기술주와 더 직결)
  vix: "^VXN",
} as const;

async function fetchQuote(symbol: string): Promise<QuoteData> {
  try {
    const result = await yf.quote(symbol);

    const t = result.regularMarketTime;
    const marketTime =
      t instanceof Date ? Math.floor(t.getTime() / 1000) : typeof t === "number" ? t : null;

    return {
      symbol,
      price: result.regularMarketPrice ?? null,
      previousClose: result.regularMarketPreviousClose ?? null,
      changePercent: result.regularMarketChangePercent ?? null,
      marketState: result.marketState ?? null,
      preMarketPrice: result.preMarketPrice ?? null,
      preMarketChangePercent: result.preMarketChangePercent ?? null,
      postMarketPrice: result.postMarketPrice ?? null,
      postMarketChangePercent: result.postMarketChangePercent ?? null,
      marketTime,
    };
  } catch {
    return { symbol, price: null, previousClose: null, changePercent: null };
  }
}

// 마지막 체결이 너무 오래됐는지(주말·휴장으로 지난 종가에 멈춤) 판정.
// 18시간 기준: 평일 미국장 직전(전일 종가 ~17h)은 통과, 주말/휴장(40h+)은 stale.
const STALE_HOURS = 18;
function isStaleQuote(q: QuoteData): boolean {
  if (q.marketTime == null) return false;
  return Date.now() / 1000 - q.marketTime > STALE_HOURS * 3600;
}

// 현재 세션(프리장/애프터장/정규장)에 맞는 유효 시세 선택
export function effectiveQuote(q: {
  price: number | null;
  changePercent: number | null;
  marketState?: string | null;
  preMarketPrice?: number | null;
  preMarketChangePercent?: number | null;
  postMarketPrice?: number | null;
  postMarketChangePercent?: number | null;
}): { price: number | null; changePercent: number | null; session: "프리장" | "애프터장" | null } {
  const st = q.marketState ?? "";
  if (st === "PRE" && q.preMarketPrice != null) {
    return { price: q.preMarketPrice, changePercent: q.preMarketChangePercent ?? null, session: "프리장" };
  }
  if ((st === "POST" || st === "POSTPOST" || st === "CLOSED") && q.postMarketPrice != null) {
    return { price: q.postMarketPrice, changePercent: q.postMarketChangePercent ?? null, session: "애프터장" };
  }
  return { price: q.price, changePercent: q.changePercent, session: null };
}

// ─── 세션 인지형 주요 지표 ──────────────────────────────────────────
// 미국 주식형(나스닥·반도체)은 ETF로 정규/애프터/합계 분해, 나머지는 단일값+세션.
export type IndicatorSession = "프리" | "정규" | "애프터" | "야간" | "마감" | "상시";

export type MainIndicator = {
  key: string;
  label: string;
  unit: "" | "$" | "원" | "%";
  digits: number;
  mode: "single" | "breakdown"; // breakdown = 정규/애프터/합계 분해 표시
  session: IndicatorSession;
  show: boolean;                 // false = 표기 불필요(프리 이전 등)
  price: number | null;
  changePercent: number | null;  // single 모드: 현재 세션 등락
  regularChange?: number | null; // breakdown 전용
  afterChange?: number | null;
  totalChange?: number | null;   // 전일 종가 대비 현재(=정규+애프터 합산 효과)
};

// 미국 ETF: Yahoo marketState로 프리/정규/애프터를 구분해 표시 모드 결정
function usEquityIndicator(key: string, label: string, q: QuoteData): MainIndicator {
  const base = { key, label, unit: "$" as const, digits: 2 };
  const st = (q.marketState ?? "").toUpperCase();
  const reg = q.changePercent ?? null; // 정규장 등락

  // 정규장 진행 중 → 정규장 단일
  if (st === "REGULAR") {
    return { ...base, mode: "single", session: "정규", show: true, price: q.price, changePercent: reg };
  }
  // 정규장 이전(프리) → 프리마켓 (데이터 없으면 표기 불필요)
  if (st === "PRE") {
    if (q.preMarketPrice != null) {
      return { ...base, mode: "single", session: "프리", show: true, price: q.preMarketPrice, changePercent: q.preMarketChangePercent ?? null };
    }
    return { ...base, mode: "single", session: "프리", show: false, price: q.price, changePercent: reg };
  }
  // 정규장 끝남(애프터/마감) → 정규+애프터+합계 분해
  if ((st === "POST" || st === "POSTPOST" || st === "CLOSED") && q.postMarketPrice != null) {
    const total =
      q.previousClose && q.previousClose !== 0
        ? ((q.postMarketPrice - q.previousClose) / q.previousClose) * 100
        : reg;
    return {
      ...base,
      mode: "breakdown",
      session: "애프터",
      show: true,
      price: q.postMarketPrice,
      changePercent: q.postMarketChangePercent ?? null,
      regularChange: reg,
      afterChange: q.postMarketChangePercent ?? null,
      totalChange: total,
    };
  }
  // 프리 이전(PREPRE 등) 또는 시간외 데이터 없음 → 표기 불필요
  return { ...base, mode: "single", session: "마감", show: false, price: q.price, changePercent: reg };
}

// 코스피: KST 기준 세션만 표기(지수는 시간외 시세가 없어 분해하지 않음)
function koreanIndexIndicator(key: string, label: string, q: QuoteData, now: Date): MainIndicator {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay();
  const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  let session: IndicatorSession = "마감";
  if (day >= 1 && day <= 5) {
    if (t >= 8 * 60 + 30 && t < 9 * 60) session = "프리";
    else if (t >= 9 * 60 && t < 15 * 60 + 30) session = "정규";
  }
  return { key, label, unit: "", digits: 2, mode: "single", session, show: true, price: q.price, changePercent: q.changePercent };
}

// 24시간 거래(FX·선물·금리): 항상 표시, 세션은 '상시'
function alwaysOnIndicator(key: string, label: string, q: QuoteData, unit: MainIndicator["unit"], digits: number): MainIndicator {
  return { key, label, unit, digits, mode: "single", session: "상시", show: true, price: q.price, changePercent: q.changePercent };
}

// 코스피200 선물(네이버 FUT) — 야간 글로벌 세션 포함. 밤사이 한국장 선행 신호.
function futuresIndicator(f: Awaited<ReturnType<typeof fetchKospi200Futures>>): MainIndicator {
  const base = { key: "kospi200fut", label: "코스피200 선물", unit: "" as const, digits: 2, mode: "single" as const };
  if (!f || f.price === null) {
    return { ...base, session: "마감", show: false, price: null, changePercent: null };
  }
  return { ...base, session: f.session, show: true, price: f.price, changePercent: f.changePercent };
}

// 주요 지표 묶음 — 미국 주식형은 ETF(QQQ·SOXX)로 분해, 나머지는 기존 시세 재사용
export async function fetchMainIndicators(market: MarketData): Promise<MainIndicator[]> {
  const [qqq, soxx, fut] = await Promise.all([
    fetchQuote("QQQ"),
    fetchQuote("SOXX"),
    fetchKospi200Futures(),
  ]);
  const now = new Date();
  return [
    usEquityIndicator("nasdaq", "나스닥100 (QQQ)", qqq),
    usEquityIndicator("sox", "반도체 (SOXX)", soxx),
    koreanIndexIndicator("kospi", "코스피", market.kospi, now),
    futuresIndicator(fut),
    alwaysOnIndicator("usdkrw", "달러/원", market.usdkrw, "원", 1),
    alwaysOnIndicator("oil", "WTI 유가", market.oil, "$", 2),
    alwaysOnIndicator("treasury10y", "미국채 10Y 금리", market.treasury10y, "%", 2),
  ];
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

export type OffHoursQuote = {
  label: string;
  kind: "선물" | "ETF";
  price: number | null;
  changePercent: number | null;
  session: "프리장" | "애프터장" | null;
  // ETF 전용: 정규장/애프터장 분해 + 합계(전일종가→현재)
  regularChange?: number | null; // 직전 정규장 등락
  afterChange?: number | null;   // 애프터장(시간외) 등락
  totalChange?: number | null;   // 합계 = 전일 종가 대비 현재가
};

// 시간외 지수 흐름: 선물(24h) + ETF(프리/애프터장)
// 지수(^NDX 등)는 시간외 시세가 없어 선물·ETF로 대체
export async function fetchOffHoursIndex(): Promise<OffHoursQuote[]> {
  // ETF(QQQ·SOXX) 정규/애프터/합계 분해는 '주요 지표'에서 다루므로, 여기선 24시간 선물만.
  const defs: { symbol: string; label: string; kind: "선물" | "ETF" }[] = [
    { symbol: "NQ=F", label: "나스닥 선물", kind: "선물" },
    { symbol: "ES=F", label: "S&P500 선물", kind: "선물" },
  ];
  const results = await Promise.all(
    defs.map(async (d): Promise<OffHoursQuote> => {
      const q = await fetchQuote(d.symbol);
      const eff = effectiveQuote(q);
      const base: OffHoursQuote = {
        label: d.label, kind: d.kind, price: eff.price, changePercent: eff.changePercent, session: eff.session,
      };
      if (d.kind !== "ETF") return base;

      // ETF: 정규장 등락 / 애프터장 등락 / 합계(전일종가→현재) 분해
      const regularChange = q.changePercent ?? null;
      const afterChange = q.postMarketChangePercent ?? null;
      const totalChange =
        q.postMarketPrice != null && q.previousClose != null && q.previousClose !== 0
          ? ((q.postMarketPrice - q.previousClose) / q.previousClose) * 100
          : regularChange;
      return { ...base, regularChange, afterChange, totalChange };
    }),
  );
  return results;
}

export type BondEtf = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  session: "프리장" | "애프터장" | null; // 시간외 세션 (정규장이면 null)
  history: { date: string; value: number }[]; // 가격 추이
};

// 채권 ETF 현재가 + 최근 가격 추이 (TLT = 미 20년+ 국채 ETF, 가격은 금리와 역방향)
export async function fetchBondEtf(symbol = "TLT"): Promise<BondEtf | null> {
  try {
    const q = await yf.quote(symbol);
    const period1 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    let history: { date: string; value: number }[] = [];
    try {
      const c = await yf.chart(symbol, { period1, interval: "1d" });
      history = (c.quotes ?? [])
        .filter((x): x is typeof x & { close: number } => x.close != null)
        .map((x) => ({
          date: (x.date instanceof Date ? x.date : new Date(x.date)).toISOString().slice(0, 10),
          value: Number(x.close.toFixed(2)),
        }));
    } catch {
      history = [];
    }
    // ETF는 프리/애프터장 시세가 있어 정규장 외에도 effectiveQuote로 시간외 반영
    const eff = effectiveQuote({
      price: q.regularMarketPrice ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      marketState: q.marketState ?? null,
      preMarketPrice: q.preMarketPrice ?? null,
      preMarketChangePercent: q.preMarketChangePercent ?? null,
      postMarketPrice: q.postMarketPrice ?? null,
      postMarketChangePercent: q.postMarketChangePercent ?? null,
    });
    return {
      symbol,
      name: "미국 20년+ 국채 ETF (TLT)",
      price: eff.price,
      changePercent: eff.changePercent,
      session: eff.session,
      history,
    };
  } catch {
    return null;
  }
}

export type TreasuryPoint = { date: string; value: number };

// Yahoo ^TNX(10년물 금리)로 금리 이력 — FRED 키 없거나 실패 시 폴백
async function treasuryHistoryFromYahoo(limit: number): Promise<TreasuryPoint[]> {
  try {
    const days = Math.max(limit + 10, 40);
    const period1 = new Date(Date.now() - days * 24 * 3600 * 1000);
    const c = await yf.chart("^TNX", { period1, interval: "1d" });
    const pts = (c.quotes ?? [])
      .filter((x): x is typeof x & { close: number } => x.close != null)
      .map((x) => ({
        date: (x.date instanceof Date ? x.date : new Date(x.date)).toISOString().slice(0, 10),
        value: Number(x.close.toFixed(2)),
      }));
    return pts.slice(-limit); // 최근 limit개
  } catch {
    return [];
  }
}

// 미국 10년물 국채 금리 최근 이력 — FRED(DGS10) 우선, 없으면 Yahoo ^TNX 폴백
export async function fetchTreasuryHistory(limit = 20): Promise<TreasuryPoint[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (apiKey) {
    try {
      const url =
        `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10` +
        `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
      const res = await fetch(url, { next: { revalidate: 3600 } });
      if (res.ok) {
        const data = (await res.json()) as { observations?: { date: string; value: string }[] };
        const points = (data.observations ?? [])
          .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
          .filter((p) => !isNaN(p.value));
        if (points.length >= 2) return points.reverse(); // 과거 → 최근 순
      }
    } catch {
      // 폴백으로 진행
    }
  }
  // FRED 키 없음/실패 → Yahoo 폴백 (그래프가 비지 않게)
  return treasuryHistoryFromYahoo(limit);
}

export async function fetchMarketData(): Promise<MarketData> {
  const [sp500, nasdaq, sox, kospi, usdkrw, oil, treasury10y, vix, fredRate] =
    await Promise.all([
      fetchQuote(SYMBOLS.sp500),
      fetchQuote(SYMBOLS.nasdaq),
      fetchQuote(SYMBOLS.sox),
      fetchQuote(SYMBOLS.kospi),
      fetchQuote(SYMBOLS.usdkrw),
      fetchQuote(SYMBOLS.oil),
      fetchQuote(SYMBOLS.treasury10y),
      fetchQuote(SYMBOLS.vix),
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

  // SOX(필라델피아 반도체)는 미국 지수라 한국 낮 시간엔 지난 종가에 멈춤 → stale 표시
  // (판단 엔진에서 stale이면 실시간 나스닥 선물로 대체)
  sox.stale = isStaleQuote(sox);

  // 나스닥 선물(NQ=F)이 정지/지연이면 마이크로나스닥(MNQ=F)→S&P선물(ES=F) 순으로 대체
  if (isStaleQuote(nasdaq) || nasdaq.price === null) {
    const [mnq, es] = await Promise.all([fetchQuote("MNQ=F"), fetchQuote("ES=F")]);
    const alt = !isStaleQuote(mnq) && mnq.changePercent !== null ? { q: mnq, label: "마이크로나스닥(MNQ)" }
      : !isStaleQuote(es) && es.changePercent !== null ? { q: es, label: "S&P선물(ES)" }
      : null;
    if (alt) {
      nasdaq.price = alt.q.price;
      nasdaq.changePercent = alt.q.changePercent;
      nasdaq.marketTime = alt.q.marketTime;
      nasdaq.stale = false;
      nasdaq.sourceNote = `NQU26 정지중 · ${alt.label} 대체`;
    } else {
      nasdaq.stale = true;
      nasdaq.sourceNote = "NQU26 정지중 · 대체 선물도 지연";
    }
  }

  return {
    sp500,
    nasdaq,
    sox,
    kospi,
    usdkrw,
    oil,
    treasury10y,
    vix,
    fetchedAt: new Date().toISOString(),
  };
}
