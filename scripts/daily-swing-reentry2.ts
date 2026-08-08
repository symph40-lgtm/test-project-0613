// 반등 재진입 가속 2차 (사용자 지시 2026-08-08): ①바닥권 한정 니슨 보조 ②니슨→와일더 순차 확인,
// 그리고 짧은 구간(7일·20일·1개월·2개월) 평가 추가.
//   npx tsx scripts/daily-swing-reentry2.ts
// ⚠짧은 구간은 표본 7~42일이라 통계가 아니다 — 규칙이 그 구간에 '발동이나 했는지'(발동일수)를 함께 본다.
//   발동 0일이면 현행과 수치가 같을 수밖에 없다.
// 기준선 R0 = 현행 사다리 v4 (미너비니 long 100% / 와인스타인 생존 50% / 붕괴 0%).
// 비용·복리·MDD 규약은 daily-swing-strategy.ts와 동일(매수 0.015%·매도 0.215%), 손절 오버레이 없음.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, sma, atr14, type Stance, type DailyBar } from "../lib/predict-daily/models";

const BUY_COST = 0.00015, SELL_COST = 0.00215;
const WARMUP = 260;
const f1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const f0 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;

function sim(bars: DailyBar[], from: number, to: number, expo: (i: number) => number) {
  let V = 1, peak = 1, mdd = 0, f = 0, expoSum = 0, days = 0;
  for (let i = from; i < to; i++) {
    const t = expo(i);
    if (t !== f) { const d = t - f; V *= 1 - (d > 0 ? d * BUY_COST : -d * SELL_COST); f = t; }
    expoSum += f; days++;
    V *= 1 + f * (bars[i + 1].close / bars[i].close - 1);
    peak = Math.max(peak, V); mdd = Math.max(mdd, 1 - V / peak);
  }
  return { cum: (V - 1) * 100, mdd: mdd * 100, expo: (100 * expoSum) / Math.max(1, days) };
}

async function run(sym: string, name: string) {
  const bars = await fetchDailyPredict(sym, 2600);
  const c = bars.map(b => b.close);
  const st: Record<string, Stance[]> = {};
  for (const m of MODELS) st[m.id] = m.run(bars);
  const L = (id: string, i: number) => st[id][i] === "long";
  const atr = atr14(bars);
  const ma20 = sma(c, 20), ma60 = sma(c, 60);

  // 바닥권 조건 (관측 가능): 60일 고점比 ≤ -4×ATR% 그리고 20일 수익 ≤ -2.5×ATR% — 변동성 정규화판
  const bottom = (i: number) => {
    const a = atr[i]; if (a == null || i < 60) return false;
    const ap = (a / c[i]) * 100;
    const hi60 = Math.max(...c.slice(i - 60, i + 1));
    return ((c[i] - hi60) / hi60) * 100 <= -4 * ap && ((c[i] - c[i - 20]) / c[i - 20]) * 100 <= -2.5 * ap;
  };
  // 이평 역배열 (보조 조건 후보)
  const rev = (i: number) => ma20[i] != null && ma60[i] != null && c[i] < ma20[i]! && ma20[i]! < ma60[i]!;
  // 순차 확인: id1이 최근 win일 안에 long이었고, 오늘 id2가 long
  const seq = (id1: string, id2: string, i: number, win = 5) => {
    if (!L(id2, i)) return false;
    for (let k = Math.max(0, i - win); k <= i; k++) if (L(id1, k)) return true;
    return false;
  };

  const R0 = (i: number) => (L("minervini", i) ? 1 : L("weinstein", i) ? 0.5 : 0);
  const rules: { id: string; label: string; f: (i: number) => number }[] = [
    { id: "R0", label: "현행 v4 (기준선)", f: R0 },
    { id: "N1", label: "①바닥권 & 니슨 long → 최소 50%", f: (i) => Math.max(R0(i), bottom(i) && L("nison", i) ? 0.5 : 0) },
    { id: "N2", label: "①바닥권 & 니슨 long → 최소 75%", f: (i) => Math.max(R0(i), bottom(i) && L("nison", i) ? 0.75 : 0) },
    { id: "N3", label: "①역배열 & 니슨 long → 최소 50%", f: (i) => Math.max(R0(i), rev(i) && L("nison", i) ? 0.5 : 0) },
    { id: "C1", label: "②니슨 뜬 뒤 5일내 와일더 확인 → 50%", f: (i) => Math.max(R0(i), seq("nison", "wilder", i) ? 0.5 : 0) },
    { id: "C2", label: "②니슨→와일더 확인 → 75%", f: (i) => Math.max(R0(i), seq("nison", "wilder", i) ? 0.75 : 0) },
    { id: "C3", label: "②와일더 뜬 뒤 5일내 니슨 확인 → 50%", f: (i) => Math.max(R0(i), seq("wilder", "nison", i) ? 0.5 : 0) },
    { id: "C4", label: "②니슨&와일더 동시 long → 75% (1차판)", f: (i) => Math.max(R0(i), L("nison", i) && L("wilder", i) ? 0.75 : 0) },
    { id: "BH", label: "(참고) 항상 100%", f: () => 1 },
  ];

  const N = c.length - 1;
  const segs: [string, number][] = [["전체", N - WARMUP], ["최근 3년", 744], ["최근 1년", 248], ["2개월(42)", 42], ["1개월(21)", 21], ["20거래일", 20], ["7거래일", 7]];
  console.log(`\n════ ${name} (${bars.length}일 · 마지막 ${bars[N].date}) ════`);
  console.log(`  규칙                                   ${segs.map(s => s[0].padStart(16)).join("")}`);
  const base: Record<string, number> = {};
  for (const r of rules) {
    const cells = segs.map(([lab, n]) => {
      const from = Math.max(WARMUP, N - n);
      const res = sim(bars, from, N, r.f);
      // 발동일수 = 기준선보다 비중이 높았던 날
      let fired = 0;
      for (let i = from; i < N; i++) if (r.f(i) > R0(i) + 1e-9) fired++;
      if (r.id === "R0") base[lab] = res.cum;
      const d = r.id === "R0" || r.id === "BH" ? "" : res.cum > base[lab] + 0.05 ? "▲" : res.cum < base[lab] - 0.05 ? "▼" : "=";
      return `${(Math.abs(res.cum) >= 100 ? f0(res.cum) : f1(res.cum))}%${d}/발${fired}`.padStart(16);
    });
    console.log(`  ${r.label.padEnd(38)}${cells.join("")}`);
  }
}

async function main() {
  await run("005930", "삼성전자");
  await run("000660", "SK하이닉스");
  console.log(`\n  범례: 누적수익%(▲개선/▼훼손/=동일, 기준선 대비) / 발N = 그 구간에서 규칙이 기준선보다 비중을 올린 날 수.`);
  console.log(`  ⚠ 7~42일 구간은 표본이 아니다 — 발동일수가 0이면 수치가 같은 게 당연하고, 몇 일 발동한 차이는 우연 범위.`);
}
main();
