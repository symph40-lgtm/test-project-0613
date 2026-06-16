import { NextResponse } from "next/server";
import { fetchStockFlow } from "@/lib/market/naver-flow";

export const dynamic = "force-dynamic";

// 수급(네이버 금융) 연동 진단 — 개발 전용
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  const [samsung, hynix] = await Promise.all([
    fetchStockFlow("삼성전자", "005930"),
    fetchStockFlow("SK하이닉스", "000660"),
  ]);

  return NextResponse.json({
    "삼성전자(005930)": samsung,
    "SK하이닉스(000660)": hynix,
  });
}
