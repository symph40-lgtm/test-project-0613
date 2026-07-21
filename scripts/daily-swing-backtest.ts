// 일봉 스윙 예측 — 대가 7모델 백테스트. 기획: docs/predict-daily-spec.md 3~5장.
//   npx tsx scripts/daily-swing-backtest.ts                  # 005930 + 000660, 2600봉
//   npx tsx scripts/daily-swing-backtest.ts --symbol 000660  # 단일 종목
//   npx tsx scripts/daily-swing-backtest.ts --days 1300      # 봉 수 지정
//
// 미래 정보 차단: t일 스탠스는 t일 종가까지의 일봉만 입력. 채점은 t→t+1/3/5 종가와 t+1 시가 갭.
// 모델 정의는 daily-swing-models.ts (전략 시뮬 daily-swing-strategy.ts와 공용).

import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, type Stance } from "./daily-swing-models";

const args = process.argv.slice(2);
function argOf(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const DAYS = parseInt(argOf("--days") ?? "2600", 10);
const SYMBOLS = argOf("--symbol") ? [argOf("--symbol")!] : ["005930", "000660"];
const WARMUP = 260; // 52주 지표 웜업

// ── 채점 ─────────────────────────────────────────────────────────────
type Score = {
  days: number; long: number; short: number;
  acc1: [number, number]; acc3: [number, number]; acc5: [number, number]; // [적중, 표본]
  gapAcc: [number, number];
  signedCum: number; longOnlyCum: number; // 스탠스 추종 r1 합 (%p)
};

function emptyScore(): Score {
  return { days: 0, long: 0, short: 0, acc1: [0, 0], acc3: [0, 0], acc5: [0, 0], gapAcc: [0, 0], signedCum: 0, longOnlyCum: 0 };
}

function pct(a: [number, number]): string {
  return a[1] > 0 ? `${((100 * a[0]) / a[1]).toFixed(1)}%` : "—";
}

async function main() {
  for (const sym of SYMBOLS) {
    const bars = await fetchDailyPredict(sym, DAYS);
    if (bars.length < WARMUP + 30) { console.log(`${sym}: 일봉 부족 (${bars.length})`); continue; }
    const n = bars.length;
    const stances = MODELS.map((m) => m.run(bars));
    const first = WARMUP, last = n - 6; // t+5까지 채점 가능 범위

    // 구간: 전체 / 최근 3년(750봉) / 최근 1년(250봉)
    const periods: { name: string; from: number }[] = [
      { name: `전체 (${bars[first].date}~)`, from: first },
      { name: "최근 3년", from: Math.max(first, last - 750) },
      { name: "최근 1년", from: Math.max(first, last - 250) },
    ];

    console.log(`\n${"═".repeat(100)}`);
    console.log(`■ ${sym} — 일봉 ${n}개 (${bars[0].date} ~ ${bars[n - 1].date}), 채점 ${bars[first].date} ~ ${bars[last].date}`);

    for (const period of periods) {
      // 기준선
      let up1 = 0, up3 = 0, up5 = 0, tot = 0, bh = 0;
      for (let i = period.from; i <= last; i++) {
        const r1 = bars[i + 1].close / bars[i].close - 1;
        const r3 = bars[i + 3].close / bars[i].close - 1;
        const r5 = bars[i + 5].close / bars[i].close - 1;
        if (r1 > 0) up1++; if (r3 > 0) up3++; if (r5 > 0) up5++;
        tot++; bh += r1 * 100;
      }
      console.log(`\n── ${period.name}: ${tot}일, 상승일 비율 r1 ${((100 * up1) / tot).toFixed(1)}% · r3 ${((100 * up3) / tot).toFixed(1)}% · r5 ${((100 * up5) / tot).toFixed(1)}%, Buy&Hold(r1합) ${bh >= 0 ? "+" : ""}${bh.toFixed(1)}%p`);
      console.log(`   모델                          판정일(L/S)      r1적중    r3적중(리프트)   r5적중    갭적중    롱온리누적  롱숏누적`);

      for (let m = 0; m < MODELS.length; m++) {
        const s = emptyScore();
        let base3Blend = 0; // 판정 방향 기준 우연 적중 기대 (long→P(r3>0), short→P(r3<0))
        for (let i = period.from; i <= last; i++) {
          const stance = stances[m][i];
          const r1 = bars[i + 1].close / bars[i].close - 1;
          if (stance === "long") s.longOnlyCum += r1 * 100;
          if (stance === "flat") continue;
          const r3 = bars[i + 3].close / bars[i].close - 1;
          const r5 = bars[i + 5].close / bars[i].close - 1;
          const gap = bars[i + 1].open / bars[i].close - 1;
          s.days++;
          if (stance === "long") s.long++; else s.short++;
          s.signedCum += (stance === "long" ? r1 : -r1) * 100;
          const want = stance === "long" ? 1 : -1;
          if (r1 !== 0) { s.acc1[1]++; if (Math.sign(r1) === want) s.acc1[0]++; }
          if (r3 !== 0) { s.acc3[1]++; if (Math.sign(r3) === want) s.acc3[0]++; }
          if (r5 !== 0) { s.acc5[1]++; if (Math.sign(r5) === want) s.acc5[0]++; }
          if (Math.abs(gap) >= 0.001) { s.gapAcc[1]++; if (Math.sign(gap) === want) s.gapAcc[0]++; }
          base3Blend += stance === "long" ? up3 / tot : 1 - up3 / tot;
        }
        const lift3 = s.acc3[1] > 0 ? (100 * s.acc3[0]) / s.acc3[1] - (100 * base3Blend) / s.days : 0;
        const name = MODELS[m].label.padEnd(24, " ");
        console.log(
          `   ${name} ${String(s.days).padStart(4)} (${s.long}/${s.short})`.padEnd(48) +
          ` ${pct(s.acc1).padStart(6)}   ${pct(s.acc3).padStart(6)} (${lift3 >= 0 ? "+" : ""}${lift3.toFixed(1)}%p)`.padEnd(22) +
          `  ${pct(s.acc5).padStart(6)}   ${pct(s.gapAcc).padStart(6)}   ${(s.longOnlyCum >= 0 ? "+" : "") + s.longOnlyCum.toFixed(1)}%p`.padEnd(12) +
          `  ${(s.signedCum >= 0 ? "+" : "") + s.signedCum.toFixed(1)}%p`
        );
      }
    }

    // ── 큰 변동일 조건부 채점 — "크게 움직인 날을 맞췄는가" (사용자 제안 2026-07)
    // 임계: |r3| 고정 3%·5% + 변동성 상대(판정일 기준 20일 일수익 σ × √3 × 1.5 — 종목·레짐별 변동성 자동 반영)
    const rets: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) rets[i] = bars[i].close / bars[i - 1].close - 1;
    const vol20: (number | null)[] = new Array(n).fill(null);
    for (let i = 21; i < n; i++) {
      const w = rets.slice(i - 19, i + 1);
      const mean = w.reduce((a, b) => a + b, 0) / w.length;
      vol20[i] = Math.sqrt(w.reduce((s, v) => s + (v - mean) * (v - mean), 0) / w.length);
    }
    const mar26 = bars.findIndex((b) => b.date >= "2026-03-01");
    const bigPeriods: { name: string; from: number }[] = [
      { name: "전체", from: first },
      { name: "최근 1년", from: Math.max(first, last - 250) },
      ...(mar26 >= 0 && mar26 <= last - 20 ? [{ name: "2026-03 이후", from: Math.max(first, mar26) }] : []),
    ];
    type Cond = { name: string; test: (i: number, r3: number) => boolean };
    const conds: Cond[] = [
      { name: "|r3|≥3%", test: (_i, r3) => Math.abs(r3) >= 0.03 },
      { name: "|r3|≥5%", test: (_i, r3) => Math.abs(r3) >= 0.05 },
      { name: "상대 1.5σ√3", test: (i, r3) => vol20[i] !== null && Math.abs(r3) >= 1.5 * vol20[i]! * Math.sqrt(3) },
    ];

    for (const period of bigPeriods) {
      const heads: string[] = [];
      for (const cond of conds) {
        let qual = 0, qualUp = 0;
        for (let i = period.from; i <= last; i++) {
          const r3 = bars[i + 3].close / bars[i].close - 1;
          if (r3 !== 0 && cond.test(i, r3)) { qual++; if (r3 > 0) qualUp++; }
        }
        heads.push(`${cond.name}: 해당 ${qual}일(${((100 * qual) / (last - period.from + 1)).toFixed(0)}%), 상승 ${qual > 0 ? ((100 * qualUp) / qual).toFixed(0) : "—"}%`);
      }
      console.log(`\n── 큰 변동일 r3 채점 [${period.name}] — ${heads.join(" · ")}`);
      console.log(`   모델                          ${conds.map((c) => c.name.padEnd(22)).join("")}`);
      for (let m = 0; m < MODELS.length; m++) {
        const cells: string[] = [];
        for (const cond of conds) {
          let hit = 0, tot2 = 0, baseBlend = 0;
          let condUp = 0, condN = 0;
          for (let i = period.from; i <= last; i++) {
            const r3 = bars[i + 3].close / bars[i].close - 1;
            if (r3 === 0 || !cond.test(i, r3)) continue;
            condN++; if (r3 > 0) condUp++;
          }
          for (let i = period.from; i <= last; i++) {
            const stance = stances[m][i];
            if (stance === "flat") continue;
            const r3 = bars[i + 3].close / bars[i].close - 1;
            if (r3 === 0 || !cond.test(i, r3)) continue;
            tot2++;
            const want = stance === "long" ? 1 : -1;
            if (Math.sign(r3) === want) hit++;
            baseBlend += stance === "long" ? condUp / condN : 1 - condUp / condN;
          }
          const acc = tot2 > 0 ? (100 * hit) / tot2 : NaN;
          const lift = tot2 > 0 ? acc - (100 * baseBlend) / tot2 : NaN;
          cells.push(tot2 > 0 ? `${acc.toFixed(0)}% (${lift >= 0 ? "+" : ""}${lift.toFixed(1)}p, ${tot2})`.padEnd(22) : "—".padEnd(22));
        }
        console.log(`   ${MODELS[m].label.padEnd(24)} ${cells.join("")}`);
      }

      // 급변일 전일 스탠스 — 익일 |r1| ≥ 2σ: 급락일에 long이면 피격, flat이면 회피, short면 수익
      let dnN = 0, upN = 0;
      const dist: { dn: Record<Stance, number>; up: Record<Stance, number> }[] = MODELS.map(() => ({ dn: { long: 0, short: 0, flat: 0 }, up: { long: 0, short: 0, flat: 0 } }));
      for (let i = period.from; i <= last; i++) {
        if (vol20[i] === null) continue;
        const r1 = bars[i + 1].close / bars[i].close - 1;
        const big = Math.abs(r1) >= 2 * vol20[i]!;
        if (!big) continue;
        if (r1 < 0) { dnN++; for (let m = 0; m < MODELS.length; m++) dist[m].dn[stances[m][i]]++; }
        else { upN++; for (let m = 0; m < MODELS.length; m++) dist[m].up[stances[m][i]]++; }
      }
      console.log(`   ▸ 급변일(익일 |r1|≥2σ) 전일 스탠스 — 급락 ${dnN}일 · 급등 ${upN}일  [급락: 매도수익/중립회피/매수피격 | 급등: 매수포착/중립/매도역행]`);
      for (let m = 0; m < MODELS.length; m++) {
        const d = dist[m];
        const f = (x: number, tot2: number) => (tot2 > 0 ? `${((100 * x) / tot2).toFixed(0)}%` : "—");
        console.log(`     ${MODELS[m].label.padEnd(24)} 급락: ${f(d.dn.short, dnN)}/${f(d.dn.flat, dnN)}/${f(d.dn.long, dnN)}  |  급등: ${f(d.up.long, upN)}/${f(d.up.flat, upN)}/${f(d.up.short, upN)}`);
      }
    }

    // ── 급락 후 대응 — "첫날은 놓쳐도 다음날·다다음날은 맞추는가" (사용자 질문 2026-07)
    // 급락일 t: 당일 수익 ≤ -2σ (σ는 전일 기준 — 급락 자체로 σ가 부풀지 않게). 채점:
    //   당일 종가 판정 stance[t] → r1(t→t+1)·r3(t→t+3), 익일 종가 판정 stance[t+1] → r3(t+1→t+4)
    for (const period of [{ name: "전체", from: first }, { name: "최근 3년", from: Math.max(first, last - 750) }]) {
      const crashes: number[] = [];
      for (let i = Math.max(period.from, 23); i <= last - 1; i++) {
        if (vol20[i - 1] !== null && rets[i] <= -2 * vol20[i - 1]!) crashes.push(i);
      }
      if (crashes.length === 0) continue;
      let reb1 = 0, reb3 = 0, tailN = 0, tailReb = 0, noTailN = 0, noTailReb = 0;
      for (const t of crashes) {
        const r1n = bars[t + 1].close / bars[t].close - 1;
        const r3n = bars[t + 3].close / bars[t].close - 1;
        if (r1n > 0) reb1++;
        if (r3n > 0) reb3++;
        const b = bars[t], range = b.high - b.low;
        const lowW = range > 0 ? (Math.min(b.open, b.close) - b.low) / range : 0;
        if (lowW >= 0.35) { tailN++; if (r3n > 0) tailReb++; } // 아랫꼬리가 레인지 35%+ = 하단 매수 방어 흔적
        else { noTailN++; if (r3n > 0) noTailReb++; }
      }
      const fp = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : "—");
      console.log(`\n── 급락 후 대응 [${period.name}] — 급락일(≤-2σ) ${crashes.length}일 · 익일 반등 ${fp(reb1, crashes.length)} · 3일 후 상승 ${fp(reb3, crashes.length)}`);
      console.log(`   급락일 캔들 아랫꼬리(레인지 35%+) ${tailN}일 → 3일 상승 ${fp(tailReb, tailN)}  |  꼬리 미미 ${noTailN}일 → ${fp(noTailReb, noTailN)}`);
      console.log(`   모델                          당일종가 스탠스(S/F/L)   r1적중   r3적중   | 익일종가 스탠스(S/F/L)   r3적중`);
      for (let m = 0; m < MODELS.length; m++) {
        const c0: Record<Stance, number> = { long: 0, short: 0, flat: 0 };
        const c1: Record<Stance, number> = { long: 0, short: 0, flat: 0 };
        let h1 = 0, t1 = 0, h3 = 0, t3 = 0, h3b = 0, t3b = 0;
        for (const t of crashes) {
          const s0 = stances[m][t];
          c0[s0]++;
          if (s0 !== "flat") {
            const want = s0 === "long" ? 1 : -1;
            const r1n = bars[t + 1].close / bars[t].close - 1;
            const r3n = bars[t + 3].close / bars[t].close - 1;
            if (r1n !== 0) { t1++; if (Math.sign(r1n) === want) h1++; }
            if (r3n !== 0) { t3++; if (Math.sign(r3n) === want) h3++; }
          }
          if (t + 4 <= n - 1) {
            const s1 = stances[m][t + 1];
            c1[s1]++;
            if (s1 !== "flat") {
              const want = s1 === "long" ? 1 : -1;
              const r3n = bars[t + 4].close / bars[t + 1].close - 1;
              if (r3n !== 0) { t3b++; if (Math.sign(r3n) === want) h3b++; }
            }
          }
        }
        const N = crashes.length;
        console.log(
          `   ${MODELS[m].label.padEnd(24)} ${fp(c0.short, N)}/${fp(c0.flat, N)}/${fp(c0.long, N)}`.padEnd(52) +
          ` ${fp(h1, t1).padStart(5)}(${t1})  ${fp(h3, t3).padStart(5)}(${t3})  | ${fp(c1.short, N)}/${fp(c1.flat, N)}/${fp(c1.long, N)}`.padEnd(40) +
          `  ${fp(h3b, t3b).padStart(5)}(${t3b})`
        );
      }
    }

    // 오늘 스탠스
    console.log(`\n   ▸ 현재 스탠스 (${bars[n - 1].date} 종가 기준): ` + MODELS.map((m, j) => `${m.id}=${stances[j][n - 1]}`).join(", "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
