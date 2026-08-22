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

// 토큰은 공유 캐시(lib/market/kisToken.ts)로 일원화 (2026-07-28) — 인스턴스별 중복 발급 경합 제거
import { checkKisAuth, getKisToken as getToken } from "./kisToken";

const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";

export function hasKisKeys(): boolean {
  return Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);
}

// 야간 코스피200 선물 최근월물 코드 자동 산출 — 월물 교체를 사람이 챙길 필요 없게.
// KIS 마스터(fo_cme_code.mst) 실측 규칙: "1A01" + 연도 끝자리 + 월물(03/06/09/12)
//   예: 2026년 9월물 = 1A01609, 2026년 12월물 = 1A01612, 2027년 3월물 = 1A01703
// 만기 = 분기월 둘째 목요일 — 만기일 당일 저녁(야간)부터는 다음 월물이 최근월.
export function frontMonthNightFutCode(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth() + 1;
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
  // 코드 형식 교정 (2026-08-11 실측): 종전 "1A01…"는 자리 하나 과잉으로 KIS가 항상 빈 응답 —
  // "A01" + 연도끝자리 + 월(2자리)이 정상 (A01609 = 2026년 9월물, 가격 989.8 응답 확인).
  // 이것이 night_fut 상시 결측의 근본 원인이었다 (04:50 창·시장구분은 무관).
  return `A01${qy % 10}${String(qm).padStart(2, "0")}`;
}

// changePercent null = 등락률 필드 파싱 실패 (실측 2026-07-15 아침 브리핑: 야간 마감 후 응답에
// 등락률이 없어 0으로 강제하니 "1105.0 0.0%"처럼 오해 유발 — 사용자 지적. 모르면 ?로 표기)
export type KisFutures = { price: number; changePercent: number | null; volume?: number | null } | null;

// 야간 코스피200 선물 현재가·전일대비율. 키 미설정/실패 시 null(호출부에서 네이버 폴백).
// div: 시장구분 코드 — "CM" = 야간 세션 확정 (2026-08-15 실측).
//   "F"(주간)는 같은 종목코드에 값을 반환하지만 그 등락률은 '주간 세션 전일 대비'라 야간 정보가 아니다
//   (8/13밤 04:50 +3.71 = 주간 8/13 등락률과 일치 — 상시 오염의 근본 원인).
//   "CM"의 futs_sdpr(기준가) = 당일 주간 종가, futs_prdy_ctrt = 야간 현재가/주간 종가 - 1 (내재갭 정의).
//   야간 세션(18:00~익일 06:00) 밖에서는 직전 야간 세션 마감 스냅샷이 반환된다.
export async function fetchKisNightFutures(div = "CM"): Promise<KisFutures> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  // 수동 지정(KIS_FUT_CODE)이 있으면 우선, 없으면 최근월물 자동 산출 (분기 만기 자동 교체)
  const code = process.env.KIS_FUT_CODE || frontMonthNightFutCode();
  if (!appkey || !appsecret) return null;
  const token = await getToken();
  if (!token) return null;
  try {
    const url = new URL(`${KIS_BASE}/uapi/domestic-futureoption/v1/quotations/inquire-price`);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", div); // 선물 — 주간 "F", 야간 후보는 호출부에서 시도
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
    if (!r.ok) { checkKisAuth(r.status); return null; }
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
    const vol = num(o.acml_vol); // 세션 누적 거래량 (T2+ v2 confidence_vol 재료 — 8/20 축적 시작)
    return { price, changePercent: chg, volume: isFinite(vol) ? vol : null };
  } catch {
    return null;
  }
}

