// G1B T1 — 라이브 수집기 (WORKORDER week4 §1). 모든 값에 fetch_ts, 절단 후 도착 = late_arrival.
// 결측 시 파이프라인 정지 금지 — null 기록 후 가중 재정규화 (엔진 소관).

import YahooFinance from "yahoo-finance2";
import { fetchKisNightFutures, hasKisKeys } from "@/lib/market/kis";
import { getKisToken } from "@/lib/market/kisToken";
import type { G1BSymbol } from "./config";
import { G1B_CONFIG } from "./config";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type Obs = { v: number | null; fetch_ts: string; late_arrival?: boolean; src?: string };

const now = () => new Date().toISOString();
const kstHHMM = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16);

function mark(v: number | null, cutoff: string, src?: string): Obs {
  return { v, fetch_ts: now(), late_arrival: kstHHMM() > cutoff, src };
}

async function quote(sym: string): Promise<number | null> {
  try {
    const q = await yf.quote(sym);
    const v = (q as { regularMarketPrice?: number }).regularMarketPrice;
    return typeof v === "number" && isFinite(v) ? v : null;
  } catch { return null; }
}

async function dailyRet(sym: string): Promise<number | null> {
  try {
    const r = await yf.chart(sym, { period1: new Date(Date.now() - 10 * 86400e3), interval: "1d" });
    const q = (r.quotes ?? []).filter((x) => x.close != null);
    if (q.length < 2) return null;
    return Math.log((q[q.length - 1].close as number) / (q[q.length - 2].close as number));
  } catch { return null; }
}

