// 반도체 외 '주도 섹터' 발굴 — 단기 테마가 아니라 구조적 주도 섹터인지 판별하는 신호를 모은다.
// 판단 프레임: 수급(외국인·기관 동시) · 거래대금 급증 · 상대강도(코스피 대비) · 차트 정배열/신고가.
// (실적 전망 상향·정책·글로벌 동조·확산·밸류에이션은 AI 정성평가가 보완)
// 데이터: 네이버(시세·수급·거래대금) + Yahoo(차트: 이평·52주·거래량 추세)

import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type SectorFlow = {
  sector: string;
  etf: string;
  code: string;
  price: number | null;
  changePercent: number | null;
  foreignToday: number | null;
  instToday: number | null;
  foreign5d: number | null;
  inst5d: number | null;
  bothBuying: boolean;          // 외국인·기관 5일 동시 순매수
  tradingValueEok: number | null; // 당일 거래대금(억원)
  relStrength: number | null;   // ETF 등락 − 코스피 등락 (상대강도)
  volRatio: number | null;      // 당일 거래량 / 20일 평균 (거래대금 급증 proxy)
  maAligned: boolean;           // 20일>60일 정배열 & 가격>20일
  pos52w: number | null;        // 52주 내 위치 %
  near52wHigh: boolean;         // 신고가 근접(90%+)
  dataScore: number;            // 계산 가능한 신호 부분 점수(0~55)
};

const SECTOR_ETFS: { sector: string; etf: string; code: string }[] = [
  { sector: "전력기기·전선", etf: "KODEX 전력핵심설비", code: "473460" },
  { sector: "조선", etf: "KODEX 조선TOP10", code: "466920" },
  { sector: "방산", etf: "KODEX K-방산", code: "449180" },
  { sector: "원전·에너지", etf: "KODEX 에너지화학", code: "117460" },
  { sector: "자동차", etf: "KODEX 자동차", code: "091180" },
  { sector: "2차전지", etf: "KODEX 2차전지산업", code: "305720" },
  { sector: "바이오", etf: "KODEX 바이오", code: "244580" },
  { sector: "헬스케어", etf: "KODEX 헬스케어", code: "266420" },
  { sector: "은행", etf: "KODEX 은행", code: "091170" },
  { sector: "증권", etf: "KODEX 증권", code: "102970" },
  { sector: "건설", etf: "KODEX 건설", code: "117700" },
  { sector: "철강", etf: "KODEX 철강", code: "117680" },
  { sector: "운송", etf: "KODEX 운송", code: "140710" },
  { sector: "미디어·엔터", etf: "KODEX 미디어&엔터", code: "266360" },
];

const H = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };

function toNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }
  return null;
}
function signed(ratio: unknown, dir: unknown): number | null {
  const raw = toNum(ratio);
  if (raw === null) return null;
  const name = (dir as { name?: string })?.name ?? "";
  if (name === "FALLING" || name === "LOWER_LIMIT") return -Math.abs(raw);
  if (name === "RISING" || name === "UPPER_LIMIT") return Math.abs(raw);
  return raw;
}
const sma = (a: number[], n: number): number | null => (a.length < n ? null : a.slice(-n).reduce((x, y) => x + y, 0) / n);

