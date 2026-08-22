// G1A v0.3 라이브 수집기 — 스펙 §4·§8. 전 소스는 T2 시점(16:30~19:55 KST)에 실제로 뜨는 것만.
// 야후 시세는 수 분 지연 가능 — log-only 기간 기록으로 지연 실측 (스펙 §8 감사 항목).

import YahooFinance from "yahoo-finance2";
import { fetchDayMinutes, fetchNxtAfterMarket } from "@/lib/predict/kisMinute";
import { fetchRecentFlow } from "@/lib/predict-daily/flow"; // 공용 참조 전례: 캘린더·kisToken과 동일
import { G1A_CONFIG } from "./config";
import type { G1ASymbol, T2Features } from "./types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

type Bar = { ts: Date; close: number };

async function chart5m(symbol: string, days = 2, prePost = false): Promise<Bar[]> {
  try {
    const r = await yf.chart(symbol, {
      period1: new Date(Date.now() - days * 86400e3),
      interval: "5m",
      includePrePost: prePost,
    });
    return (r.quotes ?? [])
      .filter((q) => q.close != null && isFinite(q.close as number))
      .map((q) => ({ ts: q.date instanceof Date ? q.date : new Date(q.date), close: q.close as number }));
  } catch {
    return [];
  }
}

async function dailyCloses(symbol: string, days: number): Promise<{ date: string; close: number }[]> {
  try {
    const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
    return (r.quotes ?? [])
      .filter((q) => q.close != null)
      .map((q) => ({
        date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
        close: q.close as number,
      }));
  } catch {
    return [];
  }
}

const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const kstHHMM = () => kstNow().toISOString().slice(11, 16);
const kstDate = () => kstNow().toISOString().slice(0, 10);

// ET 기준 오늘 프리마켓(04:00~09:30 ET) 봉만
function premarketBars(bars: Bar[]): Bar[] {
  const now = new Date();
  const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const etToday = etFmt.format(now);
  return bars.filter((b) => {
    if (etFmt.format(b.ts) !== etToday) return false;
    const et = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(b.ts);
    return et >= "04:00" && et < "09:30";
  });
}

// ── F21: 프리마켓 바스켓 + DC-PM ──
export async function fetchPremarketBasket(symbol: G1ASymbol): Promise<{
  rBasket: number | null; dcpm: number | null; obsMin: number | null;
}> {
  const cfg = G1A_CONFIG.basket[symbol];
  const parts: { w: number; ret: number; bars: Bar[] }[] = [];
  for (const [tk, w] of Object.entries(cfg.weights)) {
    const [bars, daily] = await Promise.all([chart5m(tk, 2, true), dailyCloses(tk, 10)]);
    const pm = premarketBars(bars);
    if (!pm.length || daily.length < 1) continue;
    const prevClose = daily[daily.length - 1].close; // 전일 정규장 종가 (프리마켓 중엔 마지막 일봉 = 전일)
    let ret = ((pm[pm.length - 1].close - prevClose) / prevClose) * 100;
    if (tk === "SOXL") ret /= cfg.soxlDiv;
    parts.push({ w, ret, bars: pm });
  }
  if (!parts.length) return { rBasket: null, dcpm: null, obsMin: null };
  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const rBasket = parts.reduce((a, p) => a + p.w * p.ret, 0) / wSum;
  // DC-PM: 최대 가중 구성종목의 프리마켓 10분 그룹 중 바스켓 방향과 동방향 비율 (스펙 DC1 이식 — 근사)
  const main = parts.sort((a, b) => b.w - a.w)[0];
  const dir = Math.sign(rBasket);
  let same = 0, total = 0;
  for (let i = 0; i + 2 <= main.bars.length; i += 2) {
    const d = main.bars[i + 1].close - main.bars[i].close;
    if (d === 0) continue;
    total++;
    if (Math.sign(d) === dir) same++;
  }
  const first = main.bars[0].ts.getTime();
  return {
    rBasket: Math.round(rBasket * 100) / 100,
    dcpm: total >= 3 ? same / total : null,
    obsMin: Math.round((Date.now() - first) / 60000),
  };
}

