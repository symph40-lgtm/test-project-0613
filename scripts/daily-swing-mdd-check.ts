// 사다리 단계별 MDD 재현 점검 (사용자 지시 2026-08-08 — 내 시뮬 MDD 36/49 vs 스펙 기록 25~31 격차 규명):
//   npx tsx scripts/daily-swing-mdd-check.ts
// 스펙(docs/predict-daily-spec.md 5-3)의 확정 운영안 계보를 그대로 재현해 어디서 벌어지는지 본다.
//   P1 이진      : 미너비니 long 100% / else 0            (스펙 기록 삼전 +451%/MDD30 · 하닉 +1276/32)
//   P4 5단계     : 투표3+ 100 / 미너 long 75 / 완충 25 / 0 (스펙 기록 삼전 +444%/MDD24 · 하닉 +1046/32)
//   v4 현행 3단계 : 미너 long 100 / 와인 생존 50 / 0        (2026-07-22 밤 단순화 — 현재 라이브)
// 손절 오버레이는 스펙대로 '없음'이 기준(강제청산 시뮬은 삼전 유해로 기각됨) — 참고로 2.5×ATR판도 병기.
// ⚠재현 불가 요소: 매크로 게이트(10Y·DXY·이벤트 ×0.5)는 백테스트 매크로 이력이 필요해 여기선 제외.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, sma, ema, atr14, type Stance, type DailyBar } from "../lib/predict-daily/models";

const BUY_COST = 0.00015, SELL_COST = 0.00215;
const WARMUP = 260;
const f0 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;

type R = { cum: number; cagr: number; mdd: number; expo: number; stopHits: number };
function sim(bars: DailyBar[], from: number, to: number, expo: (i: number) => number, atr: (number | null)[], stopAtr = 0): R {
  let V = 1, peak = 1, mdd = 0, f = 0, anchor = 0, atrE = 0, expoSum = 0, days = 0, stopHits = 0, cooldown = 0;
  for (let i = from; i < to; i++) {
    let t = expo(i);
    if (cooldown > 0) { t = 0; cooldown--; }
    if (t !== f) {
      const d = t - f;
      V *= 1 - (d > 0 ? d * BUY_COST : -d * SELL_COST);
      if (f === 0 && t > 0) { anchor = bars[i].close; atrE = atr[i] ?? 0; }
      f = t;
    }
    expoSum += f; days++;
    const b1 = bars[i + 1];
    let ret = b1.close / bars[i].close - 1;
    if (f > 0 && stopAtr > 0 && atrE > 0) {
      // 2.5×ATR14 손절 (6~12% 클램프) — 스펙 확정값
      const w = Math.min(0.12, Math.max(0.06, (stopAtr * atrE) / anchor));
      const stopPx = anchor * (1 - w);
      if (b1.open <= stopPx || b1.low <= stopPx) {
        ret = (b1.open <= stopPx ? b1.open : stopPx) / bars[i].close - 1;
        V *= 1 + f * ret; V *= 1 - f * SELL_COST;
        stopHits++; f = 0; cooldown = 3;
        peak = Math.max(peak, V); mdd = Math.max(mdd, 1 - V / peak);
        continue;
      }
    }
    V *= 1 + f * ret;
    peak = Math.max(peak, V); mdd = Math.max(mdd, 1 - V / peak);
  }
  const yrs = days / 248;
  return { cum: (V - 1) * 100, cagr: yrs > 0.5 ? (Math.pow(V, 1 / yrs) - 1) * 100 : (V - 1) * 100, mdd: mdd * 100, expo: (100 * expoSum) / Math.max(1, days), stopHits };
}

