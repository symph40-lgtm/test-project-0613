// 일봉 스윙 — 매크로 게이트·이벤트 규칙 백테스트. 기획: docs/predict-daily-spec.md 6장.
//   npx tsx scripts/daily-swing-macro.ts
//
// P1(미너비니 이진) 위에 매크로 게이트를 얹어 개선 여부 검증 (2종목 × 전체/최근3년, 비용 반영 복리).
// 시점 정합: t일 15:10 마감 판정이 아는 것 = 간밤(t일 아침 마감) SOX·전일 환율·전일 10Y.
//   "아침 게이트"는 t+1 아침에 간밤(t일 밤) 미국장을 보고 t+1 시가에 이탈 — 시가 체결로 모델링.
// 이벤트: NFP=매월 첫 금요일(결정론적) 마감 후 21:30 KST 발표 → 그날 마감 판정에 감산 규칙 검증.

import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";
import { MODELS } from "./daily-swing-models";

const WARMUP = 260, BUY = 0.00015, SELL = 0.00215;
const yf = new YahooFinance();

type Series = { date: string; close: number }[];
async function daySeries(symbol: string, days: number): Promise<Series> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((q) => q.close != null && isFinite(q.close as number))
    .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close as number }));
}
// kstDate 이전 최근 2개 종가 [직전, 그전] — lib/predict/macro.ts와 동일 규칙
function lastTwoBefore(s: Series, kstDate: string): [number, number] | null {
  for (let i = s.length - 1; i >= 1; i--) if (s[i].date < kstDate) return [s[i].close, s[i - 1].close];
  return null;
}

// 매월 첫 금요일 (NFP 발표일 근사 — 21:30 KST 그날 밤 발표)
function isFirstFriday(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getUTCDay() === 5 && d.getUTCDate() <= 7;
}

type Macro = { sox: number | null; fxChg: number | null; fxLevel: number | null; y10: number | null; y10Chg: number | null };

function simGate(
  bars: PredictDailyBar[], from: number, to: number,
  base: (i: number) => number,
  closeGate: ((i: number, holding: boolean) => number) | null, // 마감 판정 배수/차단 (1=그대로, 0=현금)
  morningExit: ((j: number) => boolean) | null, // t+1 아침 간밤 악재 → 시가 이탈
): { cum: number; mdd: number } {
  let V = 1, peakV = 1, mdd = 0, f = 0;
  for (let i = from; i < to; i++) {
    let target = base(i);
    if (closeGate && target > 0) target *= closeGate(i, f > 0);
    if (target !== f) { const d = target - f; V *= 1 - (d > 0 ? d * BUY : -d * SELL); f = target; }
    if (f > 0 && morningExit && morningExit(i + 1)) {
      // 아침 이탈: 시가 체결 후 당일 현금
      V *= 1 + f * (bars[i + 1].open / bars[i].close - 1);
      V *= 1 - f * SELL;
      f = 0;
    } else {
      V *= 1 + f * (bars[i + 1].close / bars[i].close - 1);
    }
    peakV = Math.max(peakV, V); mdd = Math.max(mdd, 1 - V / peakV);
  }
  return { cum: (V - 1) * 100, mdd: mdd * 100 };
}

