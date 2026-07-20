// KIS 일별 분봉(FHKST03010230) 어댑터 — 과거 일자의 1분봉 조회.
// 실측(2026-07-16): 최소 120일 전까지 정상 응답. 1회 호출당 요청 시각에서 과거로 최대 61봉.
// 봉 시각(stck_cntg_hour)은 봉 시작 기준 — "0900xx" 봉은 09:01에 완성.
// 당일 장중에는 당일분봉조회(FHKST03010200)로 폴백.

import type { MinuteBar } from "./types";

const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
let cachedToken: { token: string; exp: number } | null = null;

async function getToken(): Promise<string | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) return null;
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  try {
    const r = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey, appsecret }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    cachedToken = { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 86400) * 1000 };
    return j.access_token;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type KisMinuteRow = {
  stck_bsop_date?: string;
  stck_cntg_hour?: string;
  stck_oprc?: string;
  stck_hgpr?: string;
  stck_lwpr?: string;
  stck_prpr?: string;
  cntg_vol?: string;
};

function rowToBar(row: KisMinuteRow): MinuteBar | null {
  const h = String(row.stck_cntg_hour ?? "");
  if (!/^\d{6}$/.test(h)) return null;
  const n = (v: unknown) => {
    const x = parseFloat(String(v ?? "").replace(/,/g, ""));
    return isFinite(x) ? x : NaN;
  };
  const open = n(row.stck_oprc), high = n(row.stck_hgpr), low = n(row.stck_lwpr), close = n(row.stck_prpr);
  if (![open, high, low, close].every((v) => isFinite(v) && v > 0)) return null;
  const vol = n(row.cntg_vol);
  return { time: `${h.slice(0, 2)}:${h.slice(2, 4)}`, open, high, low, close, volume: isFinite(vol) ? vol : 0 };
}

// 요청 시각 앵커: 60분 간격이면 61봉 응답과 정확히 이어짐. upToHour까지 커버.
function anchors(upToHour: string): string[] {
  const list: string[] = [];
  for (const h of ["100000", "110000", "120000", "130000", "140000", "150000", "153000"]) {
    if (h <= upToHour) list.push(h);
    else break;
  }
  if (list[list.length - 1] !== upToHour) list.push(upToHour);
  return list;
}

