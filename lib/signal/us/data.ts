// 미국 신호 — 데이터 수집·저장 어댑터. 야후 시세(SMH·USD·SSG·^SOX·NQ=F·^TNX·DXY·CL=F·^VIX)를
// 1틱으로 수집해 us_signal_ticks에 적재하고, 한국 엔진(computeTrend)이 그대로 쓸 수 있게
// IntradayTick으로 매핑한다 (SMH→futPx 계열, 가상 KST 분: 09:30 ET = 540).

import YahooFinance from "yahoo-finance2";
import { createAdminClient } from "@/lib/supabase/admin";
import { US_SIGNAL_CONFIG } from "./config";
import type { IntradayTick, DailyBar } from "../types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ── ET 현재 시각 (DST 자동 — Intl 사용)
export function etNow(): { date: string; minuteOfDay: number; iso: string } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? 0 : parseInt(parts.hour, 10);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + parseInt(parts.minute, 10),
    iso: now.toISOString(),
  };
}

// ET 분 → 가상 KST 분 (개장 09:30 ET ↔ 540). 세션 밖이면 그대로 환산해 반환 (판정에서 세션 체크).
export function toVirtualMin(etMin: number): number {
  return 540 + (etMin - US_SIGNAL_CONFIG.session.openEt);
}

export type UsTickRow = {
  date: string; ts: string; minute_of_day: number;
  smh_px: number | null; smh_chg: number | null;
  usd_px: number | null; usd_chg: number | null; ssg_chg: number | null;
  sox_chg: number | null; nq_chg: number | null;
  us10y_px: number | null; us10y_chg_pp: number | null;
  dxy_chg: number | null; wti_chg: number | null;
  vix_px: number | null; vix_chg: number | null;
  smh_vol?: number | null; // SMH 당일 누적 거래량 (TV 신호용 — 마이그레이션 023)
  // ── 아래는 표시용 라이브 레벨 (사용자 지정 2026-07-13: 축1에 실제 값 병기) — DB 미저장.
  // appendUsTick이 INSERT 전에 제거한다 (us_signal_ticks에 컬럼 없음 — 마이그레이션 불필요)
  dxy_px?: number | null; wti_px?: number | null; nq_px?: number | null;
};

// DB에 저장하지 않는 표시용 필드 — INSERT 전에 분리
const DISPLAY_ONLY_FIELDS = ["dxy_px", "wti_px", "nq_px"] as const;

async function quote(symbol: string): Promise<{ px: number | null; chg: number | null; prev: number | null; vol: number | null }> {
  try {
    const q = await yf.quote(symbol);
    const px = typeof q.regularMarketPrice === "number" ? q.regularMarketPrice : null;
    const chg = typeof q.regularMarketChangePercent === "number" ? q.regularMarketChangePercent : null;
    const prev = typeof q.regularMarketPreviousClose === "number" ? q.regularMarketPreviousClose : null;
    const vol = typeof q.regularMarketVolume === "number" ? q.regularMarketVolume : null;
    return { px, chg, prev, vol };
  } catch {
    return { px: null, chg: null, prev: null, vol: null };
  }
}

// 현재 시점 스냅샷 1틱
export async function collectUsTick(): Promise<UsTickRow> {
  const { date, minuteOfDay, iso } = etNow();
  const S = US_SIGNAL_CONFIG.symbols;
  const [smh, usd, ssg, sox, nq, tnx, dxy, wti, vix] = await Promise.all([
    quote(S.judge), quote(S.leverage), quote(S.inverse), quote(S.refIndex),
    quote("NQ=F"), quote("^TNX"), quote("DX-Y.NYB"), quote("CL=F"), quote("^VIX"),
  ]);
  // ^TNX: 금리 % 레벨 — 전일 대비 %p = px - prev
  const us10yPp = tnx.px !== null && tnx.prev !== null ? Number((tnx.px - tnx.prev).toFixed(4)) : null;
  return {
    date, ts: iso, minute_of_day: toVirtualMin(minuteOfDay),
    smh_px: smh.px, smh_chg: smh.chg,
    usd_px: usd.px, usd_chg: usd.chg, ssg_chg: ssg.chg,
    sox_chg: sox.chg, nq_chg: nq.chg,
    us10y_px: tnx.px, us10y_chg_pp: us10yPp,
    dxy_chg: dxy.chg, wti_chg: wti.chg,
    vix_px: vix.px, vix_chg: vix.chg,
    smh_vol: smh.vol,
    dxy_px: dxy.px, wti_px: wti.px, nq_px: nq.px,
  };
}

