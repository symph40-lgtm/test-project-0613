// 네이버 금융 종목별 외국인·기관 순매매 (수급) 파싱
// https://finance.naver.com/item/frgn.naver?code=005930 (EUC-KR HTML)
// 비공식 — 실패 시 null 반환(페이지 안 깨짐)

export type StockFlow = {
  ticker: string;
  code: string;          // 6자리 종목코드
  date: string;          // 기준일 (YYYY.MM.DD)
  institution: number | null; // 기관 순매매량(주)
  foreign: number | null;     // 외국인 순매매량(주)
};

import { getYahooSymbol } from "../positions";

// Yahoo 심볼/티커/한글명 → 6자리 한국 종목코드
export function toKrCode(symbol: string | null, ticker: string): string | null {
  // 1) 저장된 심볼 (005930.KS)
  const m = (symbol ?? "").trim().match(/^(\d{6})\.(KS|KQ)$/);
  if (m) return m[1];
  // 2) 티커가 6자리 코드
  if (/^\d{6}$/.test(ticker.trim())) return ticker.trim();
  // 3) 한글 종목명 → 매핑 테이블로 심볼 해석 (예: 삼성전자 → 005930.KS)
  const resolved = getYahooSymbol(ticker);
  const m2 = (resolved ?? "").match(/^(\d{6})\.(KS|KQ)$/);
  if (m2) return m2[1];
  return null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function parseSignedInt(s: string): number | null {
  const cleaned = stripTags(s).replace(/,/g, "").replace(/\s/g, "");
  if (!cleaned || cleaned === "-") return null;
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? null : n;
}

export async function fetchStockFlow(ticker: string, code: string): Promise<StockFlow | null> {
  try {
    const res = await fetch(`https://finance.naver.com/item/frgn.naver?code=${code}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://finance.naver.com/",
      },
      next: { revalidate: 1800 },
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const html = new TextDecoder("euc-kr").decode(buf);

    // 데이터 행: 날짜(YYYY.MM.DD)로 시작하고 셀이 9개 내외인 tr
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html))) {
      const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
      if (cells.length < 7) continue;
      const date = stripTags(cells[0]);
      if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date)) continue;
      // 컬럼: 0날짜 1종가 2전일비 3등락률 4거래량 5기관순매매 6외국인순매매 ...
      const institution = parseSignedInt(cells[5]);
      const foreign = parseSignedInt(cells[6]);
      return { ticker, code, date, institution, foreign };
    }
    return null;
  } catch {
    return null;
  }
}

export type KoreanQuote = {
  code: string;
  price: number | null;        // 현재 표시가 (시간외 진행 중이면 시간외가)
  changePercent: number | null;
  session: string | null;      // "장전" | "시간외" | null(정규/마감)
  delayName: string | null;    // "실시간" 등
};

function signedRatio(ratioStr: unknown, dir: unknown): number | null {
  const raw = typeof ratioStr === "string" ? parseFloat(ratioStr.replace(/,/g, "")) : typeof ratioStr === "number" ? ratioStr : NaN;
  if (isNaN(raw)) return null;
  const name = (dir as { name?: string })?.name ?? "";
  if (name === "FALLING" || name === "LOWER_LIMIT") return -Math.abs(raw);
  if (name === "RISING" || name === "UPPER_LIMIT") return Math.abs(raw);
  return raw; // 보합/알수없음
}

function toNumKR(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }
  return null;
}

// 네이버 모바일 API로 한국 종목 실시간 시세 (+ 시간외 단일가 자동 반영)
export async function fetchKoreanQuote(code: string): Promise<KoreanQuote | null> {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;

    const regPrice = toNumKR(j.closePrice);
    const regRatio = signedRatio(j.fluctuationsRatio, j.compareToPreviousPrice);
    const delayName = typeof j.delayTimeName === "string" ? j.delayTimeName : null;

    // 정규장(평일 09:00~15:30) 시간이 아니면, 시간외 거래가를 우선 표시
    const over = j.overMarketPriceInfo as Record<string, unknown> | undefined;
    const oPrice = over ? toNumKR(over.overPrice) : null;
    if (over && oPrice !== null) {
      const kst = new Date(Date.now() + 9 * 3600 * 1000);
      const day = kst.getUTCDay(); // 0일~6토
      const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
      const regularNow = day >= 1 && day <= 5 && t >= 9 * 60 && t <= 15 * 60 + 30;
      const statusOpen = over.overMarketStatus === "OPEN";

      // 정규장 시간이 아니거나 시간외 세션이 열려 있으면 시간외가 표시
      if (!regularNow || statusOpen) {
        const oRatio = signedRatio(over.fluctuationsRatio, over.compareToPreviousPrice);
        const isBefore = over.tradingSessionType === "BEFORE_MARKET" || t < 9 * 60;
        return {
          code,
          price: oPrice,
          changePercent: oRatio,
          session: isBefore ? "장전" : "시간외",
          delayName,
        };
      }
    }

    return { code, price: regPrice, changePercent: regRatio, session: null, delayName };
  } catch {
    return null;
  }
}

export type KoreanOffHours = {
  code: string;
  session: "장전" | "시간외" | null; // 장전 시간외 / 장후 시간외 단일가
  price: number | null;
  changePercent: number | null;
};

// 네이버 모바일 API에서 한국 종목 시간외 단일가 조회
export async function fetchKoreanOffHours(code: string): Promise<KoreanOffHours | null> {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
      next: { revalidate: 120 },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;

    // 시간외 정보 블록 탐색 (overMarketPriceInfo 등 키 변형 대응)
    const over =
      (j.overMarketPriceInfo as Record<string, unknown> | undefined) ??
      (j.overTimePrice as Record<string, unknown> | undefined) ??
      null;
    if (!over) return null;

    const num = (v: unknown): number | null => {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const n = parseFloat(v.replace(/,/g, ""));
        return isNaN(n) ? null : n;
      }
      return null;
    };

    const price = num(over.overPrice ?? over.tradePrice ?? over.closePrice);
    const ratio = num(over.fluctuationsRatio ?? over.changeRate ?? over.rate);
    if (price === null && ratio === null) return null;

    // 시간대로 장전/시간외 구분 (KST)
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const sess: KoreanOffHours["session"] = t < 9 * 60 ? "장전" : "시간외";

    return { code, session: sess, price, changePercent: ratio };
  } catch {
    return null;
  }
}

// 여러 종목 수급 병렬 조회 (상위 N개만)
export async function fetchHoldingsFlow(
  holdings: { ticker: string; code: string }[],
  limit = 6,
): Promise<StockFlow[]> {
  const targets = holdings.slice(0, limit);
  const results = await Promise.all(targets.map((h) => fetchStockFlow(h.ticker, h.code)));
  return results.filter((r): r is StockFlow => r !== null);
}
