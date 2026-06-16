import { NextResponse } from "next/server";
import { krxRaw, fetchInvestorFlow } from "@/lib/market/krx";
import { fetchStockFlow } from "@/lib/market/naver-flow";

export const dynamic = "force-dynamic";

// KRX 수급 연동 진단 — 개발 전용
// 브라우저에서 /api/debug/krx 접속 → 어떤 bld/파라미터가 실데이터를 주는지 확인
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  // 최근 영업일 (대략 어제)
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - 1);
  const trdDd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  // 후보 bld들 — 투자자별 거래실적 관련
  const candidates: { name: string; bld: string; params: Record<string, string> }[] = [
    { name: "MDCSTAT02201", bld: "dbms/MDC/STAT/standard/MDCSTAT02201", params: { mktId: "STK", trdDd, money: "1", askBid: "3", trdVolVal: "2" } },
    { name: "MDCSTAT02202", bld: "dbms/MDC/STAT/standard/MDCSTAT02202", params: { mktId: "STK", trdDd, money: "1" } },
    { name: "MDCSTAT02203", bld: "dbms/MDC/STAT/standard/MDCSTAT02203", params: { mktId: "STK", strtDd: trdDd, endDd: trdDd, money: "1" } },
  ];

  const results: Record<string, unknown> = { trdDd };

  // 도메인 연결 가능 여부 진단 (DNS/프로토콜)
  async function reach(url: string) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      return `HTTP ${r.status}`;
    } catch (e) {
      const cause = (e as { cause?: { code?: string } })?.cause?.code;
      return `ERR ${e instanceof Error ? e.message : ""} ${cause ?? ""}`.trim();
    }
  }
  results._reachability = {
    "https://data.krx.or.kr/": await reach("https://data.krx.or.kr/"),
    "https://finance.naver.com/": await reach("https://finance.naver.com/"),
  };

  // 네이버 금융 수급 엔드포인트 후보 탐색 (외국인/기관/개인 순매수)
  async function probe(url: string) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Referer: "https://finance.naver.com/",
        },
      });
      const ct = r.headers.get("content-type") ?? "";
      const buf = await r.arrayBuffer();
      // EUC-KR 가능성 → utf-8/euc-kr 둘 다 시도해 앞부분만
      let text = "";
      try { text = new TextDecoder("utf-8").decode(buf).slice(0, 600); } catch { /* */ }
      let euc = "";
      try { euc = new TextDecoder("euc-kr").decode(buf).slice(0, 600); } catch { /* */ }
      return { status: r.status, contentType: ct, bytes: buf.byteLength, utf8: text, euckr: euc };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "err" };
    }
  }

  results._naverProbe = {
    "frgn(HTML,삼성전자)": await probe("https://finance.naver.com/item/frgn.naver?code=005930"),
  };

  // 실제 파서 결과 (삼성전자/SK하이닉스)
  results._naverParsed = {
    "삼성전자(005930)": await fetchStockFlow("삼성전자", "005930"),
    "SK하이닉스(000660)": await fetchStockFlow("SK하이닉스", "000660"),
  };
  for (const c of candidates) {
    try {
      const json = (await krxRaw(c.bld, c.params)) as Record<string, unknown>;
      const keys = Object.keys(json);
      const firstArrayKey = keys.find((k) => Array.isArray(json[k]));
      const sample = firstArrayKey ? (json[firstArrayKey] as unknown[]).slice(0, 3) : null;
      results[c.name] = { ok: true, keys, firstArrayKey, sample };
    } catch (e) {
      results[c.name] = { ok: false, error: e instanceof Error ? e.message : "err" };
    }
  }

  // 파싱 결과도 함께
  try {
    results.parsed = await fetchInvestorFlow("STK");
  } catch (e) {
    results.parsed = { error: e instanceof Error ? e.message : "err" };
  }

  return NextResponse.json(results);
}
