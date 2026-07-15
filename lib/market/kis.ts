// 한국투자증권(KIS) Developers REST API — ①코스피200 '야간선물' 실시간 시세
// ②시장별 투자자매매동향(외인 수급) ③프로그램매매 종합현황. (②③은 2026-07-09 연동 — T4·T5·T8)
//
// 필요한 환경변수(.env.local + Vercel):
//   KIS_APP_KEY     — KIS Developers에서 발급한 앱 KEY
//   KIS_APP_SECRET  — 앱 SECRET
//   KIS_FUT_CODE    — (선택) 야간 코스피200 선물 종목코드 수동 지정. 미설정 시 최근월물 자동 산출
//   KIS_FUT_TRID    — (선택) 시세 조회 tr_id. 기본 "FHMIF10000000"
//   KIS_BASE        — (선택) 기본 실전 도메인. 모의투자는 ":29443"
//
// 토큰은 24h 유효하며 발급 호출에 분당 제한이 있어 메모리 캐시한다.

const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";

let cachedToken: { token: string; exp: number } | null = null;

export function hasKisKeys(): boolean {
  return Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);
}

// 야간 코스피200 선물 최근월물 코드 자동 산출 — 월물 교체를 사람이 챙길 필요 없게.
// KIS 마스터(fo_cme_code.mst) 실측 규칙: "1A01" + 연도 끝자리 + 월물(03/06/09/12)
//   예: 2026년 9월물 = 1A01609, 2026년 12월물 = 1A01612, 2027년 3월물 = 1A01703
// 만기 = 분기월 둘째 목요일 — 만기일 당일 저녁(야간)부터는 다음 월물이 최근월.
export function frontMonthNightFutCode(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  let y = kst.getUTCFullYear();
  let m = kst.getUTCMonth() + 1;
  // qm은 항상 3/6/9/12 중 하나 — 다음 분기월은 +3 (12월이면 이듬해 3월)
  const nextQuarter = (mm: number): [number, number] => (mm >= 12 ? [qy + 1, 3] : [qy, mm + 3]);

  // 현재 이후 첫 분기월(3/6/9/12)
  let qy = y;
  let qm = [3, 6, 9, 12].find((q) => q >= m) ?? (qy++, 3);
  if (qm === m) {
    // 이번 달이 만기월이면 둘째 목요일(만기일)부터 다음 월물
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0일~6토
    const secondThu = 1 + ((4 - firstDow + 7) % 7) + 7;
    if (kst.getUTCDate() >= secondThu) [qy, qm] = nextQuarter(qm);
  }
  return `1A01${qy % 10}${String(qm).padStart(2, "0")}`;
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

// changePercent null = 등락률 필드 파싱 실패 (실측 2026-07-15 아침 브리핑: 야간 마감 후 응답에
// 등락률이 없어 0으로 강제하니 "1105.0 0.0%"처럼 오해 유발 — 사용자 지적. 모르면 ?로 표기)
export type KisFutures = { price: number; changePercent: number | null } | null;

// 야간 코스피200 선물 현재가·전일대비율. 키 미설정/실패 시 null(호출부에서 네이버 폴백).
export async function fetchKisNightFutures(): Promise<KisFutures> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  // 수동 지정(KIS_FUT_CODE)이 있으면 우선, 없으면 최근월물 자동 산출 (분기 만기 자동 교체)
  const code = process.env.KIS_FUT_CODE || frontMonthNightFutCode();
  if (!appkey || !appsecret) return null;
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
    // 실측(2026-07-05): FHMIF10000000 응답은 output이 아니라 output1(선물)/output2·3(업종지수) 구조
    const j = (await r.json()) as { output1?: Record<string, unknown>; output?: Record<string, unknown> };
    const o = j.output1 ?? j.output ?? {};
    const num = (v: unknown): number => {
      const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
      return isFinite(n) ? n : NaN;
    };
    // 선물 현재가/전일대비율 — 응답 필드명이 환경에 따라 다를 수 있어 여러 후보를 시도
    const price = num(o.futs_prpr ?? o.stck_prpr ?? o.prpr ?? o.last);
    let chg: number | null = num(o.futs_prdy_ctrt ?? o.prdy_ctrt ?? o.prdy_vrss_ctrt);
    if (!isFinite(chg)) chg = null; // 파싱 실패 시 0으로 위장하지 않는다 (2026-07-15)
    // 부호 필드(prdy_vrss_sign: 1·2=상승, 4·5=하락)가 있으면 반영
    const sign = String(o.prdy_vrss_sign ?? "");
    if (chg !== null && chg > 0 && (sign === "4" || sign === "5")) chg = -chg;
    if (!isFinite(price) || price <= 0) return null;
    return { price, changePercent: chg };
  } catch {
    return null;
  }
}