async function main() {
  const [sox, fx, tnx] = await Promise.all([daySeries("^SOX", 4300), daySeries("KRW=X", 4300), daySeries("^TNX", 4300)]);
  console.log(`매크로 이력: SOX ${sox.length}일(${sox[0]?.date}~), 환율 ${fx.length}일, 10Y ${tnx.length}일`);
  const norm10y = (v: number) => (v > 20 ? v / 10 : v);
  const macroAt = (kstDate: string): Macro => {
    const s = lastTwoBefore(sox, kstDate), f = lastTwoBefore(fx, kstDate), t = lastTwoBefore(tnx, kstDate);
    return {
      sox: s ? ((s[0] - s[1]) / s[1]) * 100 : null,
      fxChg: f ? ((f[0] - f[1]) / f[1]) * 100 : null,
      fxLevel: f ? f[0] : null,
      y10: t ? norm10y(t[0]) : null,
      y10Chg: t ? norm10y(t[0]) - norm10y(t[1]) : null,
    };
  };

  for (const sym of ["005930", "000660"]) {
    const bars = await fetchDailyPredict(sym, 2600);
    const n = bars.length;
    const min = MODELS.find((m) => m.id === "minervini")!.run(bars);
    const p1 = (i: number) => (min[i] === "long" ? 1 : 0);
    const m = bars.map((b) => macroAt(b.date)); // m[i] = i일 아침 기준 간밤·전일 값 (마감 판정에도 동일 최신값)

    const rules: { name: string; cg?: (i: number, holding: boolean) => number; me?: (j: number) => boolean }[] = [
      { name: "기준 P1 (매크로 없음)" },
      { name: "마감: 간밤SOX≤-2% → 현금", cg: (i) => (m[i].sox !== null && m[i].sox! <= -2 ? 0 : 1) },
      { name: "마감: 간밤SOX≤-2% → 절반", cg: (i) => (m[i].sox !== null && m[i].sox! <= -2 ? 0.5 : 1) },
      { name: "마감: 환율≥1540|10Y≥4.6 신규금지", cg: (i, holding) => ((m[i].fxLevel ?? 0) >= 1540 || (m[i].y10 ?? 0) >= 4.6 ? (holding ? 1 : 0) : 1) },
      { name: "마감: 환율급등≥0.7% → 절반", cg: (i) => (m[i].fxChg !== null && m[i].fxChg! >= 0.7 ? 0.5 : 1) },
      { name: "마감: 10Y급등≥0.08%p → 절반", cg: (i) => (m[i].y10Chg !== null && m[i].y10Chg! >= 0.08 ? 0.5 : 1) },
      { name: "마감: 악화2개↑ → 현금 (M7 LM식)", cg: (i) => {
          let bad = 0;
          if (m[i].sox !== null && m[i].sox! <= -1.5) bad++;
          if (m[i].fxChg !== null && m[i].fxChg! >= 0.5) bad++;
          if (m[i].y10Chg !== null && m[i].y10Chg! >= 0.05) bad++;
          return bad >= 2 ? 0 : 1;
        } },
      { name: "아침: 간밤SOX≤-2% → 시가이탈", me: (j) => j < n && m[j].sox !== null && m[j].sox! <= -2 },
      { name: "아침: 간밤SOX≤-3% → 시가이탈", me: (j) => j < n && m[j].sox !== null && m[j].sox! <= -3 },
      { name: "이벤트: NFP일(첫금) 마감 → 절반", cg: (i) => (isFirstFriday(bars[i].date) ? 0.5 : 1) },
      { name: "이벤트: NFP일(첫금) 마감 → 현금", cg: (i) => (isFirstFriday(bars[i].date) ? 0 : 1) },
    ];

    console.log(`\n■ ${sym}`);
    for (const w of [{ name: "전체", from: WARMUP }, { name: "최근 3년", from: Math.max(WARMUP, n - 1 - 750) }]) {
      console.log(`  [${w.name}]`);
      for (const r of rules) {
        const s = simGate(bars, w.from, n - 1, p1, r.cg ?? null, r.me ?? null);
        console.log(`    ${r.name.padEnd(30)} 누적 ${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(0)}%  MDD ${s.mdd.toFixed(0)}%`);
      }
    }
    // 참고 통계: 간밤 SOX -2% 이하였던 날의 당일·익일 분포 (게이트 정보가치 원천 확인)
    let cnt = 0, dayDn = 0, nextDn = 0;
    for (let i = WARMUP; i < n - 1; i++) {
      if (m[i].sox === null || m[i].sox! > -2) continue;
      cnt++;
      if (bars[i].close < bars[i].open) dayDn++; // 간밤 악재일의 당일 시가→종가
      if (bars[i + 1].close < bars[i].close) nextDn++; // 마감 판정 관점의 익일
    }
    console.log(`  ▸ 간밤SOX≤-2%였던 날 ${cnt}회: 당일 시가→종가 하락 ${cnt ? Math.round((100 * dayDn) / cnt) : 0}%, 익일 종가 하락 ${cnt ? Math.round((100 * nextDn) / cnt) : 0}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
