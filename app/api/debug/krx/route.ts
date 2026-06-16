import { NextResponse } from "next/server";
import { krxRaw, fetchInvestorFlow } from "@/lib/market/krx";

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