// ── 투자자매매동향 (FHPTJ04030000, HTS [0403] 상단 표) — 당일 누적 순매수 스냅샷.
// 시장 코드 실측(2026-07-09): 코스피 현물 = KSP/0001, 코스피200 선물 = K2I/F001.
// tr_pbmn(거래대금)은 백만원 단위 → 억원으로 환산해 반환. 장중 잠정치라 확정치와 오차 존재.
export type KisInvestorFlow = {
  frgnNetAmt: number;   // 외국인 순매수 (억원)
  frgnNetQty: number | null; // 외국인 순매수 수량 (주 / 계약 — 참고)
  orgnNetAmt: number;   // 기관 순매수 (억원)
  prsnNetAmt: number;   // 개인 순매수 (억원)
};

export async function fetchKisInvestorFlow(market: "kospi" | "k200fut"): Promise<KisInvestorFlow | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) return null;
  const token = await getToken();
  if (!token) return null;
  const [iscd, iscd2] = market === "kospi" ? ["KSP", "0001"] : ["K2I", "F001"];
  try {
    const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market`);
    url.searchParams.set("FID_INPUT_ISCD", iscd);
    url.searchParams.set("FID_INPUT_ISCD_2", iscd2);
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHPTJ04030000", custtype: "P" },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { rt_cd?: string; output?: Record<string, unknown>[] };
    const o = j.output?.[0];
    if (j.rt_cd !== "0" || !o) return null;
    const num = (v: unknown): number => {
      const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
      return isFinite(n) ? n : NaN;
    };
    const frgnAmt = num(o.frgn_ntby_tr_pbmn);
    if (!isFinite(frgnAmt)) return null;
    const qty = num(o.frgn_ntby_qty);
    return {
      frgnNetAmt: frgnAmt / 100,
      frgnNetQty: isFinite(qty) ? qty : null,
      orgnNetAmt: (isFinite(num(o.orgn_ntby_tr_pbmn)) ? num(o.orgn_ntby_tr_pbmn) : 0) / 100,
      prsnNetAmt: (isFinite(num(o.prsn_ntby_tr_pbmn)) ? num(o.prsn_ntby_tr_pbmn) : 0) / 100,
    };
  } catch {
    return null;
  }
}

// ── 프로그램매매 종합현황(시간) (FHPPG04600101, HTS [0460]) — 코스피 차익+비차익 순매수.
// 최신 시각 행의 whol_smtn_ntby_tr_pbmn(백만원)을 억원으로 환산. 장중 최근 30분 시계열만 제공되므로
// 60초 폴링으로 최신 값을 틱에 적재해 자체 시계열을 만든다.
export async function fetchKisProgramNet(): Promise<number | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) return null;
  const token = await getToken();
  if (!token) return null;
  try {
    const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/comp-program-trade-today`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J"); // KRX
    url.searchParams.set("FID_MRKT_CLS_CODE", "K");      // 코스피
    url.searchParams.set("FID_SCTN_CLS_CODE", "");
    url.searchParams.set("FID_INPUT_ISCD", "");
    url.searchParams.set("FID_COND_MRKT_DIV_CODE1", "");
    url.searchParams.set("FID_INPUT_HOUR_1", "");
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHPPG04600101", custtype: "P" },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { rt_cd?: string; output?: { bsop_hour?: string; whol_smtn_ntby_tr_pbmn?: string }[] };
    const rows = j.output;
    if (j.rt_cd !== "0" || !Array.isArray(rows) || rows.length === 0) return null;
    // 첫 행이 최신 시각 (실측 확인)
    const v = parseFloat(String(rows[0].whol_smtn_ntby_tr_pbmn ?? "").replace(/,/g, ""));
    return isFinite(v) ? v / 100 : null;
  } catch {
    return null;
  }
}