// ── F22: 미 선물 16:00 KST 이후 변화 ──
export async function fetchUsFutDelta(): Promise<number | null> {
  const bars = await chart5m("NQ=F", 2);
  if (!bars.length) return null;
  const anchor = new Date(kstDate() + "T07:00:00Z"); // 16:00 KST = 07:00 UTC
  const from = bars.filter((b) => b.ts >= anchor);
  if (from.length < 2) return null;
  return Math.round(((from[from.length - 1].close - from[0].close) / from[0].close) * 10000) / 100;
}

// ── F20: 유럽 개장(16:00 KST) 이후 톤 ──
export async function fetchEuropeTone(): Promise<{ pct: number | null; obsMin: number | null }> {
  const bars = await chart5m("^STOXX50E", 2);
  const anchor = new Date(kstDate() + "T07:00:00Z");
  const from = bars.filter((b) => b.ts >= anchor);
  if (from.length < 2) return { pct: null, obsMin: null };
  return {
    pct: Math.round(((from[from.length - 1].close - from[0].close) / from[0].close) * 10000) / 100,
    obsMin: Math.round((Date.now() - from[0].ts.getTime()) / 60000),
  };
}

// ── F11': TSMC 잔차 = 당일 TSMC − β·전일밤 SOXX ──
export async function fetchTsmcResidual(): Promise<number | null> {
  const [tw, sox] = await Promise.all([dailyCloses("2330.TW", 12), dailyCloses("^SOX", 12)]);
  if (tw.length < 2 || sox.length < 2) return null;
  const today = kstDate();
  const twLast = tw[tw.length - 1];
  if (twLast.date !== today) return null; // 대만 당일 종가 미확정
  const rTw = ((twLast.close - tw[tw.length - 2].close) / tw[tw.length - 2].close) * 100;
  const soxPrev = sox.filter((s) => s.date < today);
  if (soxPrev.length < 2) return null;
  const rSox = ((soxPrev[soxPrev.length - 1].close - soxPrev[soxPrev.length - 2].close) / soxPrev[soxPrev.length - 2].close) * 100;
  return Math.round((rTw - G1A_CONFIG.tsmcBetaSoxx * rSox) * 100) / 100;
}

// ── F01/F02/F04: 당일 국장 캐릭터 (KIS 분봉, 15:05까지) ──
export async function fetchDayCharacter(symbol: G1ASymbol): Promise<{
  clv: number | null; dc1: number | null; o1: T2Features["F04_o1"]; regClose: number | null;
}> {
  const ymd = kstDate().replace(/-/g, "");
  const mins = await fetchDayMinutes(symbol, ymd, "153000");
  if (!mins || mins.length < 60) return { clv: null, dc1: null, o1: null, regClose: null };
  const upto = mins.filter((b) => b.time <= "15:05");
  const hi = Math.max(...upto.map((b) => b.high));
  const lo = Math.min(...upto.map((b) => b.low));
  const clv = hi > lo ? (upto[upto.length - 1].close - lo) / (hi - lo) : 0.5;
  let up = 0, down = 0;
  for (let i = 0; i + 10 <= upto.length; i += 10) {
    const d = upto[i + 9].close - upto[i].open;
    if (d > 0) up++; else if (d < 0) down++;
  }
  const dc1 = up + down ? (up - down) / (up + down) : 0;
  // 시가 유형 (O1 간략판 — v0.1 검증 로직 이식)
  const first30 = mins.filter((b) => b.time <= "09:30");
  let o1: T2Features["F04_o1"] = null;
  if (first30.length >= 20) {
    const o = first30[0].open, c = first30[first30.length - 1].close;
    const h30 = Math.max(...first30.map((b) => b.high)), l30 = Math.min(...first30.map((b) => b.low));
    const move = ((c - o) / o) * 100;
    const backfill = c > o ? ((o - l30) / o) * 100 : ((h30 - o) / o) * 100;
    o1 = Math.abs(move) >= 0.7 && backfill <= 0.2 ? (move > 0 ? "OD_up" : "OD_down")
      : Math.abs(move) >= 0.5 ? "OTD" : "OA";
  }
  return { clv: Math.round(clv * 100) / 100, dc1: Math.round(dc1 * 100) / 100, o1, regClose: mins[mins.length - 1].close };
}

