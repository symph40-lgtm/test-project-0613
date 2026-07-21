// 매크로 스냅샷 (야후) — 판정 시점(15:05+ KST)에 아는 값: 간밤 SOX·전일 환율·전일 미 10Y.
// 게이트로 쓰는 건 10Y 급등뿐 (11종 스윕 중 유일 통과 — 스펙 6장). 나머지는 표시·기록용.

import YahooFinance from "yahoo-finance2";
import type { MacroSnap } from "./types";

const yf = new YahooFinance();

type Series = { date: string; close: number }[];

async function daySeries(symbol: string, days = 30): Promise<Series> {
  try {
    const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
    return (r.quotes ?? [])
      .filter((q) => q.close != null && isFinite(q.close as number))
      .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close as number }));
  } catch {
    return [];
  }
}

// kstDate 이전 최근 2개 종가 [직전, 그전] — 미국장은 자연히 간밤 종가가 됨
function lastTwoBefore(s: Series, kstDate: string): [number, number] | null {
  for (let i = s.length - 1; i >= 1; i--) if (s[i].date < kstDate) return [s[i].close, s[i - 1].close];
  return null;
}

export async function fetchMacroSnap(kstDate: string): Promise<MacroSnap> {
  const [sox, fx, tnx, wti, dxy] = await Promise.all([
    daySeries("^SOX"), daySeries("KRW=X"), daySeries("^TNX"), daySeries("CL=F"), daySeries("DX-Y.NYB"),
  ]);
  const norm10y = (v: number) => (v > 20 ? v / 10 : v); // ^TNX 표기 편차 방어
  const s = lastTwoBefore(sox, kstDate), f = lastTwoBefore(fx, kstDate), t = lastTwoBefore(tnx, kstDate);
  const w = lastTwoBefore(wti, kstDate), d = lastTwoBefore(dxy, kstDate);
  return {
    sox: s ? ((s[0] - s[1]) / s[1]) * 100 : null,
    fxLevel: f ? f[0] : null,
    fxChg: f ? ((f[0] - f[1]) / f[1]) * 100 : null,
    y10: t ? norm10y(t[0]) : null,
    y10Chg: t ? norm10y(t[0]) - norm10y(t[1]) : null,
    wti: w ? w[0] : null,
    wtiChg: w ? ((w[0] - w[1]) / w[1]) * 100 : null,
    dxy: d ? d[0] : null,
    dxyChg: d ? ((d[0] - d[1]) / d[1]) * 100 : null,
  };
}