// 미 시간외 바스켓 — prepost 1분봉 마지막가 vs 정규 종가, SPY 시간외 대비 초과 (스펙 §3.2)
async function afterHoursExcess(symbols: Record<string, number>): Promise<number | null> {
  async function ahRet(sym: string): Promise<number | null> {
    try {
      const r = await yf.chart(sym, { period1: new Date(Date.now() - 2 * 86400e3), interval: "5m", includePrePost: true });
      const q = (r.quotes ?? []).filter((x) => x.close != null);
      const meta = r.meta as { regularMarketPrice?: number };
      const regClose = meta.regularMarketPrice;
      if (!q.length || !regClose) return null;
      return Math.log((q[q.length - 1].close as number) / regClose);
    } catch { return null; }
  }
  const spy = await ahRet("SPY");
  let acc = 0, wsum = 0;
  for (const [s, w] of Object.entries(symbols)) {
    const r = await ahRet(s);
    if (r == null) continue;
    acc += w * (r - (spy ?? 0));
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : null;
}

// ── 야간 배치 (06:00~07:15 절단) ──
export async function collectNight(symbol: G1BSymbol): Promise<Record<string, Obs>> {
  const c = G1B_CONFIG.cutoff.r1;
  const [spx, soxx, mu, nvda, gdr, tnx, zt] = await Promise.all([
    dailyRet("^GSPC"), dailyRet("SOXX"), dailyRet("MU"), dailyRet("NVDA"),
    dailyRet("SMSN.IL"), dailyRet("^TNX"), dailyRet("ZT=F"),
  ]);
  const ah = await afterHoursExcess(G1B_CONFIG.ahBasket[symbol]);
  // 글로벡스 스냅샷: NQ=F 현재가 vs 최근 일봉 종가
  let gx: number | null = null;
  try {
    const [cur, hist] = await Promise.all([quote("NQ=F"), dailyRet("NQ=F")]);
    void hist;
    const r = await yf.chart("NQ=F", { period1: new Date(Date.now() - 5 * 86400e3), interval: "1d" });
    const q = (r.quotes ?? []).filter((x) => x.close != null);
    if (cur && q.length) gx = Math.log(cur / (q[q.length - 1].close as number));
  } catch { /* 결측 */ }
  // KRX 야간선물 (KIS — 라이브 당일치, 히스토리 불가 소스의 라이브 재탐색 §1)
  let nightFut: number | null = null;
  try {
    if (hasKisKeys()) {
      const f = await fetchKisNightFutures();
      const fx = f as { changePercent?: number | null };
      nightFut = typeof fx.changePercent === "number" ? fx.changePercent / 100 : null;
    }
  } catch { /* 결측 */ }
  return {
    r_spx: mark(spx, c), r_soxx: mark(soxx, c), r_mu: mark(mu, c), r_nvda: mark(nvda, c),
    r_gdr: mark(gdr, c, "SMSN.IL"), ah_excess: mark(ah, c), gx: mark(gx, c, "NQ=F snap"),
    night_fut: mark(nightFut, c, "KIS 야간선물"),
    tnx: mark(tnx, c), zt: mark(zt, c, "감시 전용"),
  };
}

// 야간선물 단독 스냅샷 — 8/10 실측: 폐장(05:00) 후엔 output1이 빈 응답이라 06시 배치에선 항상 결측.
// 04:50~05:59 창에서 마지막 체결 스냅샷을 선확보한다 (07:15 절단 이전이므로 late_arrival 아님).
export async function fetchNightFutSnapshot(): Promise<Obs> {
  const c = G1B_CONFIG.cutoff.r1;
  try {
    if (!hasKisKeys()) return mark(null, c, "KIS 키 없음");
    // 시장구분 "CM" 확정 (2026-08-15 실측 — 8/11 예정했던 '확정 후 단일 고정' 이행):
    // 종전 후보 1순위 "F"(주간)가 값을 반환해 CM까지 못 갔고, 그 값은 전일 주간 세션 등락률이었다
    // (8/13밤 +3.71 = 주간 1073.70/1035.30, 8/14저녁 4점 +2.35 = 주간 1098.90/1073.70 — 전점 일치).
    // CM 검증: futs_sdpr(기준가) = 당일 주간 종가, futs_prdy_ctrt = 야간 현재가의 주간 종가 대비율
    // = u1 내재갭 정의 그대로. KRX 12902 야간 종가와 수치 교차 일치(1002.50·1069.35·1095.40·1094.95).
    // "F"는 의미상 오답이므로 폴백에서도 제외 — CM 빈 응답이면 결측(null)이 정답이다.
    const f = await fetchKisNightFutures("CM");
    const fx = f as { changePercent?: number | null } | null;
    if (typeof fx?.changePercent === "number") {
      return mark(fx.changePercent / 100, c, "KIS 야간선물 04:50(CM)");
    }
    return mark(null, c, "KIS 야간선물 04:50 CM 빈응답");
  } catch { return mark(null, c, "KIS 야간선물 예외"); }
}

// ── 아침 배치 (08:00~08:45 절단) ──
export async function collectMorning(symbol: G1BSymbol): Promise<Record<string, Obs>> {
  const c = G1B_CONFIG.cutoff.r2;
  const [asx, nk] = await Promise.all([
    (async () => { // ASX 개장 후 변화 (5분봉)
      try {
        const r = await yf.chart("^AXJO", { period1: new Date(Date.now() - 86400e3), interval: "5m" });
        const q = (r.quotes ?? []).filter((x) => x.close != null);
        return q.length >= 2 ? Math.log((q[q.length - 1].close as number) / (q[0].close as number)) : null;
      } catch { return null; }
    })(),
    (async () => { // 니케이 선물 조기 (NKD=F 스냅 vs 전일)
      try {
        const cur = await quote("NKD=F");
        const r = await yf.chart("NKD=F", { period1: new Date(Date.now() - 5 * 86400e3), interval: "1d" });
        const q = (r.quotes ?? []).filter((x) => x.close != null);
        return cur && q.length ? Math.log(cur / (q[q.length - 1].close as number)) : null;
      } catch { return null; }
    })(),
  ]);
  let gx2: number | null = null;
  try {
    const cur = await quote("NQ=F");
    const r = await yf.chart("NQ=F", { period1: new Date(Date.now() - 5 * 86400e3), interval: "1d" });
    const q = (r.quotes ?? []).filter((x) => x.close != null);
    if (cur && q.length) gx2 = Math.log(cur / (q[q.length - 1].close as number));
  } catch { /* 결측 */ }
  // KRX 동시호가 예상체결가 — KIS 호가/예상체결(FHKST01010200) 직접 호출 (§1 가용성 실측:
  // 드라이런 첫 아침에 성패 판정. 실패 시 null → R2 "잔차 판정 보류·관측 결측" 정직 운영)
  const auctionEst = await fetchKisAuctionEstimate(symbol);
  return {
    r_asx: mark(asx, c), r_nk_fut: mark(nk, c), gx2: mark(gx2, c),
    auction_est_px: mark(auctionEst, c, "KIS 예상체결"),
  };
}

// 예상체결 단독 보충 (2026-08-11 결측 감사): 아침 수집이 동시호가(08:30) 전에 완료되면 이 필드만
// null로 남는다 — service의 08:31~08:45 보충 분기에서 호출. 실패 시 null 유지(정직 운영).
export async function refetchAuction(symbol: G1BSymbol): Promise<Obs> {
  return mark(await fetchKisAuctionEstimate(symbol), G1B_CONFIG.cutoff.r2, "KIS 예상체결 08:31 보충");
}

// 예상체결 공표 시각 진단 (2026-08-12 저녁): 08:31~08:45 보충으로도 결측 지속 → 공표 개시가
// 절단(08:45)보다 늦다는 가설. 원시 문자열까지 기록해 "0/빈값/실값"을 구분한다.
export async function fetchAuctionRaw(code: string): Promise<{ raw: string | null; v: number | null }> {
  try {
    if (!hasKisKeys()) return { raw: "no-keys", v: null };
    const token = await getKisToken();
    if (!token) return { raw: "no-token", v: null };
    const base = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
    const url = new URL(`${base}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
    url.searchParams.set("FID_INPUT_ISCD", code);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, appkey: process.env.KIS_APP_KEY ?? "", appsecret: process.env.KIS_APP_SECRET ?? "", tr_id: "FHKST01010200", custtype: "P" },
      cache: "no-store",
    });
    if (!res.ok) return { raw: `http-${res.status}`, v: null };
    const j = (await res.json()) as { output2?: { antc_cnpr?: string } };
    const raw = j.output2?.antc_cnpr ?? null;
    const v = parseFloat(raw ?? "");
    return { raw, v: isFinite(v) && v > 0 ? v : null };
  } catch (e) { return { raw: `err-${e instanceof Error ? e.message.slice(0, 30) : "?"}`, v: null }; }
}

// KIS 호가/예상체결 — output2.antc_cnpr(예상 체결가). 동시호가(08:30~09:00)에만 유의미.
async function fetchKisAuctionEstimate(code: string): Promise<number | null> {
  try {
    if (!hasKisKeys()) return null;
    const token = await getKisToken();
    if (!token) return null;
    const base = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
    const url = new URL(`${base}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
    url.searchParams.set("FID_INPUT_ISCD", code);
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY ?? "", appsecret: process.env.KIS_APP_SECRET ?? "",
        tr_id: "FHKST01010200", custtype: "P",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { output2?: { antc_cnpr?: string } };
    const v = parseFloat(j.output2?.antc_cnpr ?? "");
    return isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

// 전일 종가·당일 시가 (라벨·ExpectedOpen 환산)
export async function krDaily(symbol: G1BSymbol): Promise<{ prevClose: number | null; todayOpen: number | null; dates: string[] }> {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=6&requestType=0`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" }, cache: "no-store" });
    const xml = await res.text();
    const rows = [...xml.matchAll(/<item data="([^"]+)"/g)].map((m) => m[1].split("|"));
    const bars = rows.map((r) => ({ d: r[0], o: parseFloat(r[1]), c: parseFloat(r[4]) })).filter((b) => isFinite(b.o) && isFinite(b.c));
    if (bars.length < 2) return { prevClose: null, todayOpen: null, dates: [] };
    const last = bars[bars.length - 1], prev = bars[bars.length - 2];
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    return last.d === today
      ? { prevClose: prev.c, todayOpen: last.o > 0 ? last.o : null, dates: [prev.d, last.d] }
      : { prevClose: last.c, todayOpen: null, dates: [last.d] };
  } catch { return { prevClose: null, todayOpen: null, dates: [] }; }
}