async function chartSignals(code: string, price: number | null): Promise<{
  maAligned: boolean; pos52w: number | null; near52wHigh: boolean; volRatio: number | null; tradingValueEok: number | null;
}> {
  const empty = { maAligned: false, pos52w: null, near52wHigh: false, volRatio: null, tradingValueEok: null };
  try {
    const c = await yf.chart(`${code}.KS`, { period1: new Date(Date.now() - 370 * 24 * 3600 * 1000), interval: "1d" });
    const rows = (c.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
    const closes = rows.map((r) => r.close);
    const vols = rows.map((r) => (typeof r.volume === "number" ? r.volume : 0));
    if (closes.length < 60) return empty;
    const last = price ?? closes[closes.length - 1];
    const ma20 = sma(closes, 20), ma60 = sma(closes, 60);
    const maAligned = ma20 !== null && ma60 !== null && last > ma20 && ma20 > ma60;
    const hi = Math.max(...closes), loMin = Math.min(...closes);
    const pos52w = hi > loMin ? Math.round(((last - loMin) / (hi - loMin)) * 100) : null;
    const near52wHigh = pos52w !== null && pos52w >= 90;
    const avgVol20 = sma(vols.slice(0, -1), 20);
    const volRatio = avgVol20 && avgVol20 > 0 ? Number((vols[vols.length - 1] / avgVol20).toFixed(2)) : null;
    // 거래대금(억원) ≈ 종가 × 거래량 (Yahoo)
    const tv = last * vols[vols.length - 1];
    const tradingValueEok = tv > 0 ? Math.round(tv / 1e8) : null;
    return { maAligned, pos52w, near52wHigh, volRatio, tradingValueEok };
  } catch {
    return empty;
  }
}

async function fetchOne(def: { sector: string; etf: string; code: string }, kospiChg: number | null): Promise<SectorFlow | null> {
  try {
    const [basicRes, trendRes] = await Promise.all([
      fetch(`https://m.stock.naver.com/api/stock/${def.code}/basic`, { headers: H, next: { revalidate: 120 } }),
      fetch(`https://m.stock.naver.com/api/stock/${def.code}/trend`, { headers: H, next: { revalidate: 120 } }),
    ]);
    if (!basicRes.ok) return null;
    const b = (await basicRes.json()) as Record<string, unknown>;
    const price = toNum(b.closePrice);
    if (price === null) return null;
    const trend = trendRes.ok ? ((await trendRes.json()) as Record<string, unknown>[]) : [];
    const rows = Array.isArray(trend) ? trend.slice(0, 5) : [];
    const sumF = rows.reduce<number>((a, r) => a + (toNum(r.foreignerPureBuyQuant) ?? 0), 0);
    const sumI = rows.reduce<number>((a, r) => a + (toNum(r.organPureBuyQuant) ?? 0), 0);
    const r0 = rows[0] ?? {};

    const changePercent = signed(b.fluctuationsRatio, b.compareToPreviousPrice);
    const foreign5d = rows.length ? sumF : null;
    const inst5d = rows.length ? sumI : null;
    const bothBuying = (foreign5d ?? 0) > 0 && (inst5d ?? 0) > 0;
    const relStrength = changePercent !== null && kospiChg !== null ? Number((changePercent - kospiChg).toFixed(2)) : null;

    const ch = await chartSignals(def.code, price);

    // 계산 가능한 부분 점수 (수급20 · 거래대금15 · 상대강도10 · 차트10 = 55)
    let dataScore = 0;
    if (bothBuying) dataScore += 20;
    else if ((foreign5d ?? 0) > 0) dataScore += 10;
    if ((ch.volRatio ?? 0) >= 1.5) dataScore += 15;
    else if ((ch.volRatio ?? 0) >= 1.2) dataScore += 8;
    if ((relStrength ?? -1) > 1) dataScore += 10;
    else if ((relStrength ?? -1) > 0) dataScore += 5;
    if (ch.maAligned) dataScore += 6;
    if (ch.near52wHigh) dataScore += 4;

    return {
      sector: def.sector, etf: def.etf, code: def.code,
      price, changePercent,
      foreignToday: toNum(r0.foreignerPureBuyQuant), instToday: toNum(r0.organPureBuyQuant),
      foreign5d, inst5d, bothBuying,
      tradingValueEok: ch.tradingValueEok, relStrength,
      volRatio: ch.volRatio, maAligned: ch.maAligned, pos52w: ch.pos52w, near52wHigh: ch.near52wHigh,
      dataScore,
    };
  } catch {
    return null;
  }
}

export async function fetchSectorFlows(): Promise<SectorFlow[]> {
  const kospiChg = await yf.quote("^KS11").then((q) => q.regularMarketChangePercent ?? null).catch(() => null);
  const results = await Promise.all(SECTOR_ETFS.map((d) => fetchOne(d, kospiChg)));
  return results
    .filter((r): r is SectorFlow => r !== null)
    .sort((a, b) => b.dataScore - a.dataScore || (b.foreign5d ?? -Infinity) - (a.foreign5d ?? -Infinity));
}
