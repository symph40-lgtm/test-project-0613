// M7 신호 시스템 — 데이터 수집 어댑터.
// 기존 lib/market 어댑터(네이버·야후·KIS)를 재사용하고, 신호 시스템 전용 소스
// (fchart 일봉·KPI200 실시간·등락종목수)를 추가한다. 전 함수는 실패 시 null — 페이지는 안 깨진다.

import YahooFinance from "yahoo-finance2";
import { fetchKospi200Futures, fetchKoreanQuote, fetchStockFlow, fetchAccVolume } from "@/lib/market/naver-flow";
import { hasKisKeys, fetchKisInvestorFlow, fetchKisProgramNet } from "@/lib/market/kis";
import { fetchMarketData, fetchBondEtf } from "@/lib/market/fetch";
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

// ── 크로스마켓 (D1 니케이 현물 · D3 대만 자취안 · D2 나스닥 선물 기록)
// D1 니케이는 현물 ^N225 사용 — NKD=F(CME 달러선물)는 등락률 기준이 '전일 CME 정산가'라
// 주말·미국 야간 변동이 섞여 당일 현물과 어긋남 (실측: 현물 -0.48%일 때 +1.32% 표시,
// 사용자 지적 2026-07-06). 일본은 KST와 동일 시간대(09:00~15:45)라 한국 장중엔 현물이 항상 산다.
// 현물 지수는 휴장일에 어제 등락률이 남으므로 '오늘(KST) 체결'일 때만 사용 — 아니면 null(판정 유보).
export async function fetchCrossMarkets(): Promise<{ nikkeiChg: number | null; twiiChg: number | null; nqChg: number | null }> {
  const one = async (symbol: string, requireToday = false): Promise<number | null> => {
    try {
      const q = await yf.quote(symbol);
      const v = q.regularMarketChangePercent;
      if (typeof v !== "number" || !isFinite(v)) return null;
      if (requireToday) {
        const t = q.regularMarketTime;
        const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t * 1000 : null;
        if (ms === null) return null;
        const dayKst = (x: number) => new Date(x + 9 * 3600 * 1000).toISOString().slice(0, 10);
        if (dayKst(ms) !== dayKst(Date.now())) return null; // 휴장·개장 전 — 어제 등락률 오용 방지
      }
      return v;
    } catch {
      return null;
    }
  };
  // NQ=F(D2)는 24시간 선물 기록용 — 전일 정산 대비가 표준이라 그대로 둔다
  const [nikkeiChg, twiiChg, nqChg] = await Promise.all([one("^N225", true), one("^TWII", true), one("NQ=F")]);
  return { nikkeiChg, twiiChg, nqChg };
}

