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

// Yahoo 심볼/티커 → 6자리 한국 종목코드
export function toKrCode(symbol: string | null, ticker: string): string | null {
  const s = (symbol ?? "").trim();
  const m = s.match(/^(\d{6})\.(KS|KQ)$/);
  if (m) return m[1];
  if (/^\d{6}$/.test(ticker.trim())) return ticker.trim();
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

// 여러 종목 수급 병렬 조회 (상위 N개만)
export async function fetchHoldingsFlow(
  holdings: { ticker: string; code: string }[],
  limit = 6,
): Promise<StockFlow[]> {
  const targets = holdings.slice(0, limit);
  const results = await Promise.all(targets.map((h) => fetchStockFlow(h.ticker, h.code)));
  return results.filter((r): r is StockFlow => r !== null);
}
