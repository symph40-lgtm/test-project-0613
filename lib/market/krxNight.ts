// KRX 정보데이터시스템 — 야간선물 정본(T+1 라벨) 조회 (발주자 판정 2026-08-15 §2ⓒ 일일 대사용)
//
// 배경: "항상 값을 반환하는 폴백은 조용한 오답의 온상" (판정 §5) — KIS 라이브(div=CM)를
// KRX 공식 통계(MDCSTAT12902 야간 세션)와 매일 대조해, 소스 오염을 하루 안에 잡는다.
//
// 실측 규약 (2026-08-15, g1br/src/fetch_night_krx.py·T7_U1_REPORT §1):
//   - 통계 조회는 KRX 데이터 계정 로그인 필수 (무로그인 = "LOGOUT" 응답 실측).
//     로그인 흐름 = pykrx auth 이식: MDCCOMS001.cmd → login.jsp → MDCCOMS001D1.cmd (CD011 시 skipDup=Y)
//   - 야간 세션 라벨 = 다음 거래일(T+1) = g1b_days.date 와 동일
//   - u1(라벨 L) = 야간 종가(L, 최근월) / 직전 거래일 주간 종가(같은 월물) − 1
//   - 월물 ISU = "KR4A01" + 연끝자리 + 월코드(3/6/9/C) + "000" + ISIN 체크디지트 (2026~ 신코드)
//   - 연도 경계 교차 범위 요청 금지 (비JSON/행업 실측) — 조회 창은 연내로 제한
//
// 필요 env: KRX_ID / KRX_PW (미설정 시 null 반환 — 호출부가 "대사 불가"로 기록)