// ── 현재 시점 스냅샷 1틱 수집 (state 라우트가 60초마다 호출)
export async function collectTick(): Promise<IntradayTick> {
  const { minuteOfDay, iso } = kstNow();
  const { hynix, samsung } = SIGNAL_CONFIG.symbols;
  // KIS 수급 (T4·T5·T8, 2026-07-09) — 정규장 시간에만 호출 (장외엔 마감 스냅샷이라 시계열 왜곡)
  const inRegular = minuteOfDay >= SIGNAL_CONFIG.session.openMin && minuteOfDay <= SIGNAL_CONFIG.session.endMin + 15;
  const useKis = hasKisKeys() && inRegular;
  const [fut, kpi200, hynixQ, samsungQ, hynixFlow, samsungFlow, cross, breadth, hynixVol, kospiInv, futInv, prgmNet] = await Promise.all([
    fetchKospi200Futures().catch(() => null),
    fetchKpi200().catch(() => null),
    fetchKoreanQuote(hynix).catch(() => null),
    fetchKoreanQuote(samsung).catch(() => null),
    fetchStockFlow("SK하이닉스", hynix).catch(() => null),
    fetchStockFlow("삼성전자", samsung).catch(() => null),
    fetchCrossMarkets().catch(() => ({ nikkeiChg: null, twiiChg: null, nqChg: null })),
    fetchBreadth().catch(() => null),
    fetchAccVolume(hynix).catch(() => null),
    useKis ? fetchKisInvestorFlow("kospi").catch(() => null) : Promise.resolve(null),
    useKis ? fetchKisInvestorFlow("k200fut").catch(() => null) : Promise.resolve(null),
    useKis ? fetchKisProgramNet().catch(() => null) : Promise.resolve(null),
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
    hynixVol,
    kospiFrgn: kospiInv?.frgnNetAmt ?? null,
    kospiPrgm: prgmNet,
    futFrgn: futInv?.frgnNetAmt ?? null,
    futFrgnQty: futInv?.frgnNetQty ?? null,
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
  macroSurprise?: "easing" | "tightening" | null;
  usNewsImpact?: "up" | "down" | "neutral" | null; // L7 개정 (2026-07-09) — 매일 미국 뉴스 영향도
  usNewsNote?: string | null;
}): Promise<PremarketContext> {
  const { date } = kstNow();
  const { hynix, samsung } = SIGNAL_CONFIG.symbols;
  const [market, hynixDaily, samsungDaily, k200Daily, hynixFlow20, macroTrend, us2y, bondEtf] = await Promise.all([
    fetchMarketData().catch(() => null),
    fetchDailyBars(hynix, 40),
    fetchDailyBars(samsung, 40),
    fetchDailyBars("KPI200", 40),
    fetchFrgn20dAvg(hynix),
    fetchMacro5dTrend(),
    fetchUs2yDaily(),
    fetchBondEtf("TLT").catch(() => null),
  ]);
  const samsungFrgnAvg = await fetchFrgn20dAvg(samsung);

  // C1 이벤트 (당일·익일)
  const tomorrow = new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10);
  const events = EVENT_CALENDAR.filter((e) => e.date === date || e.date === tomorrow).map((e) => ({
    label: e.label,
    binary: e.binary,
    when: (e.date === date ? "당일" : "익일") as "당일" | "익일",
  }));

  // C4 미 금리 레짐 — 2년물 전일 변화(%p) 기준 3분류 (사용자 개정 2026-07-07: 10년물→2년물.
  // ±0.03%p는 rate-alert 실측 분석과 동일 눈금 — 평상시 일중 99%가 0.022%p 이하)
  const y2 = us2y.changePp;
  const regime: "상승" | "안정" | "하락" | null =
    y2 === null ? null : y2 > 0.03 ? "상승" : y2 < -0.03 ? "하락" : "안정";

  return {
    date,
    events,
    rebalance: rebalanceMonthBias(parseInt(date.slice(5, 7), 10)),
    usdkrw: {
      level: market?.usdkrw?.price ?? null,
      changePercent: market?.usdkrw?.changePercent ?? null,
    },
    usRates: { changePp: y2, regime },
    macroTrend: { rate5dPp: us2y.fiveDayPp, usdkrw5dPct: macroTrend.usdkrw5dPct },
    // 축1 확장 매크로 (사용자 지정 2026-07-13). 10Y는 야후 ^TNX(금리 %) — 전일 %p 변화로 환산
    macroExtra: {
      us10y: (() => {
        const p = market?.treasury10y?.price ?? null;
        const c = market?.treasury10y?.changePercent ?? null;
        const pp = p !== null && c !== null && isFinite(p) && isFinite(c) && 100 + c !== 0
          ? Number((p - p / (1 + c / 100)).toFixed(4)) : null;
        return { level: p, changePp: pp };
      })(),
      wti: { level: market?.oil?.price ?? null, changePercent: market?.oil?.changePercent ?? null },
      dxy: { level: market?.dollarIndex?.price ?? null, changePercent: market?.dollarIndex?.changePercent ?? null },
      bondEtf: { changePercent: bondEtf?.changePercent ?? null },
    },
    macroSurprise: manual?.macroSurprise ?? null,
    overnight: {
      nasdaqPct: market?.nasdaq?.changePercent ?? null,
      soxPct: market?.sox?.changePercent ?? null,
    },
    usNews: {
      impact: manual?.usNewsImpact === "up" ? "상방" : manual?.usNewsImpact === "down" ? "하방" : manual?.usNewsImpact === "neutral" ? "중립" : null,
      note: manual?.usNewsNote ?? null,
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

// ── 매크로 5일 추세 — "추세 중의 변화" 감지용 (환율이 상승 추세였다가 꺾이는 전환 포착)
async function fetchMacro5dTrend(): Promise<{ usdkrw5dPct: number | null }> {
  try {
    const r = await yf.chart("KRW=X", { period1: new Date(Date.now() - 14 * 86400000), interval: "1d" });
    const closes = (r.quotes ?? []).map((q) => q.close).filter((c): c is number => c != null);
    if (closes.length < 6) return { usdkrw5dPct: null };
    const start = closes[closes.length - 6];
    const end = closes[closes.length - 1];
    return { usdkrw5dPct: start > 0 ? ((end - start) / start) * 100 : null };
  } catch {
    return { usdkrw5dPct: null };
  }
}

// ── 미 2년물 일봉 (네이버 US2YT=RR — 실시간 금리 소스의 일간 이력)
// C4 레짐(전일 변화)·매크로 전환 감지(5일 추세)용. 값은 %p (금리 절대 레벨의 차).
async function fetchUs2yDaily(): Promise<{ changePp: number | null; fiveDayPp: number | null }> {
  try {
    const res = await fetch(
      "https://m.stock.naver.com/front-api/marketIndex/prices?category=bond&reutersCode=US2YT=RR&page=1&pageSize=10",
      { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" },
    );
    if (!res.ok) return { changePp: null, fiveDayPp: null };
    const j = (await res.json()) as { result?: { closePrice: string }[] };
    const closes = (j.result ?? [])
      .map((r) => parseFloat(r.closePrice))
      .filter((v) => !isNaN(v) && v > 0 && v < 20); // 최신이 먼저
    if (closes.length < 2) return { changePp: null, fiveDayPp: null };
    const changePp = Number((closes[0] - closes[1]).toFixed(4));
    const fiveDayPp = closes.length >= 6 ? Number((closes[0] - closes[5]).toFixed(4)) : null;
    return { changePp, fiveDayPp };
  } catch {
    return { changePp: null, fiveDayPp: null };
  }
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