const MIN_TICK_GAP_MS = 30_000;

export async function appendUsTick(row: UsTickRow): Promise<boolean> {
  const admin = createAdminClient();
  const { data: lastRows } = await admin
    .from("us_signal_ticks").select("ts").eq("date", row.date).order("ts", { ascending: false }).limit(1);
  const lastTs = lastRows?.[0]?.ts ? new Date(lastRows[0].ts).getTime() : 0;
  if (Date.now() - lastTs < MIN_TICK_GAP_MS) return false;
  const dbRow: Record<string, unknown> = { ...row };
  for (const k of DISPLAY_ONLY_FIELDS) delete dbRow[k];
  // 마이그레이션 미적용 폴백 — 없는 컬럼만 정확히 빼고 재시도 (한국 store.ts와 동일 원칙:
  // 2026-07-13 사고 교훈 — 통째로 버리면 다른 컬럼 데이터까지 소실된다)
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await admin.from("us_signal_ticks").insert(dbRow);
    if (!error) return true;
    const m = error.message.match(/'([a-z0-9_]+)' column/i) ?? error.message.match(/column "([a-z0-9_]+)"/i);
    const col = m?.[1];
    if (!col || !(col in dbRow) || col === "date" || col === "ts") return false;
    delete dbRow[col];
  }
  return false;
}

export async function loadUsTicks(date: string): Promise<UsTickRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("us_signal_ticks").select("*").eq("date", date).order("ts", { ascending: true }).limit(1000);
  return (data ?? []) as UsTickRow[];
}

// 한국 엔진 입력으로 매핑 — SMH를 선물(futPx) 계열로. 수급(KIS)·하닉 계열은 null →
// T4·T5·T8·L5는 자동으로 '미산출'(만점 제외)이 된다.
export function toEngineTicks(rows: UsTickRow[]): IntradayTick[] {
  return rows.map((r) => ({
    ts: r.ts,
    minuteOfDay: r.minute_of_day,
    futPx: r.smh_px,
    futChg: r.smh_chg,
    k200Px: null,
    hynixPx: null, hynixChg: null, samsungPx: null, samsungChg: null,
    hynixFrgn: null, samsungFrgn: null, hynixInst: null, samsungInst: null, hynixVol: null,
    kospiFrgn: null, kospiPrgm: null, futFrgn: null, futFrgnQty: null,
    nikkeiChg: null, twiiChg: null,
    nqChg: r.nq_chg,
    breadth: null, basis: null,
  }));
}

// SMH 일봉 (갭·폭락·과열 판정용)
export async function fetchSmhDaily(count = 15): Promise<DailyBar[]> {
  try {
    const r = await yf.chart(US_SIGNAL_CONFIG.symbols.judge, {
      period1: new Date(Date.now() - (count + 10) * 86400e3), interval: "1d",
    });
    return (r.quotes ?? [])
      .filter((x): x is typeof x & { close: number; open: number; high: number; low: number } =>
        x.close != null && x.open != null && x.high != null && x.low != null)
      .map((x) => ({
        date: (x.date instanceof Date ? x.date : new Date(x.date)).toISOString().slice(0, 10),
        open: x.open, high: x.high, low: x.low, close: x.close,
        volume: typeof x.volume === "number" ? x.volume : 0,
      }));
  } catch {
    return [];
  }
}
