// M7 신호 시스템 — 데이터 수집 어댑터.
// 기존 lib/market 어댑터(네이버·야후·KIS)를 재사용하고, 신호 시스템 전용 소스
// (fchart 일봉·KPI200 실시간·등락종목수)를 추가한다. 전 함수는 실패 시 null — 페이지는 안 깨진다.

import YahooFinance from "yahoo-finance2";
import { fetchKospi200Futures, fetchKoreanQuote, fetchStockFlow } from "@/lib/market/naver-flow";
import { fetchMarketData } from "@/lib/market/fetch";
import { SIGNAL_CONFIG, EVENT_CALENDAR, rebalanceMonthBias } from "./config";
import type { DailyBar, IntradayTick, PremarketContext } from "./types";

const yf = new YahooFinance();
const NAVER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://m.stock.naver.com/",
};

// ── KST 헬퍼
export function kstNow(): { date: string; minuteOfDay: number; iso: string } {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const date = kst.toISOString().slice(0, 10);
  const minuteOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return { date, minuteOfDay, iso: now.toISOString() };
}

// ── 일봉 (네이버 fchart XML) — NR7·ATR14·누적낙폭·갭 계산의 원천
export async function fetchDailyBars(symbol: string, count = 30): Promise<DailyBar[]> {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`;
    const res = await fetch(url, { headers: NAVER_HEADERS, next: { revalidate: 300 } });
    if (!res.ok) return [];
    const xml = await res.text();
    const bars: DailyBar[] = [];
    const re = /<item data="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const [d, o, h, l, c, v] = m[1].split("|");
      if (!/^\d{8}$/.test(d)) continue;
      const open = parseFloat(o), high = parseFloat(h), low = parseFloat(l), close = parseFloat(c);
      if (![open, high, low, close].every(isFinite)) continue;
      bars.push({
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        open, high, low, close,
        volume: isFinite(parseFloat(v)) ? parseFloat(v) : 0,
      });
    }
    return bars; // 오래된 것 → 최신 순
  } catch {
    return [];
  }
}

// ── KOSPI200 지수 실시간 (베이시스 B1용)
export async function fetchKpi200(): Promise<{ price: number | null; changePercent: number | null } | null> {
  try {
    const res = await fetch("https://polling.finance.naver.com/api/realtime/domestic/index/KPI200", {
      headers: NAVER_HEADERS,
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { datas?: Record<string, unknown>[] };
    const d = j.datas?.[0];
    if (!d) return null;
    const num = (v: unknown) => {
      const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
      return isFinite(n) ? n : null;
    };
    let chg = num(d.fluctuationsRatio);
    const dir = (d.compareToPreviousPrice as { name?: string } | undefined)?.name ?? "";
    if (chg !== null && (dir === "FALLING" || dir === "LOWER_LIMIT")) chg = -Math.abs(chg);
    return { price: num(d.closePrice), changePercent: chg };
  } catch {
    return null;
  }
}

// ── 등락종목수 (W1 breadth) — 코스피 상승/하락 종목 수. EUC-KR HTML 파싱.
export async function fetchBreadth(): Promise<{ up: number; down: number; breadth: number } | null> {
  try {
    const res = await fetch("https://finance.naver.com/sise/sise_index.naver?code=KOSPI", {
      headers: { "User-Agent": NAVER_HEADERS["User-Agent"] },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const html = new TextDecoder("euc-kr").decode(buf);
    // "상승종목수</span><a ...><span>589" 형태
    const grab = (label: string): number | null => {
      const m = html.match(new RegExp(`${label}[\\s\\S]{0,120}?<span>([\\d,]+)`));
      if (!m) return null;
      const n = parseInt(m[1].replace(/,/g, ""), 10);
      return isNaN(n) ? null : n;
    };
    const up = grab("상승종목수");
    const down = grab("하락종목수");
    if (up === null || down === null || up + down === 0) return null;
    return { up, down, breadth: up / (up + down) };
  } catch {
    return null;
  }
}

// ── 크로스마켓 (D1 니케이 선물 · D3 대만 자취안 · D2 나스닥 선물 기록)
export async function fetchCrossMarkets(): Promise<{ nikkeiChg: number | null; twiiChg: number | null; nqChg: number | null }> {
  const one = async (symbol: string): Promise<number | null> => {
    try {
      const q = await yf.quote(symbol);
      const v = q.regularMarketChangePercent;
      return typeof v === "number" && isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  const [nikkeiChg, twiiChg, nqChg] = await Promise.all([one("NKD=F"), one("^TWII"), one("NQ=F")]);
  return { nikkeiChg, twiiChg, nqChg };
}

// ── 현재 시점 스냅샷 1틱 수집 (state 라우트가 60초마다 호출)
export async function collectTick(): Promise<IntradayTick> {
  const { minuteOfDay, iso } = kstNow();
  const { hynix, samsung } = SIGNAL_CONFIG.symbols;
  const [fut, kpi200, hynixQ, samsungQ, hynixFlow, samsungFlow, cross, breadth] = await Promise.all([
    fetchKospi200Futures().catch(() => null),
    fetchKpi200().catch(() => null),
    fetchKoreanQuote(hynix).catch(() => null),
    fetchKoreanQuote(samsung).catch(() => null),
    fetchStockFlow("SK하이닉스", hynix).catch(() => null),
    fetchStockFlow("삼성전자", samsung).catch(() => null),
    fetchCrossMarkets().catch(() => ({ nikkeiChg: null, twiiChg: null, nqChg: null })),
    fetchBreadth().catch(() => null),
  ]);

  const futPx = fut?.session === "정규" && !fut.stale ? fut.price : fut?.price ?? null;
  const basis = futPx !== null && kpi200?.price != null ? futPx - kpi200.price : null;

  return {
    ts: iso,
    minuteOfDay,
    futPx,
    futChg: fut?.changePercent ?? null,
    k200Px: kpi200?.price ?? null,
    hynixPx: hynixQ?.price ?? null,
    hynixChg: hynixQ?.changePercent ?? null,
    samsungPx: samsungQ?.price ?? null,
    samsungChg: samsungQ?.changePercent ?? null,
    hynixFrgn: hynixFlow?.provisional ? hynixFlow.foreign : null,
    samsungFrgn: samsungFlow?.provisional ? samsungFlow.foreign : null,
    hynixInst: hynixFlow?.provisional ? hynixFlow.institution : null,
    samsungInst: samsungFlow?.provisional ? samsungFlow.institution : null,
    nikkeiChg: cross.nikkeiChg,
    twiiChg: cross.twiiChg,
    nqChg: cross.nqChg,
    breadth: breadth?.breadth ?? null,
    basis,
  };
}

// ── 장전 컨텍스트 구성 (C1~C5 + 일봉 + 수동 입력)
export async function buildPremarketContext(manual?: {
  consensusIntact: boolean | null;
  causeNonEarnings: boolean | null;
  qualSource?: "ai" | "user" | null;
}): Promise<PremarketContext> {
  const { date } = kstNow();
  const { hynix, samsung } = SIGNAL_CONFIG.symbols;
  const [market, hynixDaily, samsungDaily, k200Daily, hynixFlow20] = await Promise.all([
    fetchMarketData().catch(() => null),
    fetchDailyBars(hynix, 40),
    fetchDailyBars(samsung, 40),
    fetchDailyBars("KPI200", 40),
    fetchFrgn20dAvg(hynix),
  ]);
  const samsungFrgnAvg = await fetchFrgn20dAvg(samsung);

  // C1 이벤트 (당일·익일)
  const tomorrow = new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10);
  const events = EVENT_CALENDAR.filter((e) => e.date === date || e.date === tomorrow).map((e) => ({
    label: e.label,
    binary: e.binary,
    when: (e.date === date ? "당일" : "익일") as "당일" | "익일",
  }));

  // C4 미 금리 레짐 (10년물 전일 변동 기준 3분류)
  const t10 = market?.treasury10y?.changePercent ?? null;
  const regime: "상승" | "안정" | "하락" | null =
    t10 === null ? null : t10 > 0.5 ? "상승" : t10 < -0.5 ? "하락" : "안정";

  return {
    date,
    events,
    rebalance: rebalanceMonthBias(parseInt(date.slice(5, 7), 10)),
    usdkrw: {
      level: market?.usdkrw?.price ?? null,
      changePercent: market?.usdkrw?.changePercent ?? null,
    },
    usRates: { t10yChangePct: t10, regime },
    overnight: {
      nasdaqPct: market?.nasdaq?.changePercent ?? null,
      soxPct: market?.sox?.changePercent ?? null,
    },
    hynixDaily,
    samsungDaily,
    k200Daily,
    frgn20dAvg: { hynix: hynixFlow20, samsung: samsungFrgnAvg },
    consensusIntact: manual?.consensusIntact ?? null,
    causeNonEarnings: manual?.causeNonEarnings ?? null,
    qualSource: manual?.qualSource ?? null,
  };
}

// ── 외인 순매매 20일 평균(절대값) — L5 ③상대강도의 분모 (마스터 5장 배율 정규화)
async function fetchFrgn20dAvg(code: string): Promise<number | null> {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend`, {
      headers: NAVER_HEADERS,
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as { bizdate?: string; foreignerPureBuyQuant?: string }[];
    if (!Array.isArray(rows)) return null;
    const vals = rows
      .slice(1, 21) // 오늘 잠정치 제외, 직전 20일
      .map((r) => parseInt(String(r.foreignerPureBuyQuant ?? "").replace(/,/g, ""), 10))
      .filter((n) => !isNaN(n));
    if (vals.length < 5) return null;
    return vals.reduce((s, v) => s + Math.abs(v), 0) / vals.length;
  } catch {
    return null;
  }
}
