// 일봉 스윙 — ②이벤트 D-감산(FOMC·CPI·고용 실일정) ③절대 구간 진입 게이트 백테스트.
// 기획: docs/predict-daily-spec.md 9장 (사용자 가설 2026-07-27: "금리·환율·유가는 절대값 구간
// 진입이 위기, FOMC·CPI·고용은 상대(서프라이즈)"). 캘린더: lib/predict-daily/eventCalendar.ts
// (연준·BLS 공식 일정 2016~). 프레임: daily-swing-macro.ts와 동일 — P1(미너비니 이진) 복리·비용
// 반영, 2종목×전체/최근3년. 기준 2종: P1 단독 / P1+기채택(10Y급등·DXY급등·NFP첫금) 스택 —
// 신규 게이트는 스택 위 "한계 기여"로 판정 (채택 기준: 2종목×2구간 4/4 개선).
//   npx tsx scripts/daily-swing-event-zone.ts

import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";
import { MODELS } from "./daily-swing-models";
import { FOMC_DECISION_DATES, CPI_RELEASE_DATES, ES_RELEASE_DATES } from "../lib/predict-daily/eventCalendar";

const WARMUP = 260, BUY = 0.00015, SELL = 0.00215;
const yf = new YahooFinance();

type Series = { date: string; close: number }[];
async function daySeries(symbol: string, days: number): Promise<Series> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((q) => q.close != null && isFinite(q.close as number))
    .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close as number }));
}
function lastTwoBefore(s: Series, kstDate: string): [number, number] | null {
  for (let i = s.length - 1; i >= 1; i--) if (s[i].date < kstDate) return [s[i].close, s[i - 1].close];
  return null;
}
const isFirstFriday = (dateStr: string): boolean => {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getUTCDay() === 5 && d.getUTCDate() <= 7;
};

function simGate(
  bars: PredictDailyBar[], from: number, to: number,
  base: (i: number) => number,
  closeGate: ((i: number) => number) | null,
): { cum: number; mdd: number } {
  let V = 1, peakV = 1, mdd = 0, f = 0;
  for (let i = from; i < to; i++) {
    let target = base(i);
    if (closeGate && target > 0) target *= closeGate(i);
    if (target !== f) { const d = target - f; V *= 1 - (d > 0 ? d * BUY : -d * SELL); f = target; }
    V *= 1 + f * (bars[i + 1].close / bars[i].close - 1);
    peakV = Math.max(peakV, V); mdd = Math.max(mdd, 1 - V / peakV);
  }
  return { cum: (V - 1) * 100, mdd: mdd * 100 };
}

