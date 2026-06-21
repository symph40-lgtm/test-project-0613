// 네이버 금융 종목별 외국인·기관 순매매 (수급) 파싱
// https://finance.naver.com/item/frgn.naver?code=005930 (EUC-KR HTML)
// 비공식 — 실패 시 null 반환(페이지 안 깨짐)

export type StockFlow = {
  ticker: string;
  code: string;          // 6자리 종목코드
  date: string;          // 기준일 (YYYY.MM.DD)
  institution: number | null; // 기관 순매매량(주)
  foreign: number | null;     // 외국인 순매매량(주)
  provisional: boolean;  // 오늘 장중 잠정치 여부 (true=장중 잠정, false=확정)
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

// 오늘 날짜를 KST 기준 YYYYMMDD로
function kstTodayYmd(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${mo}${d}`;
}

// "20260618" → "2026.06.18"
function fmtBizdate(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return ymd;
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

type TrendRow = {
  bizdate?: string;
  foreignerPureBuyQuant?: string;
  organPureBuyQuant?: string;
};

// 네이버 모바일 trend API — 첫 행이 최신(장중이면 오늘 잠정치, 마감 후엔 확정치)
// 확정 일별표(frgn.naver)는 장중에 오늘 행이 없어 어제 값만 나오므로 trend로 교체
export async function fetchStockFlow(ticker: string, code: string): Promise<StockFlow | null> {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://m.stock.naver.com/",
      },
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as TrendRow[];
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const row = rows[0];
    const bizdate = typeof row.bizdate === "string" ? row.bizdate : "";
    if (!/^\d{8}$/.test(bizdate)) return null;

    const foreign = parseSignedInt(row.foreignerPureBuyQuant ?? "");
    const institution = parseSignedInt(row.organPureBuyQuant ?? "");

    return {
      ticker,
      code,
      date: fmtBizdate(bizdate),
      institution,
      foreign,
      provisional: bizdate === kstTodayYmd(),
    };
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

// ─── 한국 종목 밸류에이션 (네이버 — Yahoo가 .KS PER을 안 주는 문제 보완) ──
export type KoreanValuation = {
  trailingPE: number | null; // PER (후행)
  forwardPE: number | null;  // 추정 PER (선행/컨센서스)
  pbr: number | null;
  eps: number | null;
};

// "28.61배" / "12,372원" → 숫자. 음수·마이너스 표기도 처리, 값 없으면 null
function parseNaverNum(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// 네이버 종목 통합정보(totalInfos)에서 PER/추정PER/PBR/EPS 추출
export async function fetchKoreanValuation(code: string): Promise<KoreanValuation | null> {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
      next: { revalidate: 600 },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { totalInfos?: { code?: string; value?: string }[] };
    const infos = j.totalInfos;
    if (!Array.isArray(infos)) return null;
    const pick = (k: string) => parseNaverNum(infos.find((x) => x.code === k)?.value);
    return {
      trailingPE: pick("per"),
      forwardPE: pick("cnsPer"), // 추정PER = 선행 PER
      pbr: pick("pbr"),
      eps: pick("eps"),
    };
  } catch {
    return null;
  }
}

// ─── 코스피200 선물 (네이버 국내지수선물 FUT, 정규+야간 글로벌 세션) ──────
export type Kospi200Futures = {
  price: number | null;
  changePercent: number | null;
  session: "정규" | "야간" | "마감"; // KST 기준 세션
  marketStatus: string | null;       // 네이버 OPEN/CLOSE
  tradedAt: string | null;           // 마지막 체결 시각(ISO+09:00)
};

// KST 시각으로 선물 세션 판별 (정규 09:00~15:45, 야간 18:00~익일 05:00)
function kospiFuturesSession(now: Date): Kospi200Futures["session"] {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay(); // 0일~6토
  const t = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  if (weekday && t >= 9 * 60 && t <= 15 * 60 + 45) return "정규";
  // 야간: 평일 18:00~24:00, 또는 화~토 00:00~05:00 (전 영업일 야간 연장)
  if (weekday && t >= 18 * 60) return "야간";
  if (day >= 2 && day <= 6 && t < 5 * 60) return "야간";
  return "마감";
}

// 네이버 실시간 폴링 API에서 코스피200 선물 시세 조회
// 평일 정규장(09:00~15:45)과 야간 글로벌 세션(18:00~익일 05:00)을 반영
export async function fetchKospi200Futures(): Promise<Kospi200Futures | null> {
  try {
    const res = await fetch(
      "https://polling.finance.naver.com/api/realtime/domestic/index/FUT",
      {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
        next: { revalidate: 60 },
      },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { datas?: Record<string, unknown>[] };
    const d = j.datas?.[0];
    if (!d) return null;

    const price = toNumKR(d.closePriceRaw ?? d.closePrice);
    let chg = toNumKR(d.fluctuationsRatioRaw ?? d.fluctuationsRatio);
    if (chg !== null) {
      const dir = (d.compareToPreviousPrice as { name?: string } | undefined)?.name ?? "";
      chg = dir === "FALLING" || dir === "LOWER_LIMIT" ? -Math.abs(chg) : Math.abs(chg);
    }
    return {
      price,
      changePercent: chg,
      session: kospiFuturesSession(new Date()),
      marketStatus: typeof d.marketStatus === "string" ? d.marketStatus : null,
      tradedAt: typeof d.localTradedAt === "string" ? d.localTradedAt : null,
    };
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