// ── F08: 외인 감속률 (마감 확정치 — T2 시점 가용) ──
// F08_frn_decel_prev (발주자 판정 2026-08-11 / A1-8): T1(15:05) 시점엔 당일 확정치가 없어 4일 전결측
// → 전일 확정 기준 감속률을 '별도 필드'로 기록·가상점수 입력. 당일 확정 원 정의(F08)는 T2 전용 유지.
export async function fetchFrnDecelPrev(symbol: G1ASymbol): Promise<number | null> {
  const flow = await fetchRecentFlow(symbol);
  if (flow.length < 12) return null;
  const today = kstDate();
  const past = flow.filter((f) => f.date < today);
  if (past.length < 11) return null;
  const last = past[past.length - 1];
  const prevs = past.slice(-21, -1).map((f) => Math.abs(f.frgn));
  const avg = prevs.reduce((a, b) => a + b, 0) / prevs.length;
  return avg > 0 ? Math.round((last.frgn / avg) * 100) / 100 : null;
}

export async function fetchFrnDecel(symbol: G1ASymbol): Promise<number | null> {
  const flow = await fetchRecentFlow(symbol);
  if (flow.length < 12) return null;
  const today = flow[flow.length - 1];
  if (today.date !== kstDate()) return null; // 당일 확정치 미반영
  const prevs = flow.slice(-21, -1).map((f) => Math.abs(f.frgn));
  const avg = prevs.reduce((a, b) => a + b, 0) / prevs.length;
  return avg > 0 ? Math.round((today.frgn / avg) * 100) / 100 : null;
}

// ── F13/F14: 매크로 z (글로벡스 금리 선물·환율 — 저녁 실시간 관측 가능분) ──
async function zOfDayChange(symbol: string, invert = false): Promise<number | null> {
  const [bars, daily] = await Promise.all([chart5m(symbol, 2), dailyCloses(symbol, 90)]);
  if (bars.length < 2 || daily.length < 40) return null;
  const anchor = new Date(kstDate() + "T00:00:00Z"); // KST 09:00
  const from = bars.filter((b) => b.ts >= anchor);
  if (from.length < 2) return null;
  const chg = ((from[from.length - 1].close - from[0].close) / from[0].close) * 100;
  const rets: number[] = [];
  for (let i = 1; i < daily.length; i++) rets.push(((daily[i].close - daily[i - 1].close) / daily[i - 1].close) * 100);
  const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length);
  if (!sd) return null;
  const z = chg / sd;
  return Math.round((invert ? -z : z) * 100) / 100;
}
export async function fetchMacroZ(): Promise<{ rateZ: number | null; fxZ: number | null }> {
  // ZN=F(10Y 노트 선물): 가격↑=금리↓ → invert로 '금리 방향' z. KRW=X: 원화 약세(상승)=+z.
  const [rate, fx] = await Promise.all([zOfDayChange("ZN=F", true), zOfDayChange("KRW=X", false)]);
  return { rateZ: rate, fxZ: fx };
}

// ── r_NXT: 당일 NXT 애프터 기반영 수익률 + 최근 체결가 ──
export async function fetchNxtState(symbol: G1ASymbol, regClose: number | null): Promise<{
  rNxt: number | null; lastPx: number | null;
}> {
  const ymd = kstDate().replace(/-/g, "");
  const bars = await fetchNxtAfterMarket(symbol, ymd, kstHHMM().replace(":", "") + "00");
  if (!bars || !bars.length) return { rNxt: null, lastPx: null };
  const last = bars[bars.length - 1].close;
  if (!regClose || !(last > 0)) return { rNxt: null, lastPx: last > 0 ? last : null };
  return { rNxt: Math.round(((last - regClose) / regClose) * 10000) / 100, lastPx: last };
}

// ── T1 스냅샷 전용 (v0.2 §5.1.2 T1 열): TSMC 원수익률(13:30 확정) + NQ 아시아 세션 ──
export async function fetchT1Globals(): Promise<{ tsmcRaw: number | null; nqAsia: number | null }> {
  const today = kstDate();
  const [tw, nq] = await Promise.all([dailyCloses("2330.TW", 12), chart5m("NQ=F", 2)]);
  let tsmcRaw: number | null = null;
  if (tw.length >= 2 && tw[tw.length - 1].date === today) {
    tsmcRaw = Math.round(((tw[tw.length - 1].close - tw[tw.length - 2].close) / tw[tw.length - 2].close) * 10000) / 100;
  }
  const anchor = new Date(today + "T00:00:00Z"); // 09:00 KST
  const from = nq.filter((b) => b.ts >= anchor);
  const nqAsia = from.length >= 2
    ? Math.round(((from[from.length - 1].close - from[0].close) / from[0].close) * 10000) / 100
    : null;
  return { tsmcRaw, nqAsia };
}

