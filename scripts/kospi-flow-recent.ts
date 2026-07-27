// 코스피 외인 현물 × 삼전·하닉 — 최근 창(30/60/90/180일) 연관 실측 (사용자 가설 2026-07-27:
// "3일 연속 순매수면 내일도 순매수 가능성↑ → 내일 주가 상승 가능성↑, 최근엔 연관이 높다"):
//   ① 동시 상관: 당일 수급 × 당일 수익 (설명력 — 이건 원래 높음 0.40)
//   ② 예측 상관: 어제까지 3일 누적 수급 × 오늘 수익 (이게 있어야 전일 포지셔닝이 돈이 됨)
//   ③ 3일 연속 매수/매도 상태 → 익일 수익 (창별)
//   ④ 롤링 60일 동시·예측 상관 추이 (최근 강화 여부)
//   npx tsx scripts/kospi-flow-recent.ts   (.predict-cache/kospiflow.json — 무통신)

import { readFileSync } from "fs";
import { resolve } from "path";
import { fetchDailyPredict } from "../lib/predict/data";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const raw = JSON.parse(readFileSync(resolve(process.cwd(), ".predict-cache", "kospiflow.json"), "utf8")) as { date: string; v?: number; frgn?: number }[];
const flow = raw.map((x) => ({ date: x.date, v: x.v ?? x.frgn ?? 0 })).filter((x) => x.v !== 0);
const fmap = new Map(flow.map((x) => [x.date, x.v]));
const fIdx = new Map(flow.map((x, i) => [x.date, i]));

const pearson = (x: number[], y: number[]): number => {
  const n = Math.min(x.length, y.length);
  if (n < 5) return NaN;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return c / Math.sqrt(vx * vy);
};

async function main() {
  for (const [code, name] of [["005930", "삼전"], ["000660", "하닉"]] as const) {
    const bars = await fetchDailyPredict(code, 600);
    // 정렬: 날짜별 (당일 수급, 당일 수익, 전일까지 3일 누적, 3일 연속 상태, 익일 수익)
    type Row = { date: string; f: number; r: number; cum3prev: number | null; streak3: "buy" | "sell" | null; rNext: number | null };
    const rows: Row[] = [];
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i].date;
      const f = fmap.get(d);
      const fi = fIdx.get(d);
      if (f === undefined || fi === undefined) continue;
      const r = (bars[i].close / bars[i - 1].close - 1) * 100;
      const rNext = i + 1 < bars.length ? (bars[i + 1].close / bars[i].close - 1) * 100 : null;
      const prev3 = fi >= 3 ? [flow[fi - 3].v, flow[fi - 2].v, flow[fi - 1].v] : null;
      rows.push({
        date: d, f, r, rNext,
        cum3prev: prev3 ? prev3[0] + prev3[1] + prev3[2] : null,
        streak3: prev3 ? (prev3.every((x) => x > 0) ? "buy" : prev3.every((x) => x < 0) ? "sell" : null) : null,
      });
    }
    console.log(`\n═ ${name} (정렬 표본 ${rows.length}일, ~${rows[rows.length - 1]?.date})`);
    for (const N of [30, 60, 90, 180, rows.length]) {
      const w = rows.slice(-N);
      const sim = pearson(w.map((x) => x.f), w.map((x) => x.r));
      const wp = w.filter((x) => x.cum3prev !== null);
      const pred = pearson(wp.map((x) => x.cum3prev!), wp.map((x) => x.r));
      const st = (s: "buy" | "sell") => {
        const g = w.filter((x) => x.streak3 === s);
        if (g.length < 3) return `${s === "buy" ? "3일매수후" : "3일매도후"} 표본${g.length}`;
        const avg = g.reduce((a, x) => a + x.r, 0) / g.length;
        const up = g.filter((x) => x.r > 0).length;
        return `${s === "buy" ? "3일매수후" : "3일매도후"} ${g.length}일 ${(avg >= 0 ? "+" : "") + avg.toFixed(2)}%·상승${Math.round((100 * up) / g.length)}%`;
      };
      console.log(`  [최근 ${N === rows.length ? "전체 " + N : N}일] 동시 r=${sim.toFixed(2)} · 예측(전3일누적→당일) r=${isNaN(pred) ? "—" : pred.toFixed(2)} · ${st("buy")} | ${st("sell")}`);
    }
    // 롤링 60일 동시·예측 상관 추이 (6개 구간)
    const roll: string[] = [];
    for (let e = rows.length; e >= 120 && roll.length < 6; e -= 60) {
      const w = rows.slice(e - 60, e);
      const sim = pearson(w.map((x) => x.f), w.map((x) => x.r));
      const wp = w.filter((x) => x.cum3prev !== null);
      const pred = pearson(wp.map((x) => x.cum3prev!), wp.map((x) => x.r));
      roll.unshift(`${w[0].date.slice(5)}~: 동시 ${sim.toFixed(2)}/예측 ${isNaN(pred) ? "—" : pred.toFixed(2)}`);
    }
    console.log(`  롤링 60일: ${roll.join(" | ")}`);
  }
  console.log(`\n주: 동시 = 당일 수급×당일 수익(설명력 — 매매엔 못 씀). 예측 = 어제까지 3일 누적×오늘 수익(전일 포지셔닝 가치).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