const BASE = "https://data.krx.co.kr";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function isinCheckDigit(base11: string): number {
  let s = "";
  for (const ch of base11) s += parseInt(ch, 36).toString();
  let total = 0;
  const digits = s.split("").map(Number);
  for (let i = digits.length - 1, k = 0; i >= 0; i--, k++) {
    let d = digits[i];
    if (k % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    total += d;
  }
  return (10 - (total % 10)) % 10;
}

// 최근월물 ISU (라벨일 기준): 만기(분기월 둘째 목요일) ≥ 라벨일 인 월물 중 최소 만기
export function krxFrontIsu(labelDate: string): { isu: string; contract: string } {
  const d = new Date(labelDate + "T00:00:00Z");
  let y = d.getUTCFullYear();
  let m = [3, 6, 9, 12].find((q) => q >= d.getUTCMonth() + 1) ?? (y++, 3);
  const secondThu = (yy: number, mm: number) => {
    const dow = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay();
    return 1 + ((4 - dow + 7) % 7) + 7;
  };
  if (m === d.getUTCMonth() + 1 && d.getUTCDate() > secondThu(y, m)) {
    if (m === 12) { y++; m = 3; } else m += 3;
  }
  const mCode = m === 12 ? "C" : String(m);
  const base = `KR4A01${y % 10}${mCode}000`;
  return { isu: base + String(isinCheckDigit(base)), contract: `${y}${String(m).padStart(2, "0")}` };
}

async function krxLogin(): Promise<string | null> {
  const id = process.env.KRX_ID, pw = process.env.KRX_PW;
  if (!id || !pw) return null;
  const jar: string[] = [];
  // Set-Cookie 복수 헤더는 getSetCookie로 — entries()는 쉼표 결합돼 expires의 쉼표와 충돌 (Node 20 undici)
  const grab = (r: Response) => {
    const sc = (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")!] : []);
    for (const v of sc) jar.push(v.split(";")[0]);
  };
  const h = () => ({ "User-Agent": UA, Cookie: jar.join("; ") });
  try {
    const r1 = await fetch(`${BASE}/contents/MDC/COMS/client/MDCCOMS001.cmd`, { headers: h(), cache: "no-store" });
    grab(r1);
    const r2 = await fetch(`${BASE}/contents/MDC/COMS/client/view/login.jsp?site=mdc`, { headers: { ...h(), Referer: `${BASE}/contents/MDC/COMS/client/MDCCOMS001.cmd` }, cache: "no-store" });
    grab(r2);
    const body = (extra: Record<string, string> = {}) =>
      new URLSearchParams({ mbrNm: "", telNo: "", di: "", certType: "", mbrId: id, pw, ...extra });
    const post = async (extra?: Record<string, string>) => {
      const r = await fetch(`${BASE}/contents/MDC/COMS/client/MDCCOMS001D1.cmd`, {
        method: "POST", headers: { ...h(), Referer: `${BASE}/contents/MDC/COMS/client/MDCCOMS001.cmd`, "content-type": "application/x-www-form-urlencoded" },
        body: body(extra), cache: "no-store",
      });
      grab(r);
      return (await r.json()) as { _error_code?: string };
    };
    let res = await post();
    if (res._error_code === "CD011") res = await post({ skipDup: "Y" }); // 중복 로그인 — 기존 세션 대체
    return res._error_code === "CD001" ? jar.join("; ") : null;
  } catch { return null; }
}

type KrxRow = { TRD_DD: string; TDD_CLSPRC: string; TDD_OPNPRC: string; TDD_HGPRC?: string; TDD_LWPRC?: string };

async function fetchSeries(cookie: string, isu: string, agg: "0" | "2", strt: string, end: string): Promise<KrxRow[]> {
  const r = await fetch(`${BASE}/comm/bldAttendant/getJsonData.cmd`, {
    method: "POST",
    headers: { "User-Agent": UA, Cookie: cookie, Referer: `${BASE}/contents/MDC/MDI/mdiLoader/index.cmd`, "X-Requested-With": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ bld: "dbms/MDC/STAT/standard/MDCSTAT12902", locale: "ko_KR", prodId: "KRDRVFUK2I", strtDd: strt, endDd: end, isuCd: isu, isuCd2: isu, aggBasTpCd: agg }),
    cache: "no-store",
    signal: AbortSignal.timeout(25_000), // 행업 방지 (8/15 실측 — 무timeout 15분+ 행업)
  });
  const t = await r.text();
  try { return ((JSON.parse(t) as { output?: KrxRow[] }).output ?? []); } catch { return []; }
}

export type KrxNightU1 = { u1_pct: number; night_close: number; day_close_ref: number; contract: string } | null;

// 라벨일 L의 정본 u1 — 야간 종가(L) / 직전 거래일 주간 종가 − 1 (%)
export async function fetchKrxNightU1(labelDate: string): Promise<KrxNightU1> {
  const cookie = await krxLogin();
  if (!cookie) return null;
  const { isu, contract } = krxFrontIsu(labelDate);
  const end = labelDate.replace(/-/g, "");
  // 조회 창: 라벨일−14일 ~ 라벨일. 연도 경계 교차 금지 — 연초엔 1/1로 절단 (직전 주간일이 전년이면 대사 불가 처리)
  const s0 = new Date(labelDate + "T00:00:00Z");
  s0.setUTCDate(s0.getUTCDate() - 14);
  const strt = (s0.getUTCFullYear() < Number(labelDate.slice(0, 4)) ? `${labelDate.slice(0, 4)}0101` : s0.toISOString().slice(0, 10).replace(/-/g, ""));
  const num = (v: string) => parseFloat(String(v).replace(/,/g, ""));
  const norm = (d: string) => d.replace(/\//g, "-");
  const night = await fetchSeries(cookie, isu, "2", strt, end);
  const nRow = night.find((r) => norm(r.TRD_DD) === labelDate);
  if (!nRow) return null;
  const day = await fetchSeries(cookie, isu, "0", strt, end);
  const prev = day.map((r) => ({ d: norm(r.TRD_DD), c: num(r.TDD_CLSPRC) }))
    .filter((r) => r.d < labelDate && isFinite(r.c) && r.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d)).pop();
  const nc = num(nRow.TDD_CLSPRC);
  if (!prev || !isFinite(nc) || nc <= 0) return null;
  return { u1_pct: Math.round((nc / prev.c - 1) * 10000) / 100, night_close: nc, day_close_ref: prev.c, contract };
}

// ── 일봉 시계열 (발주 A §2 — /g1 야간선물 섹션 과거 조회, KRX 정본) ──
// 최근월 스티칭 없이 현재 최근월 1계약으로 최근 ~1개월 (계약 경계 밤은 만기 주간에만 발생 — 표식).
export type KrxFutSession = { date: string; open: number; high: number; low: number; close: number };
// [발주자 8/21] day = 야간 개장 직전의 주간(낮) 세션 봉 — 일봉 그래프에서 주간→야간 연속 표시용
export type KrxNightDay = { label_date: string; open: number; high: number; low: number; close: number; day_close_ref: number | null; u1_pct: number | null; day: KrxFutSession | null };
let dailyCache: { at: number; data: KrxNightDay[] } | null = null;
export async function fetchKrxNightDaily(days = 24): Promise<KrxNightDay[]> {
  if (dailyCache && Date.now() - dailyCache.at < 15 * 60_000) return dailyCache.data;   // 15분 캐시 (페이지 로드마다 로그인 방지)
  const cookie = await krxLogin();
  if (!cookie) return dailyCache?.data ?? [];
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const { isu } = krxFrontIsu(today);
  const s0 = new Date(today + "T00:00:00Z"); s0.setUTCDate(s0.getUTCDate() - Math.ceil(days * 1.6));
  const strt = (s0.getUTCFullYear() < Number(today.slice(0, 4)) ? `${today.slice(0, 4)}0101` : s0.toISOString().slice(0, 10).replace(/-/g, ""));
  const num = (v: string) => parseFloat(String(v).replace(/,/g, ""));
  const norm = (d: string) => d.replace(/\//g, "-");
  // [발주자 지적 8/22] 야간 세션은 T+1 거래일 라벨(금요일 밤 = 월요일) — endDd를 오늘로 두면 직전 밤이 잘린다 → +7일 (KRX는 존재 행만 반환)
  const endPlus = (() => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10).replace(/-/g, ""); })();
  const night = await fetchSeries(cookie, isu, "2", strt, endPlus);
  const day = await fetchSeries(cookie, isu, "0", strt, endPlus);
  const dayC = day.map((r) => ({ d: norm(r.TRD_DD), o: num(r.TDD_OPNPRC), h: num((r as unknown as { TDD_HGPRC: string }).TDD_HGPRC), l: num((r as unknown as { TDD_LWPRC: string }).TDD_LWPRC), c: num(r.TDD_CLSPRC) }))
    .filter((r) => isFinite(r.c) && r.c > 0).sort((a, b) => a.d.localeCompare(b.d));
  const out: KrxNightDay[] = [];
  for (const r of night.map((x) => ({ ...x, d: norm(x.TRD_DD) })).sort((a, b) => a.d.localeCompare(b.d))) {
    const o = num(r.TDD_OPNPRC), h = num((r as unknown as { TDD_HGPRC: string }).TDD_HGPRC), l = num((r as unknown as { TDD_LWPRC: string }).TDD_LWPRC), c = num(r.TDD_CLSPRC);
    if (!isFinite(c) || c <= 0) continue;
    const prevDay = dayC.filter((x) => x.d < r.d).pop() ?? null;
    const ref = prevDay?.c ?? null;
    out.push({ label_date: r.d, open: o, high: h, low: l, close: c, day_close_ref: ref, u1_pct: ref ? Math.round((c / ref - 1) * 10000) / 100 : null,
      day: prevDay ? { date: prevDay.d, open: prevDay.o, high: prevDay.h, low: prevDay.l, close: prevDay.c } : null });
  }
  const sliced = out.slice(-days);
  dailyCache = { at: Date.now(), data: sliced };
  return sliced;
}
