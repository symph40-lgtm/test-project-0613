// 반등 재진입 가속 규칙 백테스트 (사용자 승인 2026-08-08 "바닥 선별은 포기하고 확인 속도를 높이는 쪽"):
//   npx tsx scripts/daily-swing-reentry.ts
// 현행 사다리 v4(미너비니 long 100% / 와인스타인 생존 50% / 붕괴 0%)에, 바닥권 실측에서 반등을 빨리
// 잡았던 모델(니슨 8~28일·와일더 12~18일·돈치안 13~15일 vs 미너비니 30일+)을 '조기 재진입 트리거'로
// 얹어 비교한다. 판정자 교체가 아니라 완충 구간의 비중 상향이다.
// 비용·복리·MDD는 daily-swing-strategy.ts와 같은 규약(매수 0.015%·매도 0.215%), 손절 오버레이 없음
// (v4 확정 운영안 = 손절은 권고 문자, 강제청산 시뮬은 삼전 유해로 기각됨).
// 채택 기준(스펙 7장): 2종목 × 3구간 전부 무해 + 개선.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, type Stance, type DailyBar } from "../lib/predict-daily/models";

const BUY_COST = 0.00015, SELL_COST = 0.00215;
const WARMUP = 260;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;

type Res = { cum: number; cagr: number; mdd: number; expo: number; turns: number };
function sim(bars: DailyBar[], from: number, to: number, expo: (i: number) => number): Res {
  let V = 1, peak = 1, mdd = 0, f = 0, expoSum = 0, days = 0, turns = 0;
  for (let i = from; i < to; i++) {
    const t = expo(i);
    if (t !== f) { const d = t - f; V *= 1 - (d > 0 ? d * BUY_COST : -d * SELL_COST); turns++; f = t; }
    expoSum += f; days++;
    V *= 1 + f * (bars[i + 1].close / bars[i].close - 1);
    peak = Math.max(peak, V); mdd = Math.max(mdd, 1 - V / peak);
  }
  const yrs = days / 248;
  return { cum: (V - 1) * 100, cagr: yrs > 0.5 ? (Math.pow(V, 1 / yrs) - 1) * 100 : (V - 1) * 100, mdd: mdd * 100, expo: (100 * expoSum) / Math.max(1, days), turns };
}

// 사후 바닥(반등 케이스) — 재진입 속도 측정용 기준점
function rebounds(c: number[]): number[] {
  const out: number[] = []; let last = -999;
  for (let i = 60; i < c.length - 20; i++) {
    const hi60 = Math.max(...c.slice(i - 60, i + 1));
    if (((c[i] - hi60) / hi60) * 100 > -12) continue;
    if (((c[i] - c[i - 20]) / c[i - 20]) * 100 > -8) continue;
    const lo = Math.min(...c.slice(Math.max(0, i - 20), i + 21));
    if (c[i] > lo * 1.005 || i - last < 20) continue;
    last = i;
    if (((c[i + 20] - c[i]) / c[i]) * 100 >= 8) out.push(i);
  }
  return out;
}

async function run(sym: string, name: string) {
  const bars = await fetchDailyPredict(sym, 2600);
  const c = bars.map(b => b.close);
  const st: Record<string, Stance[]> = {};
  for (const m of MODELS) st[m.id] = m.run(bars);
  const L = (id: string, i: number) => st[id][i] === "long";

  // 현행 v4
  const R0 = (i: number) => (L("minervini", i) ? 1 : L("weinstein", i) ? 0.5 : 0);
  const rules: { id: string; label: string; f: (i: number) => number }[] = [
    { id: "R0", label: "현행 v4 (미너 100 / 와인 50 / 붕괴 0)", f: R0 },
    { id: "R1", label: "+와일더 long이면 최소 50%", f: (i) => Math.max(R0(i), L("wilder", i) ? 0.5 : 0) },
    { id: "R2", label: "+니슨 long이면 최소 50%", f: (i) => Math.max(R0(i), L("nison", i) ? 0.5 : 0) },
    { id: "R3", label: "+돈치안 long이면 최소 50%", f: (i) => Math.max(R0(i), L("donchian", i) ? 0.5 : 0) },
    { id: "R4", label: "+니슨&와일더 동시 long이면 75%", f: (i) => Math.max(R0(i), L("nison", i) && L("wilder", i) ? 0.75 : 0) },
    { id: "R5", label: "+니슨 or 와일더 long이면 50%", f: (i) => Math.max(R0(i), L("nison", i) || L("wilder", i) ? 0.5 : 0) },
    { id: "R6", label: "+와일더&돈치안 동시 long이면 75%", f: (i) => Math.max(R0(i), L("wilder", i) && L("donchian", i) ? 0.75 : 0) },
    { id: "BH", label: "(참고) 항상 100% 보유", f: () => 1 },
  ];

  const segs: [string, number, number][] = [
    ["전체", WARMUP, c.length - 1],
    ["최근 3년", Math.max(WARMUP, c.length - 1 - 744), c.length - 1],
    ["최근 1년", Math.max(WARMUP, c.length - 1 - 248), c.length - 1],
  ];
  const reb = rebounds(c).filter(i => i >= WARMUP);
  console.log(`\n════ ${name} (${bars.length}일 · 반등 국면 ${reb.length}건) ════`);
  console.log(`  ${"규칙".padEnd(34)} ${segs.map(s => s[0].padStart(22)).join("")}   평균노출  반등재진입(중앙)`);
  const base: Record<string, Res> = {};
  for (const r of rules) {
    const cells = segs.map(([, a, b]) => sim(bars, a, b, r.f));
    if (r.id === "R0") segs.forEach((s, k) => (base[s[0]] = cells[k]));
    // 반등 국면에서 비중 50% 이상 도달까지 걸린 거래일 (중앙값)
    const lags = reb.map(i => {
      for (let k = i; k <= Math.min(c.length - 2, i + 30); k++) if (r.f(k) >= 0.5) return k - i;
      return 30;
    }).sort((a, b) => a - b);
    const med = lags.length ? lags[Math.floor(lags.length / 2)] : 0;
    const txt = cells.map((x, k) => {
      const d = r.id === "R0" ? "" : `${x.cum - base[segs[k][0]].cum >= 0 ? "▲" : "▼"}`;
      return `${s1(x.cum)}%/MDD${x.mdd.toFixed(0)}${d}`.padStart(22);
    }).join("");
    console.log(`  ${r.label.padEnd(34)} ${txt}   ${cells[0].expo.toFixed(0)}%      ${String(med).padStart(2)}일`);
  }
}

async function main() {
  await run("005930", "삼성전자");
  await run("000660", "SK하이닉스");
  console.log(`\n▲/▼ = 현행 v4 대비 누적수익 개선/훼손. 채택 기준은 2종목×3구간 전부 무해+개선.`);
}
main();