async function run(sym: string, name: string, spec: string) {
  const bars = await fetchDailyPredict(sym, 2600);
  const c = bars.map(b => b.close);
  const st: Record<string, Stance[]> = {};
  for (const m of MODELS) st[m.id] = m.run(bars);
  const L = (id: string, i: number) => st[id][i] === "long";
  const atr = atr14(bars);
  const ma50 = sma(c, 50), ma200 = sma(c, 200);
  const e13 = ema(c, 13);
  // 중장기 투표 3종 (스펙 5-7): 와인스타인 생존 + 골든크로스(MA50>MA200) + 엘더 조류(EMA13 상승)
  const vote3 = (i: number) => L("weinstein", i) && ma50[i] != null && ma200[i] != null && ma50[i]! > ma200[i]!
    && e13[i] != null && e13[i - 5] != null && e13[i]! > e13[i - 5]!;

  const P1 = (i: number) => (L("minervini", i) ? 1 : 0);
  const P4 = (i: number) => (L("minervini", i) ? (vote3(i) ? 1 : 0.75) : L("weinstein", i) ? 0.25 : 0);
  const V4 = (i: number) => (L("minervini", i) ? 1 : L("weinstein", i) ? 0.5 : 0);
  const BH = () => 1;

  // 단기 구간 표 (사용자 질문 2026-08-08 "최근 1개월은 성능이 어때")
  {
    const N = c.length - 1;
    console.log(`\n──── ${name} 최근 구간 (손절 없음·비중만 다름) ────`);
    console.log(`  ${"배분".padEnd(26)}${["7거래일", "20거래일", "1개월(21)", "2개월(42)", "3개월(63)"].map(s => s.padStart(15)).join("")}`);
    for (const [label, f] of [["P1 이진 (미너 100/0)", P1], ["P4 5단계 (완충 25%)", P4], ["v4 현행 (완충 50%)", V4], ["(참고) 항상 100%", BH]] as [string, (i: number) => number][]) {
      const cells = [7, 20, 21, 42, 63].map((n) => {
        const r = sim(bars, Math.max(WARMUP, N - n), N, f, atr, 0);
        return `${r.cum >= 0 ? "+" : ""}${r.cum.toFixed(1)}%/노출${r.expo.toFixed(0)}`.padStart(15);
      });
      console.log(`  ${label.padEnd(26)}${cells.join("")}`);
    }
  }

  const from = WARMUP, to = c.length - 1;
  // v4 채택 시점(2026-07-22)까지로 잘라 대조 — 그 뒤 급락 2주가 결론을 뒤집었는지 확인
  let cutIdx = bars.findIndex(b => b.date > "2026-07-22"); if (cutIdx < 0) cutIdx = to; else cutIdx -= 1;
  console.log(`\n════ ${name} (${bars[from].date} ~ ${bars[to].date}) — 스펙 기록: ${spec} ════`);
  console.log(`  ${"배분".padEnd(28)} ${"전체·손절없음(스펙 기준)".padStart(30)} ${"+2.5×ATR 손절".padStart(24)} ${"~7/22 (v4 채택 시점)".padStart(24)}`);
  for (const [label, f] of [["P1 이진 (미너 100/0)", P1], ["P4 5단계 (투표100/미너75/완충25)", P4], ["v4 현행 (미너100/와인50)", V4], ["(참고) 항상 100%", BH]] as [string, (i: number) => number][]) {
    const a = sim(bars, from, to, f, atr, 0);
    const b = sim(bars, from, to, f, atr, 2.5);
    const d = sim(bars, from, cutIdx, f, atr, 0);
    console.log(`  ${label.padEnd(28)} ${`${f0(a.cum)}% CAGR${a.cagr.toFixed(0)} MDD${a.mdd.toFixed(0)} 노출${a.expo.toFixed(0)}%`.padStart(30)} ${`${f0(b.cum)}% MDD${b.mdd.toFixed(0)} 컷${b.stopHits}회`.padStart(24)} ${`${f0(d.cum)}% MDD${d.mdd.toFixed(0)}`.padStart(24)}`);
  }
}

async function main() {
  await run("005930", "삼성전자", "P1 +451%/MDD30 · P4 +444%/MDD24");
  await run("000660", "SK하이닉스", "P1 +1276%/MDD32 · P4 +1046%/MDD32");
  console.log(`\n  ⚠ 매크로 게이트(10Y·DXY·이벤트 ×0.5)는 미반영 — 스펙 P4의 '현금화 약 50%' 단계는 게이트가 만든다.`);
}
main();