async function main() {
  const [fx, tnx, wti, dxy] = await Promise.all([
    daySeries("KRW=X", 4300), daySeries("^TNX", 4300), daySeries("CL=F", 4300), daySeries("DX-Y.NYB", 4300),
  ]);
  const norm10y = (v: number) => (v > 20 ? v / 10 : v);
  // 이벤트 → 한국 감산 적용일 매핑: "발표 전 마지막 한국 마감" = 캘린더 날짜 이하의 마지막 거래일
  const mapToBarIdx = (bars: PredictDailyBar[], dates: string[]): Set<number> => {
    const out = new Set<number>();
    for (const d of dates) {
      for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date <= d) { if (d <= bars[bars.length - 1].date) out.add(i); break; }
    }
    return out;
  };
  // 절대 구간 진입: 시리즈가 임계 lv를 "아래→위로 처음 통과"한 날부터 nDays일간 true (재무장: 임계 아래로 5일 이상 내려가면)
  const zoneEntryDays = (s: Series, lv: number, nDays: number): Set<string> => {
    const out = new Set<string>();
    let below = 0, armed = true, fireLeft = 0;
    for (let i = 1; i < s.length; i++) {
      const v = s[i].close, pv = s[i - 1].close;
      if (v < lv) { below++; if (below >= 5) armed = true; } else below = 0;
      if (armed && pv < lv && v >= lv) { fireLeft = nDays; armed = false; }
      if (fireLeft > 0) { out.add(s[i].date); fireLeft--; }
    }
    return out;
  };
  // 52주 신고 돌파 첫 nDays일
  const yearHighEntry = (s: Series, nDays: number): Set<string> => {
    const out = new Set<string>();
    let fireLeft = 0;
    for (let i = 260; i < s.length; i++) {
      const hi = Math.max(...s.slice(i - 260, i).map((x) => x.close));
      if (s[i].close > hi && fireLeft === 0) fireLeft = nDays;
      if (fireLeft > 0) { out.add(s[i].date); fireLeft--; }
    }
    return out;
  };
  // 시리즈 날짜 Set → 한국 봉 게이트 (전일 값 기준: kstDate 직전 시리즈 날짜가 Set에 있으면)
  const seriesGate = (s: Series, days: Set<string>) => (kstDate: string): boolean => {
    for (let i = s.length - 1; i >= 0; i--) if (s[i].date < kstDate) return days.has(s[i].date);
    return false;
  };

  for (const sym of ["005930", "000660"]) {
    const bars = await fetchDailyPredict(sym, 2600);
    const n = bars.length;
    const min = MODELS.find((m) => m.id === "minervini")!.run(bars);
    const p1 = (i: number) => (min[i] === "long" ? 1 : 0);
    const y10ChgAt = (d: string) => { const t = lastTwoBefore(tnx, d); return t ? norm10y(t[0]) - norm10y(t[1]) : null; };
    const y10At = (d: string) => { const t = lastTwoBefore(tnx, d); return t ? norm10y(t[0]) : null; };
    const dxyChgAt = (d: string) => { const t = lastTwoBefore(dxy, d); return t ? ((t[0] - t[1]) / t[1]) * 100 : null; };
    // 기채택 스택 (라이브): 10Y급등≥0.08%p ×0.5 · DXY급등≥0.8% ×0.5 · NFP(첫금) ×0.5
    const adopted = (i: number): number => {
      let m = 1;
      const yc = y10ChgAt(bars[i].date); if (yc !== null && yc >= 0.08) m *= 0.5;
      const dc = dxyChgAt(bars[i].date); if (dc !== null && dc >= 0.8) m *= 0.5;
      if (isFirstFriday(bars[i].date)) m *= 0.5;
      return m;
    };
    const fomcIdx = mapToBarIdx(bars, FOMC_DECISION_DATES);
    const cpiIdx = mapToBarIdx(bars, CPI_RELEASE_DATES);
    const esIdx = mapToBarIdx(bars, ES_RELEASE_DATES);

    const zones: { name: string; gate: (d: string) => boolean }[] = [
      { name: "환율 1450 진입+3일", gate: seriesGate(fx, zoneEntryDays(fx, 1450, 3)) },
      { name: "환율 1500 진입+3일", gate: seriesGate(fx, zoneEntryDays(fx, 1500, 3)) },
      { name: "10Y 4.5 진입+3일", gate: seriesGate(tnx, zoneEntryDays(tnx.map((x) => ({ ...x, close: norm10y(x.close) })), 4.5, 3)) },
      { name: "10Y 4.75 진입+3일", gate: seriesGate(tnx, zoneEntryDays(tnx.map((x) => ({ ...x, close: norm10y(x.close) })), 4.75, 3)) },
      { name: "WTI 85 진입+3일", gate: seriesGate(wti, zoneEntryDays(wti, 85, 3)) },
      { name: "환율 52주신고 돌파+5일", gate: seriesGate(fx, yearHighEntry(fx, 5)) },
      { name: "10Y 52주신고 돌파+5일", gate: seriesGate(tnx, yearHighEntry(tnx, 5)) },
      { name: "DXY 52주신고 돌파+5일", gate: seriesGate(dxy, yearHighEntry(dxy, 5)) },
    ];

    const rules: { name: string; base: (i: number) => number; cg?: (i: number) => number }[] = [
      { name: "기준A: P1 단독", base: p1 },
      { name: "기준B: P1+기채택 스택", base: p1, cg: adopted },
      { name: "  +FOMC 결정일 ×0.5", base: p1, cg: (i) => adopted(i) * (fomcIdx.has(i) ? 0.5 : 1) },
      { name: "  +CPI 발표일 ×0.5", base: p1, cg: (i) => adopted(i) * (cpiIdx.has(i) ? 0.5 : 1) },
      { name: "  +고용 실일정 ×0.5 (첫금 대체)", base: p1, cg: (i) => {
          let m = 1;
          const yc = y10ChgAt(bars[i].date); if (yc !== null && yc >= 0.08) m *= 0.5;
          const dc = dxyChgAt(bars[i].date); if (dc !== null && dc >= 0.8) m *= 0.5;
          if (esIdx.has(i)) m *= 0.5; // 첫 금요일 규칙 대신 실제 발표일
          return m;
        } },
      { name: "  +FOMC+CPI 둘다 ×0.5", base: p1, cg: (i) => adopted(i) * (fomcIdx.has(i) ? 0.5 : 1) * (cpiIdx.has(i) ? 0.5 : 1) },
      ...zones.map((z) => ({ name: `  +구간: ${z.name} ×0.5`, base: p1, cg: (i: number) => adopted(i) * (z.gate(bars[i].date) ? 0.5 : 1) })),
      // 결합 (1차 결과 4/4 통과 2종 — 환율·DXY 52주신고. 상관 높아 결합 방식 확정용)
      { name: "  +콤보 곱: 환율52주×0.5 · DXY52주×0.5", base: p1, cg: (i) => adopted(i) * (zones[5].gate(bars[i].date) ? 0.5 : 1) * (zones[7].gate(bars[i].date) ? 0.5 : 1) },
      { name: "  +콤보 단일: 환율 또는 DXY 52주신고 → ×0.5", base: p1, cg: (i) => adopted(i) * (zones[5].gate(bars[i].date) || zones[7].gate(bars[i].date) ? 0.5 : 1) },
      { name: "  +레벨조건 급등강화 (10Y≥4.5 & 급등 → ×0.33)", base: p1, cg: (i) => {
          let m = 1;
          const yc = y10ChgAt(bars[i].date), yl = y10At(bars[i].date);
          if (yc !== null && yc >= 0.08) m *= yl !== null && yl >= 4.5 ? 0.33 : 0.5;
          const dc = dxyChgAt(bars[i].date); if (dc !== null && dc >= 0.8) m *= 0.5;
          if (isFirstFriday(bars[i].date)) m *= 0.5;
          return m;
        } },
    ];

    console.log(`\n■ ${sym} (봉 ${n}개, ${bars[0]?.date}~)`);
    for (const w of [{ name: "전체", from: WARMUP }, { name: "최근 3년", from: Math.max(WARMUP, n - 1 - 750) }]) {
      console.log(`  [${w.name}]`);
      for (const r of rules) {
        const s = simGate(bars, w.from, n - 1, r.base, r.cg ?? null);
        console.log(`    ${r.name.padEnd(40)} 누적 ${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(0)}%  MDD ${s.mdd.toFixed(0)}%`);
      }
    }
    // 참고: 이벤트일 익일 실현 분포 (게이트 정보가치 원천)
    for (const [nm, set] of [["FOMC", fomcIdx], ["CPI", cpiIdx], ["고용", esIdx]] as const) {
      let c = 0, dn = 0, sumAbs = 0;
      for (const i of set) { if (i >= WARMUP && i < n - 1) { c++; const r = (bars[i + 1].close / bars[i].close - 1) * 100; if (r < 0) dn++; sumAbs += Math.abs(r); } }
      console.log(`  ▸ ${nm} 적용일 ${c}회: 익일 하락 ${c ? Math.round((100 * dn) / c) : 0}% · 익일 평균|변동| ${c ? (sumAbs / c).toFixed(2) : "?"}%`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
