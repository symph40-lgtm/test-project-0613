// MT 스모크 — 엔진이 크래시 없이 돌고 값이 정의역 안인지 확인 (DB 미적용 상태에서도 실행 가능).
//   npx tsx scripts/mt-smoke.ts
// 보는 것: 확률 합 1 · fill 0~1 · MT ∈ [-1,1] · 결측 내성 · 카드 3줄 출력.

import { readFileSync } from "fs";
import { resolve } from "path";
try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* 없어도 시세 경로는 동작 (등급 B 재료만 결측) */ }

async function main() {
  const { loadMtUniverse } = await import("../lib/mt/service");
  const { computeMtDay } = await import("../lib/mt/engine");
  const { mtCardLines } = await import("../lib/mt/report");
  const { gradeMix, c1Series } = await import("../lib/mt/c1");
  const type = await import("../lib/mt/types");
  void type;

  const u = await loadMtUniverse(400);
  console.log(`일봉: 삼전 ${u.bars["005930"].length} · 하닉 ${u.bars["000660"].length} · K200 ${u.bars.KOSPI200.length} / SOX 매핑 ${u.soxByDate.size}일 · cause_text ${u.causeTextByDate.size}일`);

  const closeMap = (bars: { date: string; close: number }[]) => new Map(bars.map((b) => [b.date, b.close]));
  for (const symbol of ["005930", "000660", "KOSPI200"] as const) {
    const bars = u.bars[symbol];
    const i = bars.length - 1;
    const day = computeMtDay(symbol, bars, i, {
      c1: { soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate },
      indexCloseByDate: symbol === "KOSPI200" ? undefined : closeMap(u.bars.KOSPI200),
      leaderCloseByDate: symbol === "KOSPI200" ? [closeMap(u.bars["005930"]), closeMap(u.bars["000660"])] : undefined,
      breadth: null, flow: null, mode: "backfill",
    });
    const psum = Object.values(day.phase.P).reduce((a, b) => a + b, 0);
    const fills = Object.values(day.panels).flatMap((p) => p.parts.map((x) => x.fill)).filter((x): x is number => x != null);
    const bad = fills.filter((f) => f < 0 || f > 1).length;
    const l = mtCardLines(day);
    console.log(`\n[${symbol}] ${day.date} · 확률합 ${psum.toFixed(3)} · fill 범위이탈 ${bad} · MT ${day.tone.mt}`);
    console.log(" " + l.head);
    console.log(" " + l.panel);
    console.log(" " + l.tail);
    if (l.flags.length) console.log(" 플래그: " + l.flags.join(" / "));
    console.log(` 결측: ${day.meta.missing.join(", ") || "없음"}`);
    const mix = gradeMix(c1Series(bars, i, 60, symbol, { soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate }));
    console.log(` C1 등급 구성비(최근 60일): A ${mix.A}% · B ${mix.B}% · C ${mix.C}% · 미분류 ${mix.none}%`);
  }
}
main();
