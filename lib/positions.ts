// 섹터 lookup — 주요 한국·미국 종목 매핑
const SECTOR_MAP: Record<string, string> = {
  // 반도체
  삼성전자: "반도체",
  SK하이닉스: "반도체",
  DB하이텍: "반도체",
  하나마이크론: "반도체",
  이오테크닉스: "반도체",
  원익IPS: "반도체",
  리노공업: "반도체",
  SOXL: "반도체",
  SOXS: "반도체",
  SOXX: "반도체",
  SMH: "반도체",
  PSI: "반도체",
  NVDA: "반도체",
  AMD: "반도체",
  INTC: "반도체",
  MU: "반도체",
  AVGO: "반도체",
  QCOM: "반도체",
  TSMC: "반도체",
  "TSM": "반도체",
  // 2차전지
  "LG에너지솔루션": "2차전지",
  삼성SDI: "2차전지",
  SK이노베이션: "2차전지",
  "POSCO홀딩스": "2차전지",
  에코프로비엠: "2차전지",
  에코프로: "2차전지",
  엘앤에프: "2차전지",
  포스코퓨처엠: "2차전지",
  // 방산
  "한화에어로스페이스": "방산",
  "한화에어로": "방산",
  LIG넥스원: "방산",
  현대로템: "방산",
  풍산: "방산",
  빅텍: "방산",
  // 금융
  삼성생명: "금융",
  삼성화재: "금융",
  KB금융: "금융",
  신한지주: "금융",
  하나금융지주: "금융",
  우리금융지주: "금융",
  메리츠금융지주: "금융",
  // IT/플랫폼
  카카오: "IT",
  네이버: "IT",
  넥슨: "IT",
  크래프톤: "IT",
  AAPL: "IT",
  MSFT: "IT",
  GOOGL: "IT",
  GOOG: "IT",
  META: "IT",
  AMZN: "IT",
  // 전기차
  TSLA: "전기차",
  // 바이오
  셀트리온: "바이오",
  "삼성바이오로직스": "바이오",
  유한양행: "바이오",
  // ETF — 미국
  SPY: "ETF-미국",
  IVV: "ETF-미국",
  VOO: "ETF-미국",
  IWM: "ETF-미국",
  DIA: "ETF-미국",
  QQQ: "ETF-기술",
  QQQL: "ETF-기술",
  TQQQ: "ETF-기술",
  ARKK: "ETF-기술",
  XLK: "ETF-기술",
  // ETF — 한국
  KODEX200: "ETF-한국",
  TIGER200: "ETF-한국",
};

export function getSectorHint(ticker: string): string | null {
  return SECTOR_MAP[ticker.trim()] ?? null;
}

// 종목명/티커 → Yahoo Finance 심볼 매핑
// 한국 종목은 종목코드.KS(거래소)/.KQ(코스닥), 미국 종목은 티커 그대로 사용
const YAHOO_SYMBOL_MAP: Record<string, string> = {
  // 반도체
  삼성전자: "005930.KS",
  SK하이닉스: "000660.KS",
  DB하이텍: "000990.KS",
  하나마이크론: "067310.KQ",
  이오테크닉스: "039030.KQ",
  원익IPS: "240810.KQ",
  리노공업: "058470.KQ",
  가온칩스: "399720.KQ",
  // 2차전지
  "LG에너지솔루션": "373220.KS",
  삼성SDI: "006400.KS",
  SK이노베이션: "096770.KS",
  "POSCO홀딩스": "005490.KS",
  에코프로비엠: "247540.KQ",
  에코프로: "086520.KQ",
  엘앤에프: "066970.KQ",
  포스코퓨처엠: "003670.KS",
  // 방산
  "한화에어로스페이스": "012450.KS",
  "한화에어로": "012450.KS",
  LIG넥스원: "079550.KS",
  현대로템: "064350.KS",
  풍산: "103140.KS",
  빅텍: "065450.KQ",
  // 금융
  삼성생명: "032830.KS",
  삼성화재: "000810.KS",
  KB금융: "105560.KS",
  신한지주: "055550.KS",
  하나금융지주: "086790.KS",
  우리금융지주: "316140.KS",
  메리츠금융지주: "138040.KS",
  // IT/플랫폼
  카카오: "035720.KS",
  네이버: "035420.KS",
  크래프톤: "259960.KS",
  // 바이오
  셀트리온: "068270.KS",
  "삼성바이오로직스": "207940.KS",
  유한양행: "000100.KS",
  // ETF — 한국
  KODEX200: "069500.KS",
  TIGER200: "102110.KS",
};

