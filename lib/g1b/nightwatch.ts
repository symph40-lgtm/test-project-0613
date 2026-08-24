// 야간 감시 체계 (발주자 지시 2026-08-20 — T2 이후 ~ R1 이전 구간). 기록·알림 전용, 판정 무개입.
//   §1 체크포인트 23:40경(미 정규장 개장 직후)·03:00경(미 장중): {야간선물 누적·미 선물·SOXX/나스닥 당일 흐름} 스냅샷
//   §2 야간 역행 경보: T2 판정 방향(또는 가상 포지션) 대비 야간선물 누적 ±1.5% 이상 역행 → 신호 알림(전역 정지 준수)
//   §3 밤의 궤적: 저녁 NXT 마감 → 23:40 → 03:00 → 06:00 야간선물 마감 4점 (R1 카드 한 줄)
//   §4 리그전: 애프터 최종가 vs 야간선물 마감가 — 누가 시가에 가까웠나 (라벨 창에서 채점)
// 저장: g1b_days[date = 다음 거래일 라벨].night.watch = { cp: {...}, alert: {...}, path: {...} }
// 크론: 야간 구간(23:30~03:30) 호출이 필요 — 현 등록(06:00~11:00)엔 없음. 호출이 오면 동작, 없으면 cp 결측으로 드러남.

import YahooFinance from "yahoo-finance2";
import type { G1BSymbol } from "./config";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type Checkpoint = {
  t: string;                 // KST HH:MM
  nf_pct: number | null;     // 야간선물 누적 (주간 종가 대비, CM)
  nq_fut_pct: number | null; // NQ=F 16:00 KST(미 선물 재개) 이후 변화
  soxx_pct: number | null;   // SOXX 당일 (전일 종가 대비 현재)
  ndx_pct: number | null;    // ^IXIC 당일
  fetch_ts: string;
};

export async function dayChange(sym: string): Promise<number | null> {
  try {
    const q = await yf.quote(sym) as { regularMarketChangePercent?: number; preMarketChangePercent?: number; marketState?: string };
    // [발주자 지적 8/24 20:06] 프리마켓 중(marketState PRE)엔 regular 등락률이 '직전 정규장 마감값'으로 정체 —
    // 그 정체값을 당일 값처럼 기록하던 결함 교정: PRE엔 프리장 라이브(전일 종가 대비, 같은 기준)만 쓰고, 없으면 null.
    if (q.marketState === "PRE") {
      const p = q.preMarketChangePercent;
      return typeof p === "number" ? Math.round(p * 100) / 100 : null;
    }
    const v = q.regularMarketChangePercent;
    return typeof v === "number" ? Math.round(v * 100) / 100 : null;
  } catch { return null; }
}

export async function nqSince16kst(): Promise<number | null> {
  try {
    const r = await yf.chart("NQ=F", { period1: new Date(Date.now() - 2 * 86400e3), interval: "5m" });
    const qs = (r.quotes ?? []).filter((q) => q.close != null);
    if (qs.length < 2) return null;
    // 16:00 KST 당일 = 07:00 UTC 당일 (KST 날짜 기준) — 자정 넘으면 전날 16:00 KST
    const nowK = new Date(Date.now() + 9 * 3600e3);
    const kstDate = nowK.toISOString().slice(0, 10);
    let anchor = new Date(kstDate + "T07:00:00Z");
    if (nowK.getUTCHours() < 16) anchor = new Date(anchor.getTime() - 86400e3);
    const from = qs.filter((q) => (q.date as Date) >= anchor);
    if (from.length < 2) return null;
    return Math.round(((from[from.length - 1].close as number) / (from[0].close as number) - 1) * 10000) / 100;
  } catch { return null; }
}

export async function takeCheckpoint(hhmm: string): Promise<Checkpoint> {
  let nf: number | null = null;
  try {
    const { fetchKisNightFutures, hasKisKeys } = await import("@/lib/market/kis");
    if (hasKisKeys()) {
      const q = await fetchKisNightFutures("CM");
      const v = (q as { changePercent?: number | null })?.changePercent;
      if (typeof v === "number") nf = v;
    }
  } catch { /* 결측 */ }
  const [nq, soxx, ndx] = await Promise.all([nqSince16kst(), dayChange("SOXX"), dayChange("^IXIC")]);
  return { t: hhmm, nf_pct: nf, nq_fut_pct: nq, soxx_pct: soxx, ndx_pct: ndx, fetch_ts: new Date().toISOString() };
}

// §2 역행 판정 — 기준: T2 방향(UP/DOWN) 또는 가상 포지션. 야간선물 누적 × 방향 부호 ≤ −1.5% → 역행.
export function reverseCheck(t2Dir: string | null, nfPct: number | null): { fired: boolean; why: string | null } {
  if (!t2Dir || t2Dir === "NEUTRAL" || nfPct == null) return { fired: false, why: null };
  const against = t2Dir === "UP" ? nfPct <= -1.5 : nfPct >= 1.5;
  return against ? { fired: true, why: `저녁 판정 ${t2Dir === "UP" ? "갭상승" : "갭하락"} vs 야간선물 누적 ${nfPct >= 0 ? "+" : ""}${nfPct.toFixed(2)}% — 저녁 판단이 밤중에 뒤집히는 중` } : { fired: false, why: null };
}

// §3 밤의 궤적 한 줄 — 저녁 NXT 마감(종목, 정규 종가 대비) → 23:40 → 03:00 → 06:00 마감 (야간선물 누적)
export function nightPathLine(a: {
  nxtClosePct: number | null; cp2340: Checkpoint | null; cp0300: Checkpoint | null; nfClosePct: number | null; beta: number;
}): string {
  const f = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  const seg = (cp: Checkpoint | null, label: string) => cp ? `${cp.t} ${f(cp.nf_pct)}` : `${label} 결측`;
  const nfB = a.nfClosePct != null ? ` (β환산 ${f(a.nfClosePct * a.beta)})` : "";
  return `밤의 궤적: 저녁 NXT 마감 ${f(a.nxtClosePct)} → 야간선물 ${seg(a.cp2340, "23:40")} → ${seg(a.cp0300, "03:00")} → 06:00 마감 ${f(a.nfClosePct)}${nfB}`;
}

// §4 리그전 채점 — 애프터 최종가(정규 종가 대비 %) vs 야간선물 마감 β환산 vs 실측 갭
export function leagueScore(a: { nxtClosePct: number | null; nfCloseBeta: number | null; actualGap: number }): {
  err_nxt: number | null; err_nf: number | null; winner: "nxt" | "nf" | "tie" | null;
} {
  const e1 = a.nxtClosePct != null ? Math.round(Math.abs(a.nxtClosePct - a.actualGap) * 100) / 100 : null;
  const e2 = a.nfCloseBeta != null ? Math.round(Math.abs(a.nfCloseBeta - a.actualGap) * 100) / 100 : null;
  const winner = e1 == null || e2 == null ? null : Math.abs(e1 - e2) < 0.05 ? "tie" : e1 < e2 ? "nxt" : "nf";
  return { err_nxt: e1, err_nf: e2, winner };
}

export const NIGHT_SYMBOLS: G1BSymbol[] = ["005930", "000660"];
