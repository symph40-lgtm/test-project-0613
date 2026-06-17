import { NextResponse } from "next/server";
import { fetchStockFlow, fetchKoreanOffHours } from "@/lib/market/naver-flow";

export const dynamic = "force-dynamic";

// 수급·시간외(네이버) 연동 진단 — 개발 전용
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  const [samsung, hynix, offHours] = await Promise.all([
    fetchStockFlow("삼성전자", "005930"),
    fetchStockFlow("SK하이닉스", "000660"),
    fetchKoreanOffHours("005930"),
  ]);

  // 시간외 원시 응답 (필드 확인용)
  let rawBasic: unknown = null;
  try {
    const r = await fetch("https://m.stock.naver.com/api/stock/005930/basic", {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
    });
    rawBasic = await r.json();
  } catch (e) {
    rawBasic = { error: e instanceof Error ? e.message : "err" };
  }

  return NextResponse.json({
    "수급_삼성전자": samsung,
    "수급_SK하이닉스": hynix,
    "시간외_파싱_삼성전자": offHours,
    "시간외_원시응답": rawBasic,
  });
}
