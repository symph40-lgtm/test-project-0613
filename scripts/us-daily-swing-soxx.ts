// predict-daily(일봉 스윙 — 미너비니 사다리 v4)의 SOXX/SOXL 검증 (사용자 지시 2026-08-03 "해봐"):
//   npx tsx scripts/us-daily-swing-soxx.ts
// 라이브 판정 함수(lib/predict-daily judgeAt — 미너비니 풀보유 1.0 / 와인스타인 생존 0.5 / 붕괴 0,
// ATR 2.5x 손절 6~12% 클램프)를 야후 SOXX 일봉(~10년)에 그대로 실행. 매크로 게이트는 judgeAt이 소급 생략.
// 채점: daily-swing-strategy.ts 관례 — 마감 판정 비중을 익일 수익률에 적용·손절 갭이탈 시가 체결·
//   컷 후 3일 재진입 금지 없음(운영안 v4는 스탑을 judge 내장 stopPct로) → 여기선 anchor 손절만.
// 비용: 미장 0.07%/편도 (trading-fees.md). SOXL은 일중 3배 근사(일별 3×수익률 복리 — 비용·괴리 미반영 명시).
// + 지난주(7/24~8/1) 일별 판정 상세 — 7/29 급락 후 모델이 어떻게 반응했는지.

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { judgeAt } from "../lib/predict-daily/judge";
import type { DailyBar } from "../lib/predict-daily/types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const COST = 0.0007; // 미장 편도

async function fetchDaily(symbol: string, years: number): Promise<DailyBar[]> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - years * 365 * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } =>
      q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({
      date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0,
    }));
}

type Sim = { cum: number; cagr: number; mdd: number; expo: number; trades: number; winRate: number };
function sim(bars: DailyBar[], from: number, to: number, lev: number): Sim {
  let V = 1, peakV = 1, mdd = 0, fCur = 0, anchor = 0, stopPx = -Infinity;
  let expoSum = 0, days = 0, trades = 0, wins = 0;
  for (let i = from; i < to - 1; i++) {
    const j = judgeAt(bars, i); // 마감 판정 (supertrendBrake 없음 — 하닉 스타일)
    let target = j.exposure;
    if (target !== fCur) {
      const d = target - fCur;
      V *= 1 - Math.abs(d) * COST * (lev > 1 ? 1 : 1);
      if (fCur === 0 && target > 0) { anchor = bars[i].close; stopPx = bars[i].close * (1 - j.stopPct); }
      if (target === 0 && fCur > 0) { trades++; if (bars[i].close > anchor * (1 + 2 * COST)) wins++; }
      fCur = target;
    } else if (fCur > 0 && j.stopPct) {
      stopPx = Math.max(stopPx, -Infinity); // 손절 앵커 고정 (진입 시점 기준 — 운영안)
    }
    expoSum += fCur; days++;
    const b1 = bars[i + 1];
    if (fCur > 0) {
      let dayRet = b1.close / bars[i].close - 1;
      let exited = false;
      if (b1.open <= stopPx || b1.low <= stopPx) {
        const exitPx = b1.open <= stopPx ? b1.open : stopPx;
        dayRet = exitPx / bars[i].close - 1;
        exited = true;
      }
      V *= 1 + fCur * dayRet * lev;
      if (exited) {
        V *= 1 - fCur * COST;
        trades++; if ((b1.open <= stopPx ? b1.open : stopPx) > anchor * (1 + 2 * COST)) wins++;
        fCur = 0;
      }
    }
    peakV = Math.max(peakV, V);
    mdd = Math.max(mdd, 1 - V / peakV);
  }
  const years = days / 250;
  return {
    cum: (V - 1) * 100,
    cagr: years > 0.5 ? (Math.pow(Math.max(V, 1e-9), 1 / years) - 1) * 100 : (V - 1) * 100,
    mdd: mdd * 100, expo: days ? expoSum / days : 0, trades, winRate: trades ? (100 * wins) / trades : 0,
  };
}
function buyHold(bars: DailyBar[], from: number, to: number, lev: number): { cum: number; mdd: number } {
  let V = 1, peak = 1, mdd = 0;
  for (let i = from; i < to - 1; i++) {
    V *= 1 + (bars[i + 1].close / bars[i].close - 1) * lev;
    peak = Math.max(peak, V);
    mdd = Math.max(mdd, 1 - V / peak);
  }
  return { cum: (V - 1) * 100, mdd: mdd * 100 };
}

async function main() {
  const bars = await fetchDaily("SOXX", 10);
  const WARMUP = 260;
  const n = bars.length;
  console.log(`════ predict-daily(미너비니 사다리 v4) SOXX 검증 — ${n}일 (${bars[0]?.date} ~ ${bars[n - 1]?.date}) ════`);
  for (const [label, from] of [["전체(워밍업 후)", WARMUP], [`최근 1년`, Math.max(WARMUP, n - 250)], [`최근 3년`, Math.max(WARMUP, n - 750)]] as const) {
    const r1 = sim(bars, from as number, n, 1);
    const bh1 = buyHold(bars, from as number, n, 1);
    const r3 = sim(bars, from as number, n, 3);
    const bh3 = buyHold(bars, from as number, n, 3);
    console.log(`\n[${label}] (${bars[from as number].date}~)`);
    console.log(`  SOXX 1x: 전략 ${s1(r1.cum)}% (CAGR ${s1(r1.cagr)}%·MDD ${r1.mdd.toFixed(0)}%·노출 ${(r1.expo * 100).toFixed(0)}%·매매 ${r1.trades}회·승률 ${r1.winRate.toFixed(0)}%) vs 보유 ${s1(bh1.cum)}% (MDD ${bh1.mdd.toFixed(0)}%)`);
    console.log(`  SOXL 3x근사: 전략 ${s1(r3.cum)}% (MDD ${r3.mdd.toFixed(0)}%) vs 보유 ${s1(bh3.cum)}% (MDD ${bh3.mdd.toFixed(0)}%)`);
  }

  console.log(`\n[지난주 일별 판정 — 마감 기준 (미너비니/사다리 비중/손절가)]`);
  const lastDays = bars.map((b, i) => ({ b, i })).filter(({ b }) => b.date >= "2026-07-23" && b.date <= "2026-08-01");
  for (const { b, i } of lastDays) {
    const j = judgeAt(bars, i);
    const chg = i > 0 ? ((b.close / bars[i - 1].close) - 1) * 100 : 0;
    console.log(`  ${b.date}: 종가 $${b.close.toFixed(2)} (${s2(chg)}%) — 미너비니 ${j.stance} · 투표 ${j.votes >= 0 ? "+" : ""}${j.votes} · 비중 ${(j.exposure * 100).toFixed(0)}%${j.stopPx ? ` · 손절 $${(b.close * (1 - j.stopPct)).toFixed(2)}(-${(j.stopPct * 100).toFixed(1)}%)` : ""}${j.gates.length ? ` · 게이트 ${j.gates.join(",")}` : ""}`);
  }
  console.log(`\n주: 판정은 라이브 judgeAt 그대로(매크로 게이트 소급 생략). SOXL 3x는 일별 3배 복리 근사 — 실제 SOXL과 괴리 있음.`);
  console.log(`    이 모델은 추세추종(강세 보유)이라 급락일 '저점 매수'가 아니라 '추세 유지 중 계속 보유'로 오버나이트 반등을 잡는다.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
