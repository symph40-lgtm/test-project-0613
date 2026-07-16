// 일봉 조회 (네이버 fchart) — lib/signal/data.ts와 동일 소스이나 분리 원칙상 자체 구현.
// 스크립트(tsx)와 앱 양쪽에서 쓰므로 Next 전용 옵션(next.revalidate)을 넣지 않는다.

import type { PredictDailyBar } from "./types";

export async function fetchDailyPredict(symbol: string, count: number): Promise<PredictDailyBar[]> {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://m.stock.naver.com/" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`일봉 조회 실패 ${res.status}`);
  const xml = await res.text();
  const bars: PredictDailyBar[] = [];
  const re = /<item data="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const [d, o, h, l, c, v] = m[1].split("|");
    if (!/^\d{8}$/.test(d)) continue;
    const open = parseFloat(o), high = parseFloat(h), low = parseFloat(l), close = parseFloat(c);
    if (![open, high, low, close].every(isFinite)) continue;
    bars.push({
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      open, high, low, close,
      volume: isFinite(parseFloat(v)) ? parseFloat(v) : 0,
    });
  }
  return bars; // 오래된 → 최신
}

export function kstNowPredict(): { date: string; minuteOfDay: number } {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: kst.toISOString().slice(0, 10), minuteOfDay: kst.getUTCHours() * 60 + kst.getUTCMinutes() };
}
