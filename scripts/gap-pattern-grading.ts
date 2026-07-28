// 갭 패턴 실측 (사용자 지시 2026-07-28 ①): ①갭 크기 버킷 → 당일 시가→종가 ("갭상승 욕심부리지
// 마라" 검증) ②전일 방향·크기 → 당일 갭 방향 규칙성 ③15:05 프레임(오늘 갭×당일 캔들) → 익일
// 수익 — 환경 점수판 채택 후보 평가 (통일 규칙: 보수적 익일 편차÷0.3%p·표본<30 감액·클램프 ±3)
// ④당일 등락 크기 → 익일 수익 + '종가 매수·-3% 스탑' 시뮬 (사용자 질문 2026-07-28 저녁 —
//   "많이 빠진 다음날은 상승하지 않을까").
//   npx tsx scripts/gap-pattern-grading.ts
// 채택 기준 (프로젝트 공통): 양 종목 + 전/후반 모두 같은 방향일 때만 점수 후보.

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";

const pct = (a: number, b: number) => ((a - b) / b) * 100;
const f2 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

type Cell = { n: number; sum: number; up: number; half: [number, number] }; // half = 전/후반 합
const mk = (): Cell => ({ n: 0, sum: 0, up: 0, half: [0, 0] });
const put = (c: Cell, r: number, isLate: boolean) => { c.n++; c.sum += r; if (r > 0) c.up++; c.half[isLate ? 1 : 0] += r; };
const show = (c: Cell) => c.n ? `${c.n}일 ${f2(c.sum / c.n)}%·상승${Math.round((100 * c.up) / c.n)}%·전/후반 ${f2(c.half[0])}/${f2(c.half[1])}` : "0일";

function bucketIdx(v: number, edges: number[]): number {
  const i = edges.findIndex((e) => v < e);
  return i < 0 ? edges.length : i;
}
const bucketLab = (b: number, edges: number[]) =>
  b === 0 ? `<${edges[0]}` : b === edges.length ? `≥${edges[edges.length - 1]}` : `${edges[b - 1]}~${edges[b]}`;

