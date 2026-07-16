// M7 근사 모델용 매크로 이력 (야후) — 간밤 SOX·전일 환율·미 10년물.
// KST 날짜 d 기준 "직전" 값 = d 이전 가장 최근 종가 (미국장은 자연히 간밤 종가가 됨).
// 주의: 2년물은 과거 이력 소스가 없어 10년물(^TNX)로 근사 — LM 게이트도 10Y(≥4.6%)·환율만 적용.

import YahooFinance from "yahoo-finance2";
import type { MacroDay } from "./types";

const yf = new YahooFinance();

type Series = { date: string; close: number }[];

async function daySeries(symbol: string, days = 420): Promise<Series> {
  try {
    const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
    return (r.quotes ?? [])
      .filter((q) => q.close != null && isFinite(q.close as number))
      .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close as number }));
  } catch {
    return [];
  }
}

// kstDate 이전 최근 2개 종가 → [직전, 그 전]
function lastTwoBefore(s: Series, kstDate: string): [number, number] | null {
  for (let i = s.length - 1; i >= 1; i--) {
    if (s[i].date < kstDate) return [s[i].close, s[i - 1].close];
  }
  return null;
}

// 매크로 이력 로더 — 한 번 받아서 날짜별 조회 함수 반환 (백테스트·라이브 공용)
export async function loadMacroHistory(): Promise<(kstDate: string) => MacroDay> {
  const [sox, fx, tnx] = await Promise.all([daySeries("^SOX"), daySeries("KRW=X"), daySeries("^TNX")]);
  return (kstDate: string): MacroDay => {
    const s = lastTwoBefore(sox, kstDate);
    const f = lastTwoBefore(fx, kstDate);
    const t = lastTwoBefore(tnx, kstDate);
    const norm10y = (v: number) => (v > 20 ? v / 10 : v); // ^TNX 표기 편차 방어
    return {
      soxPrevChg: s ? ((s[0] - s[1]) / s[1]) * 100 : null,
      usdkrwPrevChg: f ? ((f[0] - f[1]) / f[1]) * 100 : null,
      usdkrwLevel: f ? f[0] : null,
      us10yPrevPp: t ? norm10y(t[0]) - norm10y(t[1]) : null,
      us10yLevel: t ? norm10y(t[0]) : null,
    };
  };
}