// ── 주간 코스피200 선물 10분봉 (FHKIF03020200 선물옵션 분봉) — 2026-08-22 실측: FID_HOUR_CLS_CODE "600" = 10분봉,
// 1회 102행(약 2.5 세션) — 요청 일자의 주간 세션(09:00~15:45) 봉만 걸러 오름차순 반환. 발주자 지시: 야간 10분봉 곡선에 주간 경로 병기.
export type KisFutBar = { t: string; px: number; high: number; low: number; vol: number | null };
export async function fetchKisFutDayBars10m(dateYmd: string): Promise<KisFutBar[]> {
  const appkey = process.env.KIS_APP_KEY, appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) return [];
  const token = await getToken();
  if (!token) return [];
  try {
    const url = new URL(`${KIS_BASE}/uapi/domestic-futureoption/v1/quotations/inquire-time-fuopchartprice`);
    const p: Record<string, string> = { FID_COND_MRKT_DIV_CODE: "F", FID_INPUT_ISCD: process.env.KIS_FUT_CODE || frontMonthNightFutCode(), FID_HOUR_CLS_CODE: "600", FID_PW_DATA_INCU_YN: "Y", FID_FAKE_TICK_INCU_YN: "N", FID_INPUT_DATE_1: dateYmd, FID_INPUT_HOUR_1: "154500" };
    for (const [k, v] of Object.entries(p)) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHKIF03020200", custtype: "P" }, next: { revalidate: 300 } });
    if (!r.ok) { checkKisAuth(r.status); return []; }
    const j = (await r.json()) as { output2?: Record<string, string>[] };
    const num = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : NaN; };
    return (j.output2 ?? [])
      .filter((o) => o.stck_bsop_date === dateYmd && isFinite(num(o.futs_prpr)))
      .map((o) => ({ t: `${o.stck_cntg_hour.slice(0, 2)}:${o.stck_cntg_hour.slice(2, 4)}`, px: num(o.futs_prpr), high: num(o.futs_hgpr), low: num(o.futs_lwpr), vol: isFinite(num(o.cntg_vol)) ? num(o.cntg_vol) : null }))
      .sort((a, b) => a.t.localeCompare(b.t));
  } catch { return []; }
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
    if (!r.ok) { checkKisAuth(r.status); return null; }
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

// ── 외국인·기관 매매종목가집계 (FHPTJ04400000, HTS [0440]) — 종목별 '당일 추정' 순매매량(주).
// 네이버 종목 잠정치가 장중 미제공으로 판명(2026-07-15, L5가 가동 이래 항상 null이던 원인)되어
// 이 API로 대체. 금액 기준 순매수 상위 30 + 순매도 상위 30을 합쳐 요청 종목을 찾는다 —
// 하닉·삼전은 거래대금 최상위라 사실상 항상 포함 (양쪽에 없으면 그 종목은 null = 순매매 미미).
// 부호 실측: 매도 목록은 음수로 반환 — 그대로 사용.
export type KisStockEstimate = { frgnQty: number; orgnQty: number };

export async function fetchKisStockEstimates(codes: string[]): Promise<Map<string, KisStockEstimate> | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) return null;
  const token = await getToken();
  if (!token) return null;
  const want = new Set(codes);
  const map = new Map<string, KisStockEstimate>();
  try {
    for (const sortCode of ["0", "1"]) { // 0=순매수 상위, 1=순매도 상위 (금액 기준)
      const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/foreign-institution-total`);
      url.searchParams.set("FID_COND_MRKT_DIV_CODE", "V");
      url.searchParams.set("FID_COND_SCR_DIV_CODE", "16449");
      url.searchParams.set("FID_INPUT_ISCD", "0000");
      url.searchParams.set("FID_DIV_CLS_CODE", "1"); // 금액 기준 — 고가주(하닉) 수량 불리 보정
      url.searchParams.set("FID_RANK_SORT_CLS_CODE", sortCode);
      url.searchParams.set("FID_ETC_CLS_CODE", "0");
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHPTJ04400000", custtype: "P" },
        cache: "no-store",
      });
      if (!r.ok) { checkKisAuth(r.status); continue; }
      const j = (await r.json()) as { rt_cd?: string; output?: Record<string, unknown>[] };
      if (j.rt_cd !== "0" || !Array.isArray(j.output)) continue;
      for (const row of j.output) {
        const code = String(row.mksc_shrn_iscd ?? "");
        if (!want.has(code) || map.has(code)) continue;
        const num = (v: unknown): number => {
          const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
          return isFinite(n) ? n : NaN;
        };
        const frgn = num(row.frgn_ntby_qty);
        const orgn = num(row.orgn_ntby_qty);
        if (isFinite(frgn)) map.set(code, { frgnQty: frgn, orgnQty: isFinite(orgn) ? orgn : 0 });
      }
      if ([...want].every((c) => map.has(c))) break; // 순매수 목록에서 다 찾으면 매도 목록 생략
    }
    return map;
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
    if (!r.ok) { checkKisAuth(r.status); return null; }
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