async function analyze(sym: string, name: string) {
  // OHLC 전부 양수인 봉만 (삼전 표본에 open=0 불량 일봉 1건 실측 — Infinity 오염 가드)
  const bars: PredictDailyBar[] = (await fetchDailyPredict(sym, 2600))
    .filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
  const n = bars.length;
  const mid = Math.floor(n / 2);
  console.log(`\n══════ ${name} (${sym}) — ${bars[1]?.date}~${bars[n - 1]?.date}, 표본 ${n - 2}일 ══════`);

  // ① 갭 크기 → 당일 시가→종가 (갭상승 추격 검증)
  const gapEdges = [-2, -1, -0.3, 0.3, 1, 2];
  const oc = Array.from({ length: gapEdges.length + 1 }, mk);
  const cc = Array.from({ length: gapEdges.length + 1 }, mk); // 갭 포함 당일 전체
  // ② 전일 등락 → 당일 갭
  const prevEdges = [-2, -0.5, 0, 0.5, 2];
  const pg = Array.from({ length: prevEdges.length + 1 }, mk);
  // ③ 15:05 프레임: 오늘 (갭, 시가→종가) 조합 → 익일 종가수익
  const combos: Record<string, Cell> = {
    "갭상승≥0.5 & 되밀림(음봉)": mk(), "갭상승≥0.5 & 유지(양봉)": mk(),
    "갭하락≤-0.5 & 반등(양봉)": mk(), "갭하락≤-0.5 & 추가하락(음봉)": mk(),
    "갭중립(±0.5) 전체": mk(),
  };
  // ③b 오늘 갭 크기 → 익일 갭 (갭 연속성)
  const nextGap = Array.from({ length: gapEdges.length + 1 }, mk);
  // ④ 당일 등락 크기 → 익일 + 종가매수 -3%스탑 시뮬
  const dayEdges = [-7, -5, -3, -2, 0, 2, 3, 5];
  const nx = Array.from({ length: dayEdges.length + 1 }, mk);
  const st = Array.from({ length: dayEdges.length + 1 }, mk); // 스탑 시뮬 수익

  for (let i = 1; i < n; i++) {
    const late = i >= mid;
    const gap = pct(bars[i].open, bars[i - 1].close);
    const ocR = pct(bars[i].close, bars[i].open);
    const ccR = pct(bars[i].close, bars[i - 1].close);
    const gb = bucketIdx(gap, gapEdges);
    put(oc[gb], ocR, late); put(cc[gb], ccR, late);
    const prev = i >= 2 ? pct(bars[i - 1].close, bars[i - 2].close) : null;
    if (prev !== null) put(pg[bucketIdx(prev, prevEdges)], gap, late);
    if (i < n - 1) {
      const nr = pct(bars[i + 1].close, bars[i].close);
      const ng = pct(bars[i + 1].open, bars[i].close);
      put(nextGap[gb], ng, late);
      const key = gap >= 0.5 ? (ocR < 0 ? "갭상승≥0.5 & 되밀림(음봉)" : "갭상승≥0.5 & 유지(양봉)")
        : gap <= -0.5 ? (ocR > 0 ? "갭하락≤-0.5 & 반등(양봉)" : "갭하락≤-0.5 & 추가하락(음봉)")
        : "갭중립(±0.5) 전체";
      put(combos[key], nr, late);
      const db = bucketIdx(ccR, dayEdges);
      put(nx[db], nr, late);
      // 종가매수·-3%스탑·익일종가청산: 익일 시가가 스탑 아래면 시가 체결(갭 리스크), 장중 저가 터치면 -3%, 아니면 익일 종가
      const stopPx = bars[i].close * 0.97;
      const simR = bars[i + 1].open <= stopPx ? pct(bars[i + 1].open, bars[i].close)
        : bars[i + 1].low <= stopPx ? -3
        : nr;
      put(st[db], simR, late);
    }
  }

  console.log(`\n① 당일 갭 크기(%) → 당일 시가→종가 [욕심 검증]`);
  for (let b = 0; b <= gapEdges.length; b++)
    console.log(`  갭 ${bucketLab(b, gapEdges).padEnd(9)} 시→종 ${show(oc[b])}  | 종→종 ${cc[b].n ? f2(cc[b].sum / cc[b].n) + "%" : "—"}`);

  console.log(`\n② 전일 등락(%) → 당일 갭 [갭 방향 규칙성]`);
  for (let b = 0; b <= prevEdges.length; b++)
    console.log(`  전일 ${bucketLab(b, prevEdges).padEnd(9)} 갭 ${show(pg[b])} (상승=갭업 비율)`);

  console.log(`\n③ 오늘 갭 크기 → 익일 갭 [연속성]`);
  for (let b = 0; b <= gapEdges.length; b++)
    console.log(`  갭 ${bucketLab(b, gapEdges).padEnd(9)} 익일갭 ${show(nextGap[b])}`);

  console.log(`\n③b 15:05 프레임: 오늘 갭×캔들 → 익일 종가수익 [점수 후보]`);
  for (const [k, c] of Object.entries(combos)) console.log(`  ${k.padEnd(24)} 익일 ${show(c)}`);

  console.log(`\n④ 당일 등락(%) → 익일 종가수익 | 종가매수·-3%스탑 시뮬 [급락 반등 검증]`);
  for (let b = 0; b <= dayEdges.length; b++)
    console.log(`  당일 ${bucketLab(b, dayEdges).padEnd(9)} 익일 ${show(nx[b])}  | 스탑시뮬 ${st[b].n ? f2(st[b].sum / st[b].n) + "%·상승" + Math.round((100 * st[b].up) / st[b].n) + "%" : "—"}`);

  const all = mk();
  for (let i = 1; i < n - 1; i++) put(all, pct(bars[i + 1].close, bars[i].close), i >= mid);
  console.log(`\n  기준선(전체 익일 평균): ${f2(all.sum / all.n)}% · 상승 ${Math.round((100 * all.up) / all.n)}%`);
}

async function main() {
  await analyze("005930", "삼전");
  await analyze("000660", "하닉");
  console.log(`\n주: 점수 후보 = 익일 편차(기준선 대비) ÷ 0.3%p 반올림, 표본<30일 1점 감액, 클램프 ±3.`);
  console.log(`   채택은 양 종목 + 전/후반 동방향일 때만 (프로젝트 공통 기준).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
