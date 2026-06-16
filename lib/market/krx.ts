// KRX 정보데이터시스템 투자자별 거래실적(수급) 연동
// 비공식 JSON 엔드포인트(getJsonData.cmd) 사용 — 브라우저 흉내 헤더 필요
// 주의: KRX는 도메인/파라미터가 바뀔 수 있어 실패 시 null 반환(페이지는 안 깨짐)

const KRX_URL = "http://data.krx.or.kr/comm/bldAttendant/getJsonData.cmd";

export type InvestorFlow = {
  date: string;              // 기준일 YYYY-MM-DD
  market: string;            // KOSPI / KOSDAQ
  foreign: number | null;    // 외국인 순매수 (억원)
  institution: number | null;// 기관 순매수 (억원)
  individual: number | null; // 개인 순매수 (억원)
};

// 최근 영업일 후보 (오늘부터 과거로 며칠) — 휴장일이면 빈 응답
function recentTradeDates(n = 5): string[] {
  const out: string[] = [];
  const d = new Date(Date.now() + 9 * 3600 * 1000); // KST
  for (let i = 0; i < n + 3 && out.length < n; i++) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

function toNum(v: unknown): number | null {
  if (typeof v !== "string") return typeof v === "number" ? v : null;
  const n = parseFloat(v.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

// KRX getJsonData 원시 호출
export async function krxRaw(
  bld: string,
  params: Record<string, string>,
): Promise<unknown> {
  const body = new URLSearchParams({ bld, locale: "ko_KR", csvxls_isNo: "false", ...params });
  const res = await fetch(KRX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: "http://data.krx.or.kr/contents/MDC/MDI/mdiLoader/index.cmd",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    body,
    next: { revalidate: 1800 }, // 30분 캐시
  });
  if (!res.ok) throw new Error(`KRX HTTP ${res.status}`);
  return res.json();
}

// 응답 JSON에서 행 배열 추출 (KRX는 output/block1/OutBlock_1 등 키가 다양)
function extractRows(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  for (const key of ["output", "block1", "OutBlock_1", "out", "data"]) {
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  }
  // 첫 번째 배열 값 사용
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

// 시장 전체 투자자별 순매수(거래대금) 조회
// mktId: STK=코스피, KSQ=코스닥
export async function fetchInvestorFlow(
  mktId: "STK" | "KSQ" = "STK",
): Promise<InvestorFlow | null> {
  const marketName = mktId === "STK" ? "KOSPI" : "KOSDAQ";

  for (const trdDd of recentTradeDates(5)) {
    try {
      // 투자자별 거래실적 (순매수, 거래대금)
      const json = await krxRaw("dbms/MDC/STAT/standard/MDCSTAT02201", {
        mktId,
        trdDd,
        inqTpCd: "2", // 거래대금
        trdVolVal: "2",
        askBid: "3", // 순매수
        money: "1",
      });
      const rows = extractRows(json);
      if (rows.length === 0) continue;

      // 투자자 구분명 필드와 순매수 값 필드를 유연하게 탐색
      const find = (kw: string) =>
        rows.find((r) => {
          const name = String(r.INVST_TP_NM ?? r.invstTpNm ?? r.INVST_TP ?? "");
          return name.includes(kw);
        });
      const netOf = (r: Record<string, unknown> | undefined) => {
        if (!r) return null;
        const val =
          r.NETBID_TRDVAL ?? r.netBidTrdval ?? r.TRDVAL ?? r.NETBID_TRDVOL ?? null;
        const n = toNum(val);
        // KRX 값은 원 단위 → 억원 환산
        return n === null ? null : Math.round(n / 1e8);
      };

      const foreign = netOf(find("외국인"));
      const institution = netOf(find("기관"));
      const individual = netOf(find("개인"));

      if (foreign === null && institution === null && individual === null) continue;

      const dateFmt = `${trdDd.slice(0, 4)}-${trdDd.slice(4, 6)}-${trdDd.slice(6, 8)}`;
      return { date: dateFmt, market: marketName, foreign, institution, individual };
    } catch {
      continue;
    }
  }
  return null;
}