// 과거(또는 당일) 특정 일자의 1분봉 — 09:00부터 upToHour(포함)까지. 실패/휴장 시 null.
export async function fetchDayMinutes(code: string, dateYmd: string, upToHour = "153000"): Promise<MinuteBar[] | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const token = await getToken();
  if (!token || !appkey || !appsecret) return null;
  const byTime = new Map<string, MinuteBar>();
  try {
    for (const hour of anchors(upToHour)) {
      const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice`);
      url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
      url.searchParams.set("FID_INPUT_ISCD", code);
      url.searchParams.set("FID_INPUT_DATE_1", dateYmd);
      url.searchParams.set("FID_INPUT_HOUR_1", hour);
      url.searchParams.set("FID_PW_DATA_INCU_YN", "N");
      url.searchParams.set("FID_FAKE_TICK_INCU_YN", "");
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHKST03010230", custtype: "P" },
        cache: "no-store",
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { rt_cd?: string; output2?: KisMinuteRow[] };
      if (j.rt_cd !== "0" || !Array.isArray(j.output2)) continue;
      for (const row of j.output2) {
        if (String(row.stck_bsop_date ?? "") !== dateYmd) continue;
        const bar = rowToBar(row);
        if (bar) byTime.set(bar.time, bar);
      }
      await sleep(120); // 유량 제한 여유
    }
  } catch {
    return null;
  }
  if (byTime.size === 0) return null;
  let bars = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
  // ⚠ 당일 조회 시 미래 시각 가드 (2026-07-20 실측): 아직 오지 않은 시각을 요청하면 KIS가
  // 직전 거래일 봉을 '요청한 날짜'로 라벨해 반환한다 — 현재 분 이전의 완성봉만 신뢰.
  const kstNow = new Date(Date.now() + 9 * 3600e3);
  if (dateYmd === kstNow.toISOString().slice(0, 10).replace(/-/g, "")) {
    const nowHHMM = `${String(kstNow.getUTCHours()).padStart(2, "0")}:${String(kstNow.getUTCMinutes()).padStart(2, "0")}`;
    bars = bars.filter((b) => b.time < nowHHMM);
  }
  return bars.length ? bars : null;
}

// NXT(넥스트레이드) 프리마켓 1분봉 08:00~08:49 — 한 호출로 전부 (시장구분 NX).
// 실측(2026-07-16): 과거 최소 9개월 제공. NXT 미거래일(휴장·비대상일)은 null.
export async function fetchNxtPremarket(code: string, dateYmd: string): Promise<MinuteBar[] | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const token = await getToken();
  if (!token || !appkey || !appsecret) return null;
  try {
    const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "NX");
    url.searchParams.set("FID_INPUT_ISCD", code);
    url.searchParams.set("FID_INPUT_DATE_1", dateYmd);
    url.searchParams.set("FID_INPUT_HOUR_1", "085000");
    url.searchParams.set("FID_PW_DATA_INCU_YN", "N");
    url.searchParams.set("FID_FAKE_TICK_INCU_YN", "");
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHKST03010230", custtype: "P" },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { rt_cd?: string; output2?: KisMinuteRow[] };
    if (j.rt_cd !== "0" || !Array.isArray(j.output2)) return null;
    const bars: MinuteBar[] = [];
    for (const row of j.output2) {
      if (String(row.stck_bsop_date ?? "") !== dateYmd) continue;
      const bar = rowToBar(row);
      if (bar) bars.push(bar);
    }
    bars.sort((a, b) => (a.time < b.time ? -1 : 1));
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

// NXT 애프터마켓 1분봉 15:30~20:00 (시장구분 NX) — 애프터장 판정용 (2026-07-20).
// 당일 미래 시각 가드 동일 적용. 애프터 비거래일·데이터 없으면 null.
export async function fetchNxtAfterMarket(code: string, dateYmd: string, upToHour = "200000"): Promise<MinuteBar[] | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const token = await getToken();
  if (!token || !appkey || !appsecret) return null;
  const byTime = new Map<string, MinuteBar>();
  const anchors = ["163000", "173000", "183000", "193000", "200000"].filter((h) => h <= upToHour);
  if (anchors[anchors.length - 1] !== upToHour) anchors.push(upToHour);
  try {
    for (const hour of anchors) {
      const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice`);
      url.searchParams.set("FID_COND_MRKT_DIV_CODE", "NX");
      url.searchParams.set("FID_INPUT_ISCD", code);
      url.searchParams.set("FID_INPUT_DATE_1", dateYmd);
      url.searchParams.set("FID_INPUT_HOUR_1", hour);
      url.searchParams.set("FID_PW_DATA_INCU_YN", "N");
      url.searchParams.set("FID_FAKE_TICK_INCU_YN", "");
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHKST03010230", custtype: "P" },
        cache: "no-store",
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { rt_cd?: string; output2?: KisMinuteRow[] };
      if (j.rt_cd !== "0" || !Array.isArray(j.output2)) continue;
      for (const row of j.output2) {
        if (String(row.stck_bsop_date ?? "") !== dateYmd) continue;
        const bar = rowToBar(row);
        if (bar && bar.time >= "15:30") byTime.set(bar.time, bar);
      }
      await sleep(120);
    }
  } catch {
    return null;
  }
  if (byTime.size === 0) return null;
  let bars = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
  const kstNow2 = new Date(Date.now() + 9 * 3600e3);
  if (dateYmd === kstNow2.toISOString().slice(0, 10).replace(/-/g, "")) {
    const nowHHMM = `${String(kstNow2.getUTCHours()).padStart(2, "0")}:${String(kstNow2.getUTCMinutes()).padStart(2, "0")}`;
    bars = bars.filter((b) => b.time < nowHHMM);
  }
  return bars.length ? bars : null;
}

// 당일 장중 폴백 (FHKST03010200 — 요청 시각에서 과거 30봉씩)
export async function fetchTodayMinutes(code: string, upToHour: string): Promise<MinuteBar[] | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const token = await getToken();
  if (!token || !appkey || !appsecret) return null;
  const byTime = new Map<string, MinuteBar>();
  const hours: string[] = [];
  for (let h = 9 * 60 + 30; ; h += 30) {
    const hh = String(Math.floor(h / 60)).padStart(2, "0") + String(h % 60).padStart(2, "0") + "00";
    hours.push(hh > upToHour ? upToHour : hh);
    if (hh >= upToHour) break;
  }
  try {
    for (const hour of hours) {
      const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`);
      url.searchParams.set("FID_ETC_CLS_CODE", "");
      url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
      url.searchParams.set("FID_INPUT_ISCD", code);
      url.searchParams.set("FID_INPUT_HOUR_1", hour);
      url.searchParams.set("FID_PW_DATA_INCU_YN", "N");
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHKST03010200", custtype: "P" },
        cache: "no-store",
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { rt_cd?: string; output2?: KisMinuteRow[] };
      if (j.rt_cd !== "0" || !Array.isArray(j.output2)) continue;
      for (const row of j.output2) {
        const bar = rowToBar(row);
        if (bar) byTime.set(bar.time, bar);
      }
      await sleep(120);
    }
  } catch {
    return null;
  }
  if (byTime.size === 0) return null;
  return [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
}

// 판정 창(09:00~10:29 완성봉)으로 자르기 — judgeHour "103000" → time < "10:30"
export function clipToJudgeWindow(bars: MinuteBar[], judgeHour: string): MinuteBar[] {
  const cut = `${judgeHour.slice(0, 2)}:${judgeHour.slice(2, 4)}`;
  return bars.filter((b) => b.time < cut);
}