// 로컬 종목 사전 검색 (Yahoo가 순수 한글 쿼리를 거부하는 문제 보완)
// 매핑 테이블 이름에 대해 부분 일치 검색
export type LocalTicker = { symbol: string; name: string; exchange: string };

export function searchLocalTickers(query: string): LocalTicker[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return [];

  const out: LocalTicker[] = [];
  for (const [name, symbol] of Object.entries(YAHOO_SYMBOL_MAP)) {
    const key = name.toLowerCase().replace(/\s+/g, "");
    if (key.includes(q) || q.includes(key)) {
      const exchange = symbol.endsWith(".KQ")
        ? "KOSDAQ"
        : symbol.endsWith(".KS")
          ? "KOSPI"
          : "";
      // 중복 심볼 방지
      if (!out.some((o) => o.symbol === symbol)) {
        out.push({ symbol, name, exchange });
      }
    }
  }
  return out;
}

// 대소문자·공백 무시 매칭용 정규화 키 맵 (1회 생성)
const NORMALIZED_SYMBOL_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(YAHOO_SYMBOL_MAP).map(([k, v]) => [
    k.toLowerCase().replace(/\s+/g, ""),
    v,
  ]),
);

// 종목명 → Yahoo 심볼 (매핑 + 6자리코드). 해석 실패 시 null
// (검색 폴백은 fetch.ts에서 비동기로 처리)
export function getYahooSymbol(ticker: string): string | null {
  const t = ticker.trim();
  if (YAHOO_SYMBOL_MAP[t]) return YAHOO_SYMBOL_MAP[t];

  const norm = t.toLowerCase().replace(/\s+/g, "");
  if (NORMALIZED_SYMBOL_MAP[norm]) return NORMALIZED_SYMBOL_MAP[norm];

  // 6자리 숫자 = 한국 종목코드
  if (/^\d{6}$/.test(t)) return `${t}.KS`;

  // 한글이 없고 영문/숫자로만 된 티커는 미국 종목으로 간주 (SOXL, NVDA 등)
  if (!/[가-힣]/.test(t) && /^[A-Za-z0-9.\-]+$/.test(t)) return t.toUpperCase();

  // 그 외(자유 입력 한글명)는 검색 폴백 필요 → null
  return null;
}

// 한국 종목 여부 (이름이 매핑에 있거나 한글 포함 또는 6자리 코드)
export function isKoreanTicker(ticker: string): boolean {
  const t = ticker.trim();
  if (YAHOO_SYMBOL_MAP[t]) return true;
  if (/[가-힣]/.test(t)) return true;
  if (/^\d{6}$/.test(t)) return true;
  return false;
}

type RiskInput = {
  weight: number;
  is_leverage: boolean;
  pnl?: number | null;
};

export function calculateRiskLevel(
  p: RiskInput,
): "취약" | "주의" | "안정" {
  const pnl = p.pnl ?? 0;
  if (p.is_leverage) {
    if (p.weight >= 20 && pnl <= -10) return "취약";
    if (p.weight >= 15 || pnl <= -5) return "주의";
    return "안정";
  } else {
    if (p.weight >= 30 && pnl <= -10) return "취약";
    if (pnl <= -5) return "주의";
    return "안정";
  }
}

type PositionForRecommend = {
  weight: number;
  is_leverage: boolean;
  sector?: string | null;
  risk_level?: "취약" | "주의" | "안정" | null;
};

// 현재 positions 기반으로 활성화를 추천할 trigger_key 목록 반환
export function recommendRiskLines(
  positions: PositionForRecommend[],
): string[] {
  const recommended = new Set<string>();

  for (const p of positions) {
    if (p.weight > 10) recommended.add("low");
    if (p.is_leverage) recommended.add("drop5");
    if (p.is_leverage && p.sector === "반도체") recommended.add("futures");
    if (p.weight > 20 && p.risk_level === "취약") recommended.add("rebound");
  }

  return [...recommended];
}
