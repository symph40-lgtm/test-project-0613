// NXT 애프터마켓(15:30~20:00) 현재가 — 일봉 스윙의 애프터장 재판정용 (KIS NX 분봉).
// lib/predict/kisMinute.ts의 검증된 패턴을 분리 원칙에 따라 축소 복제 (직접 import 금지).
// ⚠ tokenP는 분당 1회 제한 — 실패 시 null 반환하고 다음 5분 크론에서 재시도 (경합 허용 설계).

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

// 오늘 애프터마켓의 마지막 체결가 (완성봉 기준). 미거래·실패 시 null.
export async function fetchAfterPrice(code: string, dateYmd: string, nowHHMMSS: string): Promise<{ px: number; time: string } | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const token = await getToken();
  if (!token || !appkey || !appsecret) return null;
  try {
    const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "NX");
    url.searchParams.set("FID_INPUT_ISCD", code);
    url.searchParams.set("FID_INPUT_DATE_1", dateYmd);
    url.searchParams.set("FID_INPUT_HOUR_1", nowHHMMSS);
    url.searchParams.set("FID_PW_DATA_INCU_YN", "N");
    url.searchParams.set("FID_FAKE_TICK_INCU_YN", "");
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHKST03010230", custtype: "P" },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { rt_cd?: string; output2?: { stck_bsop_date?: string; stck_cntg_hour?: string; stck_prpr?: string }[] };
    if (j.rt_cd !== "0" || !Array.isArray(j.output2)) return null;
    // 미래 시각 가드(2026-07-20 실측): 당일 요청 시 KIS가 직전 거래일 봉을 당일로 라벨할 수 있음
    //  → 날짜 일치 + 15:30 이후 + 현재 분 이전 완성봉만 신뢰.
    const nowHHMM = `${nowHHMMSS.slice(0, 2)}:${nowHHMMSS.slice(2, 4)}`;
    let best: { px: number; time: string } | null = null;
    for (const row of j.output2) {
      if (String(row.stck_bsop_date ?? "") !== dateYmd) continue;
      const h = String(row.stck_cntg_hour ?? "");
      if (!/^\d{6}$/.test(h)) continue;
      const time = `${h.slice(0, 2)}:${h.slice(2, 4)}`;
      if (time < "15:30" || time >= nowHHMM) continue;
      const px = parseFloat(String(row.stck_prpr ?? "").replace(/,/g, ""));
      if (!isFinite(px) || px <= 0) continue;
      if (!best || time > best.time) best = { px, time };
    }
    return best;
  } catch {
    return null;
  }
}
