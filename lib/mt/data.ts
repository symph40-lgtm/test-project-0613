// MT 데이터 어댑터 — 조달 판정은 docs/mt-audit-t1.md (T1). 소스는 그 표에 있는 것만 쓴다.
//   일봉 OHLCV : 네이버 fchart (pykrx 정본과 795일 대사 불일치 0 — AUDIT §2)
//   해외 재료   : yahoo ^SOX (C1 정당화 반응의 분모)
//   등락종목수  : 라이브 단면만 (이력 API 없음 → 소급은 상대강도 대체)
//   외인 수급   : 네이버 frgn (1페이지 20일 → 3페이지로 60일)

import YahooFinance from "yahoo-finance2";
import type { Bar, MtSymbol } from "./types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const NAVER = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://m.stock.naver.com/" };

/** fchart 심볼: KOSPI200 → KPI200 */
const fchartSymbol = (s: MtSymbol) => (s === "KOSPI200" ? "KPI200" : s);

export async function fetchMtBars(symbol: MtSymbol, count = 800): Promise<Bar[]> {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${fchartSymbol(symbol)}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetch(url, { headers: NAVER, cache: "no-store" });
  if (!res.ok) throw new Error(`MT 일봉 조회 실패 ${symbol} ${res.status}`);
  const xml = await res.text();
  const bars: Bar[] = [];
  for (const m of xml.matchAll(/<item data="([^"]+)"/g)) {
    const [d, o, h, l, c, v] = m[1].split("|");
    if (!/^\d{8}$/.test(d)) continue;
    const bar = {
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      open: +o, high: +h, low: +l, close: +c, volume: isFinite(+v) ? +v : 0,
    };
    if ([bar.open, bar.high, bar.low, bar.close].every((x) => isFinite(x) && x > 0)) bars.push(bar);
  }
  return bars; // 오래된 → 최신
}

/**
 * KRX 일자 → 전일밤 ^SOX 수익률 % 매핑.
 * "전일밤"의 정의: 해당 KRX 일자보다 **엄격히 이전**인 마지막 미국 거래일의 일간 수익률.
 * (미 장은 KST 기준 밤에 열리므로, KRX date d 개장 직전에 확정된 SOX 세션이 곧 d의 재료다.)
 */
export async function fetchSoxByDate(krxDates: string[], since = "2023-01-01"): Promise<Map<string, number>> {
  const r = await yf.chart("^SOX", { period1: new Date(since), interval: "1d" });
  const q = (r.quotes ?? []).filter((x) => x.close != null);
  const us: { date: string; close: number }[] = q.map((x) => ({
    date: (x.date instanceof Date ? x.date : new Date(x.date as unknown as number)).toISOString().slice(0, 10),
    close: x.close as number,
  }));
  const rets: { date: string; ret: number }[] = [];
  for (let i = 1; i < us.length; i++) {
    if (us[i - 1].close > 0) rets.push({ date: us[i].date, ret: ((us[i].close - us[i - 1].close) / us[i - 1].close) * 100 });
  }
  const out = new Map<string, number>();
  let p = 0;
  for (const d of [...krxDates].sort()) {
    while (p < rets.length && rets[p].date < d) p++;
    const last = p - 1;                       // d보다 엄격히 이전인 마지막 미 세션
    if (last >= 0) out.set(d, Math.round(rets[last].ret * 100) / 100);
  }
  return out;
}

/** 라이브 등락종목수 (C4·S2③) — 이력 API 없음, 그날 단면만 */
export async function fetchBreadthNow(): Promise<number | null> {
  try {
    const res = await fetch("https://finance.naver.com/sise/sise_index.naver?code=KOSPI", {
      headers: { "User-Agent": NAVER["User-Agent"] }, cache: "no-store",
    });
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    const grab = (label: string): number | null => {
      const m = html.match(new RegExp(`${label}[\\s\\S]{0,120}?<span>([\\d,]+)`));
      const n = m ? parseInt(m[1].replace(/,/g, ""), 10) : NaN;
      return isNaN(n) ? null : n;
    };
    const up = grab("상승종목수"), down = grab("하락종목수");
    return up != null && down != null && up + down > 0 ? up / (up + down) : null;
  } catch { return null; }
}

/** C5 수급 — 외인 연속 일수·감속률 (네이버 frgn, page당 20일) */
export async function fetchFlowParts(code: string, pages = 3): Promise<{ streak: number | null; decel: number | null } | null> {
  try {
    const rows: { date: string; frgn: number }[] = [];
    for (let p = 1; p <= pages; p++) {
      const res = await fetch(`https://finance.naver.com/item/frgn.naver?code=${code}&page=${p}`, {
        headers: { "User-Agent": NAVER["User-Agent"], Referer: "https://finance.naver.com/" }, cache: "no-store",
      });
      if (!res.ok) break;
      const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
      for (const m of html.matchAll(/<tr onMouseOver[\s\S]*?<\/tr>/g)) {
        const row = m[0];
        const d = row.match(/(\d{4})\.(\d{2})\.(\d{2})/);
        const frgnM = row.match(/width="80"[^>]*>[\s\S]*?([+\-][\d,]+)/);
        if (!d || !frgnM) continue;
        rows.push({ date: `${d[1]}-${d[2]}-${d[3]}`, frgn: parseFloat(frgnM[1].replace(/,/g, "")) });
      }
    }
    if (!rows.length) return null;
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = rows[rows.length - 1];
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (Math.sign(rows[i].frgn) !== Math.sign(last.frgn) || rows[i].frgn === 0) break;
      streak++;
    }
    const prevs = rows.slice(-21, -1).map((r) => Math.abs(r.frgn));
    const avg = prevs.length ? prevs.reduce((a, b) => a + b, 0) / prevs.length : 0;
    return {
      streak: Math.sign(last.frgn) * streak,
      decel: avg > 0 ? Math.round((last.frgn / avg) * 100) / 100 : null,
    };
  } catch { return null; }
}

/** C1 등급 B 재료 — predict_case_days.cause_text (2026-07-29~, 백필 불가) */
export async function fetchCauseTextByDate(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data } = await createAdminClient().from("predict_case_days")
      .select("date,cause_text").not("cause_text", "is", null).order("date", { ascending: true });
    for (const r of (data ?? []) as { date: string; cause_text: string }[]) out.set(r.date, r.cause_text);
  } catch { /* 미적용 환경 — 등급 C로 자동 강등 */ }
  return out;
}
