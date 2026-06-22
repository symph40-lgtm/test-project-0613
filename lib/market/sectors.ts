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
  isSemi: boolean;              // 반도체 섹터 여부 (보유 관점 매도/차익 진단용)
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
  drawdown: number | null;      // 52주 전고점 대비 하락폭(%, 음수) — 되돌림/조정 정도
  rsi14: number | null;
  pctB: number | null;          // 볼린저 %B
  dataScore: number;            // 현재 주도력 신호 점수(0~100)
  buyTiming: number;            // 매수 타이밍 점수(0~100)
  sellTiming: number;           // 매도/차익 타이밍 점수(0~100)
  buyAttract: number;           // 매수 매력도(0~100) — 조정 후 반등(역발상) 매력
};

const SECTOR_ETFS: { sector: string; etf: string; code: string; isSemi?: boolean }[] = [
  { sector: "반도체", etf: "KODEX 반도체", code: "091160", isSemi: true },
  { sector: "전력기기·전선", etf: "KODEX AI전력핵심설비", code: "487240" },
  { sector: "조선", etf: "SOL 조선TOP3플러스", code: "466920" },
  { sector: "방산", etf: "PLUS K방산", code: "449450" },
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
  { sector: "콘텐츠·미디어", etf: "KODEX K콘텐츠", code: "266360" },
];

// 섹터별 미국(글로벌) 대표주 — 실적 전망(EPS 추정치 리비전)을 실데이터로 보강
export const SECTOR_REPS: Record<string, string[]> = {
  "반도체": ["NVDA", "AVGO", "MU"],
  "전력기기·전선": ["GEV", "ETN", "VRT"],
  "방산": ["LMT", "RTX", "NOC"],
  "원전·에너지": ["CEG", "VST"],
  "바이오": ["LLY", "NVO"],
  "헬스케어": ["UNH", "ABBV"],
  "자동차": ["TSLA", "GM"],
  "2차전지": ["ALB", "TSLA"],
  "철강": ["NUE", "X"],
};

// 미국 대표주의 90일 EPS 추정치 리비전(%) 평균 — 양수=실적 전망 상향
export async function fetchEpsRevision(symbols: string[]): Promise<number | null> {
  if (!symbols.length) return null;
  const vals = await Promise.all(
    symbols.map(async (s) => {
      try {
        const r = (await yf.quoteSummary(s, { modules: ["earningsTrend"] })) as Record<string, unknown>;
        const trend = ((r.earningsTrend as { trend?: Record<string, unknown>[] })?.trend ?? []);
        const t = trend.find((x) => x.period === "+1y") ?? trend[0];
        const e = (t?.epsTrend ?? {}) as Record<string, unknown>;
        const cur = e.current, d90 = e["90daysAgo"];
        if (typeof cur === "number" && typeof d90 === "number" && d90 !== 0) {
          return ((cur - d90) / Math.abs(d90)) * 100;
        }
        return null;
      } catch {
        return null;
      }
    }),
  );
  const ok = vals.filter((v): v is number => v !== null);
  return ok.length ? Number((ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(1)) : null;
}

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
function rsi(a: number[], p = 14): number | null {
  if (a.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = a.length - p; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; }
  const ag = g / p, al = l / p;
  if (al === 0) return 100;
  const rs = ag / al;
  return Math.round(100 - 100 / (1 + rs));
}
function bollPctB(a: number[], n = 20, k = 2): number | null {
  if (a.length < n) return null;
  const s = a.slice(-n);
  const m = s.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / n);
  const up = m + k * sd, lo = m - k * sd;
  return up !== lo ? Math.round(((a[a.length - 1] - lo) / (up - lo)) * 100) : 50;
}