// ── 저녁 정보 조각 P1~P5 (발주자 8/12 §3 — 확보분부터 기록, T2 본 판정 미사용) ──
// 소스 조사 결과: P1 유럽 반도체 3종(ASML.AS·IFX.DE·STMPA.PA — 야후 실시간) 확보 /
// P3 프리마켓 거래량(바스켓 prepost 봉 합) 부분 확보 /
// P2 TAIFEX(공개 API 없음 — 1주차 판정 유지)·P4 목표가/공매도(무료 실시간 소스 없음)·
// P5 옵션 스큐(소스 없음) 미확보 — 확보 시 effective_start 자동 태깅.
export async function fetchEveningPieces(symbol: G1ASymbol): Promise<Record<string, number | null>> {
  async function sessionChg(sym: string): Promise<number | null> {
    try {
      const r = await yf.chart(sym, { period1: new Date(Date.now() - 86400e3), interval: "5m" });
      const q = (r.quotes ?? []).filter((x) => x.close != null);
      return q.length >= 2 ? Math.round(((q[q.length - 1].close as number) / (q[0].close as number) - 1) * 10000) / 100 : null;
    } catch { return null; }
  }
  const [asml, ifx, stm] = await Promise.all([sessionChg("ASML.AS"), sessionChg("IFX.DE"), sessionChg("STMPA.PA")]);
  const eu = [asml, ifx, stm].filter((x): x is number => x != null);
  // P3: 바스켓 프리마켓 누적 거래량 (유동성 프록시 — 방향 아님)
  let pmVol: number | null = null;
  try {
    const main = symbol === "000660" ? "MU" : "NVDA";
    const r = await yf.chart(main, { period1: new Date(Date.now() - 2 * 86400e3), interval: "5m", includePrePost: true });
    const pm = premarketBars((r.quotes ?? []).filter((x) => x.close != null).map((x) => ({ ts: x.date instanceof Date ? x.date : new Date(x.date), close: x.close as number })));
    void pm;
    const vols = (r.quotes ?? []).filter((x) => x.volume != null && (x.volume as number) > 0);
    pmVol = vols.length ? vols.slice(-24).reduce((a, x) => a + (x.volume as number), 0) : null;
  } catch { /* 결측 */ }
  return {
    p1_asml: asml, p1_ifx: ifx, p1_stm: stm,
    p1_eu_semi_avg: eu.length ? Math.round(eu.reduce((a, b) => a + b, 0) / eu.length * 100) / 100 : null,
    p3_pm_vol: pmVol,
  };
}

