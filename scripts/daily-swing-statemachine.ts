// 국면 상태기계 백테스트 (사용자 설계 2026-08-08: "횡보면 빠져 있다가 방향이 정해지면 들어가고,
// 확실해지면 더 들어간다 — 매일 판정할 필요도 없다"):
//   npx tsx scripts/daily-swing-statemachine.ts
// 상태: 횡보(0%) → 방향 확정(50%) → 확인 강화(100%) → 반대·횡보 복귀 시 0%.
// 매일 재판정하는 현행 v4와 달리 '상태가 바뀔 때만' 움직인다 — 거래·문자 빈도도 함께 잰다.
// 판별자 후보 4종을 같은 틀에서 비교: 돈치안 채널 / 수퍼트렌드 / ADX+DI / t-통계(스펙 5-8 변동장 최고).
// 비용·MDD 규약은 daily-swing-strategy.ts와 동일. 채택 기준: 2종목 × 3구간 무해+개선.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, sma, dmiAdx, supertrendUp, atr14, type Stance, type DailyBar } from "../lib/predict-daily/models";

const BUY_COST = 0.00015, SELL_COST = 0.00215, WARMUP = 260;
const f0 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;

function sim(bars: DailyBar[], from: number, to: number, expo: (i: number) => number) {
  let V = 1, peak = 1, mdd = 0, f = 0, expoSum = 0, days = 0, moves = 0;
  for (let i = from; i < to; i++) {
    const t = expo(i);
    if (Math.abs(t - f) > 1e-9) { const d = t - f; V *= 1 - (d > 0 ? d * BUY_COST : -d * SELL_COST); f = t; moves++; }
    expoSum += f; days++;
    V *= 1 + f * (bars[i + 1].close / bars[i].close - 1);
    peak = Math.max(peak, V); mdd = Math.max(mdd, 1 - V / peak);
  }
  const yrs = days / 248;
  return { cum: (V - 1) * 100, cagr: yrs > 0.5 ? (Math.pow(V, 1 / yrs) - 1) * 100 : (V - 1) * 100, mdd: mdd * 100, expo: (100 * expoSum) / Math.max(1, days), moves };
}

async function run(sym: string, name: string) {
  const bars = await fetchDailyPredict(sym, 2600);
  const c = bars.map(b => b.close), hi = bars.map(b => b.high), lo = bars.map(b => b.low);
  const st: Record<string, Stance[]> = {};
  for (const m of MODELS) st[m.id] = m.run(bars);
  const L = (id: string, i: number) => st[id][i] === "long";
  const { plusDi, minusDi, adx } = dmiAdx(bars, 14);
  const stUp = supertrendUp(bars);
  const atr = atr14(bars);
  const ma20 = sma(c, 20);

  // ── 방향 판별자 (그날 종가까지만 사용) — +1 상승 / -1 하락 / 0 횡보
  const dcDir = (i: number) => {           // 돈치안 20일 채널 돌파 (터틀 원형)
    if (i < 21) return 0;
    const up = Math.max(...hi.slice(i - 20, i)), dn = Math.min(...lo.slice(i - 20, i));
    return c[i] > up ? 1 : c[i] < dn ? -1 : 0;
  };
  const dcState = (i: number) => {          // 돌파 후 상태 유지 (반대 돌파까지)
    let s = 0;
    for (let k = 21; k <= i; k++) { const d = dcDir(k); if (d !== 0) s = d; }
    return s;
  };
  const stDir = (i: number) => (i < 20 ? 0 : stUp[i] ? 1 : -1);          // 수퍼트렌드(10,3)
  const adxDir = (i: number) => {                                        // ADX>20 + DI 우위
    if (adx[i] == null || plusDi[i] == null || minusDi[i] == null) return 0;
    if (adx[i]! < 20) return 0;                                          // 추세 없음 = 횡보
    return plusDi[i]! > minusDi[i]! ? 1 : -1;
  };
  const tStat = (i: number) => {                                         // t-통계 3분류 (스펙 5-8)
    if (i < 40) return 0;
    const r: number[] = [];
    for (let k = i - 19; k <= i; k++) r.push(Math.log(c[k] / c[k - 1]));
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
    const t = sd > 0 ? (m / (sd / Math.sqrt(r.length))) : 0;
    return t > 1.0 ? 1 : t < -1.0 ? -1 : 0;                              // |t|<1 = 횡보(추세 없음)
  };

  // ── 상태기계: 방향 확정 50% → 확인 강화 100% (long-only, 하락·횡보는 현금)
  const machine = (dir: (i: number) => number, confirm: (i: number) => boolean) => (i: number) => {
    const d = dir(i);
    if (d !== 1) return 0;                 // 횡보·하락이면 현금
    return confirm(i) ? 1 : 0.5;
  };
  const R0 = (i: number) => (L("minervini", i) ? 1 : L("weinstein", i) ? 0.5 : 0);   // 현행 v4
  const P1 = (i: number) => (L("minervini", i) ? 1 : 0);

  const rules: { label: string; f: (i: number) => number }[] = [
    { label: "현행 v4 (매일 판정)", f: R0 },
    { label: "P1 이진 (매일 판정)", f: P1 },
    { label: "SM1 돈치안 → 미너비니 확인", f: machine(dcState, i => L("minervini", i)) },
    { label: "SM2 수퍼트렌드 → 미너비니 확인", f: machine(stDir, i => L("minervini", i)) },
    { label: "SM3 ADX+DI → 미너비니 확인", f: machine(adxDir, i => L("minervini", i)) },
    { label: "SM4 t통계 → 미너비니 확인", f: machine(tStat, i => L("minervini", i)) },
    { label: "SM5 돈치안 → 와일더 확인", f: machine(dcState, i => L("wilder", i)) },
    { label: "SM6 수퍼트렌드 → 와일더+와인 확인", f: machine(stDir, i => L("wilder", i) && L("weinstein", i)) },
    { label: "SM7 t통계 → 수퍼트렌드 확인", f: machine(tStat, i => stDir(i) === 1) },
    { label: "(참고) 항상 100%", f: () => 1 },
  ];

  const N = c.length - 1;
  const segs: [string, number][] = [["전체", N - WARMUP], ["최근 3년", 744], ["최근 1년", 248]];
  console.log(`\n════ ${name} ════`);
  console.log(`  ${"규칙".padEnd(30)}${segs.map(s => s[0].padStart(24)).join("")}   노출  전환횟수`);
  const base: Record<string, number> = {};
  for (const r of rules) {
    const cells = segs.map(([lb, n]) => {
      const res = sim(bars, Math.max(WARMUP, N - n), N, r.f);
      if (r.label.startsWith("현행")) base[lb] = res.cum;
      const d = r.label.startsWith("현행") || r.label.startsWith("(참고") ? "" : res.cum > base[lb] ? "▲" : "▼";
      return `${f0(res.cum)}%${d}/MDD${res.mdd.toFixed(0)}`.padStart(24);
    });
    const full = sim(bars, WARMUP, N, r.f);
    console.log(`  ${r.label.padEnd(30)}${cells.join("")}   ${full.expo.toFixed(0)}%   ${String(full.moves).padStart(4)}회`);
  }
}

async function main() {
  await run("005930", "삼성전자");
  await run("000660", "SK하이닉스");
  console.log(`\n  ▲/▼ = 현행 v4 대비. 전환횟수 = 비중이 바뀐 날 수(문자·거래 빈도의 대리지표).`);
  console.log(`  상태기계는 long-only — 하락 확정도 현금(0%)이다. 인버스 활용은 별도 설계 필요.`);
}
main();
