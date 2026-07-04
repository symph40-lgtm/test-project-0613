// 한국투자증권(KIS) Developers REST API — 코스피200 '야간선물' 실시간 시세 조회.
// 네이버가 제공하지 않는 야간 세션(18:00~05:00, CME 연계) 시세를 KIS로 가져온다.
//
// 필요한 환경변수(.env.local + Vercel):
//   KIS_APP_KEY     — KIS Developers에서 발급한 앱 KEY
//   KIS_APP_SECRET  — 앱 SECRET
//   KIS_FUT_CODE    — 야간 코스피200 선물 종목코드 (예: "101W09" / "1010..."; HTS·KIS 포털에서 확인)
//   KIS_FUT_TRID    — (선택) 시세 조회 tr_id. 기본 "FHMIF10000000"
//   KIS_BASE        — (선택) 기본 실전 도메인. 모의투자는 ":29443"
//
// 토큰은 24h 유효하며 발급 호출에 분당 제한이 있어 메모리 캐시한다.

const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";

let cachedToken: { token: string; exp: number } | null = null;

export function hasKisKeys(): boolean {
  return Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET && process.env.KIS_FUT_CODE);
}

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
      // 토큰은 자주 바뀌지 않음 — 우리 캐시로 관리, fetch 캐시는 끔
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

export type KisFutures = { price: number; changePercent: number } | null;

// 야간 코스피200 선물 현재가·전일대비율. 키 미설정/실패 시 null(호출부에서 네이버 폴백).
export async function fetchKisNightFutures(): Promise<KisFutures> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const code = process.env.KIS_FUT_CODE;
  if (!appkey || !appsecret || !code) return null;
  const token = await getToken();
  if (!token) return null;
  try {
    const url = new URL(`${KIS_BASE}/uapi/domestic-futureoption/v1/quotations/inquire-price`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "F"); // 선물
    url.searchParams.set("FID_INPUT_ISCD", code);
    const r = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey,
        appsecret,
        tr_id: process.env.KIS_FUT_TRID || "FHMIF10000000",
        custtype: "P",
      },
      next: { revalidate: 30 },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { output?: Record<string, unknown> };
    const o = j.output ?? {};
    const num = (v: unknown): number => {
      const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
      return isFinite(n) ? n : NaN;
    };
    // 선물 현재가/전일대비율 — 응답 필드명이 환경에 따라 다를 수 있어 여러 후보를 시도
    const price = num(o.futs_prpr ?? o.stck_prpr ?? o.prpr ?? o.last);
    let chg = num(o.prdy_ctrt ?? o.prdy_vrss_ctrt);
    if (!isFinite(chg)) chg = 0;
    // 부호 필드(prdy_vrss_sign: 1·2=상승, 4·5=하락)가 있으면 반영
    const sign = String(o.prdy_vrss_sign ?? "");
    if (chg > 0 && (sign === "4" || sign === "5")) chg = -chg;
    if (!isFinite(price) || price <= 0) return null;
    return { price, changePercent: chg };
  } catch {
    return null;
  }
}