// ── 서킷브레이커 프록시 (v0.1 반사실 검정 통과 규칙) ──
export async function fetchCircuitBreaker(): Promise<boolean> {
  try {
    const r = await yf.chart("^KS11", { period1: new Date(Date.now() - 7 * 86400e3), interval: "1d" });
    const q = (r.quotes ?? []).filter((x) => x.close != null && x.low != null);
    if (q.length < 2) return false;
    // 당일·전일 두 구간 검사 (당일·익일 abstain)
    for (let i = Math.max(1, q.length - 2); i < q.length; i++) {
      const prev = q[i - 1].close as number;
      if (((q[i].low as number) - prev) / prev * 100 <= G1A_CONFIG.abstain.circuitBreakerPct) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── F15: 오늘 밤 바이너리 이벤트 (매크로 캘린더 + 반도체 실적) ──
export async function fetchEventTonight(): Promise<string | null> {
  const today = kstDate();
  const { FOMC_DECISION_DATES, CPI_RELEASE_DATES, ES_RELEASE_DATES } = await import("@/lib/predict-daily/eventCalendar");
  if (FOMC_DECISION_DATES.includes(today)) return "FOMC";
  if (CPI_RELEASE_DATES.includes(today)) return "CPI";
  if (ES_RELEASE_DATES.includes(today)) return "고용";
  try {
    const { fetchSemiAiEarnings } = await import("@/lib/market/earnings");
    const ev = await fetchSemiAiEarnings(2);
    const tonight = ev.find((e) => e.date === today);
    if (tonight) return `실적 ${tonight.symbol}`;
  } catch { /* 실적 조회 실패는 결측 처리 */ }
  return null;
}

// ── T2+ v2 성분 (발주 D 8/20) — 전부 변화율·기울기만 (레벨 금지 원칙) ──
// ⓐ 미 프리장 바스켓 마지막 30분 변화율 (가속/감속): 바스켓 가중 합의 최근 30분 로그수익률
export async function fetchBasketAccel30m(symbol: G1ASymbol): Promise<number | null> {
  const cfg = G1A_CONFIG.basket[symbol];
  let acc = 0, got = 0;
  for (const [tk, w] of Object.entries(cfg.weights)) {
    const bars = await chart5m(tk, 2, true);
    if (bars.length < 8) continue;
    const cut = bars[bars.length - 1].ts.getTime() - 30 * 60_000;
    const win = bars.filter((b) => b.ts.getTime() >= cut);
    if (win.length < 2) continue;
    const chg = (win[win.length - 1].close / win[0].close - 1) * 100 / (tk === "SOXL" ? cfg.soxlDiv : 1);
    acc += w * chg; got += w;
  }
  return got > 0.5 ? Math.round((acc / got) * 100) / 100 : null;
}
// ⓕ 매크로 저녁 변화율: 17:00 KST → 현재. 10Y(^TNX, bp)·달러원(KRW=X, %)·WTI(CL=F, %) — 레벨 절대 금지
export async function fetchMacroEveningDelta(): Promise<{ dTnxBp: number | null; dFxPct: number | null; dWtiPct: number | null }> {
  const today = kstDate();
  const anchor = new Date(today + "T08:00:00Z"); // 17:00 KST
  const delta = async (sym: string, asBp: boolean): Promise<number | null> => {
    const bars = await chart5m(sym, 2);
    const from = bars.filter((b) => b.ts >= anchor);
    if (from.length < 2) return null;
    const a = from[0].close, b = from[from.length - 1].close;
    return asBp ? Math.round((b - a) * 100 * 10) / 10 : Math.round((b / a - 1) * 10000) / 100; // ^TNX는 10배 스케일(4.25=4.25%) → bp = Δ×100
  };
  const [t, f, w] = await Promise.all([delta("^TNX", true), delta("KRW=X", false), delta("CL=F", false)]);
  return { dTnxBp: t, dFxPct: f, dWtiPct: w };
}

// ── T2+ v2.1 성분 조달 (발주자 등재 지시 8/22 — 변화율·기울기·갭만, 레벨 금지) ──
// ⓐ' 바스켓 3창(30분/60분/프리마켓 세션) 변화율 + 2차 가속(최근30분 − 직전30분) + 갭(프리 시작가 vs 전일 최종가 — 프리·포스트 포함 차트의 직전 봉 근사, 명기)
export async function fetchBasketWindows(symbol: G1ASymbol): Promise<{ r30: number | null; r60: number | null; rSess: number | null; gap: number | null; accel2: number | null }> {
  const cfg = G1A_CONFIG.basket[symbol];
  const acc = { r30: 0, r60: 0, rSess: 0, r30prev: 0, gap: 0 };
  let got = 0, gapGot = 0;
  const anchor = new Date(kstDate() + "T08:00:00Z");   // 미 프리마켓 시작 17:00 KST
  for (const [tk, w] of Object.entries(cfg.weights)) {
    const bars = await chart5m(tk, 2, true);
    if (bars.length < 14) continue;
    const div = tk === "SOXL" ? cfg.soxlDiv : 1;
    const last = bars[bars.length - 1];
    const at = (minAgo: number) => { const cut = last.ts.getTime() - minAgo * 60_000; const win = bars.filter((b) => b.ts.getTime() >= cut); return win.length >= 2 ? win[0].close : null; };
    const c30 = at(30), c60 = at(60);
    const sess = bars.filter((b) => b.ts >= anchor);
    const sessOpen = sess.length >= 2 ? sess[0].close : null;
    const prevBar = [...bars].reverse().find((b) => b.ts < anchor) ?? null;
    const pct = (from: number | null, to: number) => (from ? ((to / from - 1) * 100) / div : null);
    const r30 = pct(c30, last.close), r60 = pct(c60, last.close), rSess = pct(sessOpen, last.close);
    const r30prev = c60 != null && c30 != null ? ((c30 / c60 - 1) * 100) / div : null;
    if (r30 == null || r60 == null || rSess == null || r30prev == null) continue;
    acc.r30 += w * r30; acc.r60 += w * r60; acc.rSess += w * rSess; acc.r30prev += w * r30prev; got += w;
    const gap = prevBar && sessOpen ? ((sessOpen / prevBar.close - 1) * 100) / div : null;
    if (gap != null) { acc.gap += w * gap; gapGot += w; }
  }
  if (got < 0.5) return { r30: null, r60: null, rSess: null, gap: null, accel2: null };
  const r2 = (v: number) => Math.round((v / got) * 100) / 100;
  return { r30: r2(acc.r30), r60: r2(acc.r60), rSess: r2(acc.rSess), gap: gapGot > 0.5 ? Math.round((acc.gap / gapGot) * 100) / 100 : null, accel2: Math.round(((acc.r30 - acc.r30prev) / got) * 100) / 100 };
}

// ⓓ' P1 유럽 반도체 다창 — 현지 거래소 5분봉(ASML.AS·IFX.DE·STMPA.PA, 8/22 실측 가용): 세션 변화율 + 종반(최근) 30분
export async function fetchP1Windows(): Promise<{ r30: number | null; rSess: number | null }> {
  const out: { r30: number; rSess: number }[] = [];
  const anchor = new Date(kstDate() + "T07:00:00Z");   // 유럽 개장 16:00 KST (CEST 기준 — 동절기 17:00, 명기)
  for (const tk of ["ASML.AS", "IFX.DE", "STMPA.PA"]) {
    const bars = await chart5m(tk, 2);
    if (bars.length < 8) continue;
    const last = bars[bars.length - 1];
    const sess = bars.filter((b) => b.ts >= anchor);
    const cut = last.ts.getTime() - 30 * 60_000;
    const w30 = bars.filter((b) => b.ts.getTime() >= cut);
    if (sess.length < 2 || w30.length < 2) continue;
    out.push({ r30: (last.close / w30[0].close - 1) * 100, rSess: (last.close / sess[0].close - 1) * 100 });
  }
  if (!out.length) return { r30: null, rSess: null };
  const avg = (k: "r30" | "rSess") => Math.round((out.reduce((a, b) => a + b[k], 0) / out.length) * 100) / 100;
  return { r30: avg("r30"), rSess: avg("rSess") };
}

// ⓔ' 이벤트 2등급 자동 감지 — 1급: 기존 fetchEventTonight(FOMC·CPI·고용·워치리스트 실적) + 바스켓 구성·삼전·하닉·AAPL·TSM 실적 /
// 2급: FRED 발표 캘린더 ★3 이상 2차 지표(PCE·GDP·실업수당·ISM 등) — 수동 입력 없음
export async function fetchEventsTiered(): Promise<{ tier1: string | null; tier2: string[] }> {
  const today = kstDate();
  let tier1 = await fetchEventTonight();
  if (!tier1) {
    try {
      const res = await yf.quote(["NVDA", "MU", "AMD", "SOXL", "005930.KS", "000660.KS", "AAPL", "TSM"]) as unknown;
      for (const x of (Array.isArray(res) ? res : [res]) as Record<string, unknown>[]) {
        const ts = x.earningsTimestamp ?? x.earningsTimestampStart;
        const d = ts instanceof Date ? ts : typeof ts === "number" ? new Date(ts * (ts < 1e12 ? 1000 : 1)) : null;
        if (d && d.toISOString().slice(0, 10) === today) { tier1 = `실적 ${String(x.symbol)}`; break; }
      }
    } catch { /* 결측 허용 */ }
  }
  const tier2: string[] = [];
  try {
    const { fetchUpcomingUsEvents } = await import("@/lib/calendar/fred");
    for (const e of await fetchUpcomingUsEvents(1)) {
      if (e.date === today && e.stars >= 3 && !/CPI|소비자물가|고용|FOMC|비농업/.test(e.name)) tier2.push(e.name);
    }
  } catch { /* FRED 실패 = 2급 결측 */ }
  return { tier1, tier2 };
}
