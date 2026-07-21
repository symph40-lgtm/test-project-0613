// 일봉 조회 (네이버 fchart) — 분리 원칙상 자체 구현 (lib/predict/data.ts와 동일 소스).
// 장중 호출 시 마지막 봉은 진행 중 봉(현재가) — 15:05+ 판정에서는 잠정 종가로 사용.

import type { DailyBar } from "./types";

export async function fetchDaily(symbol: string, count: number): Promise<DailyBar[]> {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://m.stock.naver.com/" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`일봉 조회 실패 ${res.status}`);
  const xml = await res.text();
  const bars: DailyBar[] = [];
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

export function kstNowDaily(): { date: string; minuteOfDay: number; weekday: number } {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    date: kst.toISOString().slice(0, 10),
    minuteOfDay: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
    weekday: kst.getUTCDay(), // 0=일
  };
}