// Yahoo 차트로 MA·RSI·볼린저·거래량배수만 산출 (52주 고점은 부정확해 네이버로 별도 계산)
async function chartSignals(code: string, price: number | null): Promise<{
  maAligned: boolean; volRatio: number | null; tradingValueEok: number | null; rsi14: number | null; pctB: number | null;
}> {
  const empty = { maAligned: false, volRatio: null, tradingValueEok: null, rsi14: null, pctB: null };
  try {
    const c = await yf.chart(`${code}.KS`, { period1: new Date(Date.now() - 180 * 24 * 3600 * 1000), interval: "1d" });
    const rows = (c.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
    const closes = rows.map((r) => r.close);
    const vols = rows.map((r) => (typeof r.volume === "number" ? r.volume : 0));
    if (closes.length < 60) return empty;
    const last = price ?? closes[closes.length - 1];
    const ma20 = sma(closes, 20), ma60 = sma(closes, 60);
    const maAligned = ma20 !== null && ma60 !== null && last > ma20 && ma20 > ma60;
    const avgVol20 = sma(vols.slice(0, -1), 20);
    const volRatio = avgVol20 && avgVol20 > 0 ? Number((vols[vols.length - 1] / avgVol20).toFixed(2)) : null;
    const tv = last * vols[vols.length - 1];
    const tradingValueEok = tv > 0 ? Math.round(tv / 1e8) : null;
    return { maAligned, volRatio, tradingValueEok, rsi14: rsi(closes), pctB: bollPctB(closes) };
  } catch {
    return empty;
  }
}

// 네이버 통합정보에서 52주 최고/최저 (Yahoo보다 정확)
async function naver52w(code: string): Promise<{ hi: number | null; lo: number | null }> {
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, { headers: H, next: { revalidate: 600 } });
    if (!r.ok) return { hi: null, lo: null };
    const j = (await r.json()) as { totalInfos?: { code?: string; value?: string }[] };
    const pick = (k: string) => toNum((j.totalInfos ?? []).find((x) => x.code === k)?.value);
    return { hi: pick("highPriceOf52Weeks"), lo: pick("lowPriceOf52Weeks") };
  } catch {
    return { hi: null, lo: null };
  }
}

