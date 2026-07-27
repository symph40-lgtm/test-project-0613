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

// 52주 신고 돌파 구간 (스펙 9장, 2026-07-27 채택 — daily-swing-event-zone.ts 4/4 실측):
// 종가가 직전 260일 최고를 돌파한 날부터 5일간 true — 지속 신고면 5일마다 재점화 (백테스트와 동일).
// kstDate 기준 게이트 값 = 직전 시리즈 날짜가 구간에 속하는가.
function inYearHighZone(s: Series, kstDate: string, nDays = 5): boolean | null {
  if (s.length < 280) return null;
  const fireDays = new Set<string>();
  let fireLeft = 0;
  for (let i = 260; i < s.length; i++) {
    const hi = Math.max(...s.slice(i - 260, i).map((x) => x.close));
    if (s[i].close > hi && fireLeft === 0) fireLeft = nDays;
    if (fireLeft > 0) { fireDays.add(s[i].date); fireLeft--; }
  }
  for (let i = s.length - 1; i >= 0; i--) if (s[i].date < kstDate) return fireDays.has(s[i].date);
  return null;
}

// 52주 범위 내 현재 위치 0~100% (표시 전용 — "절대 레벨의 역사적 맥락")
function pos52(s: Series, kstDate: string): number | null {
  const win: number[] = [];
  let cur: number | null = null;
  for (const x of s) { if (x.date < kstDate) { win.push(x.close); cur = x.close; } }
  const w = win.slice(-260);
  if (w.length < 100 || cur === null) return null;
  const lo = Math.min(...w), hi = Math.max(...w);
  return hi > lo ? Math.round(((cur - lo) / (hi - lo)) * 100) : null;
}

export async function fetchMacroSnap(kstDate: string): Promise<MacroSnap> {
  const [sox, fx, tnx, wti, dxy] = await Promise.all([
    daySeries("^SOX"), daySeries("KRW=X", 430), daySeries("^TNX", 430), daySeries("CL=F"), daySeries("DX-Y.NYB", 430),
  ]);
  const norm10y = (v: number) => (v > 20 ? v / 10 : v); // ^TNX 표기 편차 방어
  const s = lastTwoBefore(sox, kstDate), f = lastTwoBefore(fx, kstDate), t = lastTwoBefore(tnx, kstDate);
  const w = lastTwoBefore(wti, kstDate), d = lastTwoBefore(dxy, kstDate);
  const tnxN = tnx.map((x) => ({ ...x, close: norm10y(x.close) }));
  return {
    zoneFx: inYearHighZone(fx, kstDate),
    zoneDxy: inYearHighZone(dxy, kstDate),
    fxPos52: pos52(fx, kstDate),
    y10Pos52: pos52(tnxN, kstDate),
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