async function fetchOne(def: { sector: string; etf: string; code: string; isSemi?: boolean }, kospiChg: number | null): Promise<SectorFlow | null> {
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

    const [ch, w52] = await Promise.all([chartSignals(def.code, price), naver52w(def.code)]);

    // 전고점 대비 하락폭·52주 위치 — 네이버 52주 고점/저점 기준(정확)
    const drawdown = w52.hi && w52.hi > 0 ? Number((((price - w52.hi) / w52.hi) * 100).toFixed(1)) : null;
    const pos52w = w52.hi && w52.lo && w52.hi > w52.lo ? Math.round(((price - w52.lo) / (w52.hi - w52.lo)) * 100) : null;
    const near52wHigh = drawdown !== null && drawdown >= -3;

    // 데이터 기반 '현재 주도력' 점수(0~100) — 전고점 대비 위치(되돌림)를 핵심으로 반영
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    let dataScore = 0;
    // 상대강도(코스피 대비) 0~22 : -2%p→0, +4%p→22
    if (relStrength !== null) dataScore += clamp(((relStrength + 2) / 6) * 22, 0, 22);
    // 전고점 대비 위치(현재 주도력) 0~22 : 0%(신고가)→22, -10%→11, -20%↓(되돌림)→0
    if (drawdown !== null) dataScore += clamp(((drawdown + 20) / 20) * 22, 0, 22);
    // 정배열 12
    if (ch.maAligned) dataScore += 12;
    // 당일 모멘텀 0~12 : -1%→0, +5%→12
    if (changePercent !== null) dataScore += clamp(((changePercent + 1) / 6) * 12, 0, 12);
    // 거래량 급증 0~12
    if ((ch.volRatio ?? 0) >= 2) dataScore += 12;
    else if ((ch.volRatio ?? 0) >= 1.5) dataScore += 9;
    else if ((ch.volRatio ?? 0) >= 1.2) dataScore += 5;
    // 수급 0~20 (ETF 외국인·기관 동시 순매수) — ETF 수급은 종목 수급과 다를 수 있어 보조
    if (bothBuying) dataScore += 20;
    else if ((foreign5d ?? 0) > 0) dataScore += 10;
    dataScore = Math.round(clamp(dataScore, 0, 100));

    // 매수 타이밍 점수(0~100) — 추세 살아있고 과열 아닌 눌림에서 높음
    const rsiV = ch.rsi14, pb = ch.pctB, chg = changePercent ?? 0;
    let buy = 50;
    buy += ch.maAligned ? 15 : -15;
    if (rsiV !== null) buy += rsiV >= 75 ? -25 : rsiV >= 65 ? -10 : rsiV >= 45 ? 10 : rsiV >= 35 ? 15 : 5;
    if (pb !== null) buy += pb >= 90 ? -15 : pb <= 40 ? 10 : 0;
    buy += bothBuying ? 10 : (foreign5d ?? 0) > 0 ? 5 : 0;
    if (near52wHigh && chg > 3) buy -= 12; // 신고가 급등 추격 부담
    const buyTiming = Math.round(clamp(buy, 0, 100));

    // 매도/차익 타이밍 점수(0~100) — 과열·급등 climax 또는 추세 훼손에서 높음
    let sell = 30;
    if (rsiV !== null) sell += rsiV >= 78 ? 32 : rsiV >= 72 ? 22 : rsiV >= 66 ? 12 : 0;
    if (pb !== null) sell += pb >= 98 ? 20 : pb >= 88 ? 10 : 0;
    if (near52wHigh && chg > 3) sell += 15;
    if ((ch.volRatio ?? 0) >= 2 && chg > 3) sell += 10; // 거래량 폭증 + 급등 = climax
    if (!ch.maAligned && (drawdown ?? 0) <= -10) sell += 22; // 추세 훼손 + 되돌림
    const sellTiming = Math.round(clamp(sell, 0, 100));

    // 매수 매력도(0~100) — '조정 후 반등' 역발상 매력: 낙폭과대+과매도 반등여지+수급유입+반등신호 / 추가하락 위험은 감점
    let attr = 38;
    if (drawdown !== null) {
      const dd = -drawdown; // 하락폭 크기
      attr += dd <= 5 ? 0 : dd <= 40 ? clamp(((dd - 5) / 35) * 26, 0, 26) : Math.max(14, 26 - (dd - 40) * 0.6); // -50%↑은 낙폭과대 매력 소폭 감소(추가하락 위험)
    }
    if (rsiV !== null) attr += rsiV < 35 ? 12 : rsiV < 45 ? 6 : rsiV > 70 ? -8 : 0; // 과매도=반등 여지
    if (pb !== null) attr += pb < 25 ? 8 : pb < 40 ? 4 : pb > 90 ? -6 : 0;
    attr += bothBuying ? 16 : (foreign5d ?? 0) > 0 || (inst5d ?? 0) > 0 ? 8 : ((foreign5d ?? 0) < 0 && (inst5d ?? 0) < 0) ? -12 : 0; // 바닥 수급 유입 vs 이탈
    if (chg > 1 && (ch.volRatio ?? 0) >= 1.3) attr += 8; // 거래량 동반 반등 시작
    if (!ch.maAligned && chg < -1) attr -= 12; // 역배열 + 추가 하락 = 위험
    const buyAttract = Math.round(clamp(attr, 0, 100));

    return {
      sector: def.sector, etf: def.etf, code: def.code, isSemi: !!def.isSemi,
      price, changePercent,
      foreignToday: toNum(r0.foreignerPureBuyQuant), instToday: toNum(r0.organPureBuyQuant),
      foreign5d, inst5d, bothBuying,
      tradingValueEok: ch.tradingValueEok, relStrength,
      volRatio: ch.volRatio, maAligned: ch.maAligned, pos52w, near52wHigh,
      drawdown, rsi14: ch.rsi14, pctB: ch.pctB,
      dataScore, buyTiming, sellTiming, buyAttract,
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
