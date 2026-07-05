// Stage 1 분석 러너 — `npx tsx scripts/signal-stage1.ts`
// 3개월 백필(일봉 프록시 라벨) 기준 "추세일의 선행 조건" 크로스탭을 출력한다.

import { runStage1 } from "../lib/signal/stage1";

async function main() {
const r = await runStage1();
console.log(`표본 ${r.totalDays}일 (실측 ${r.measured} · 프록시 ${r.proxied})`);
console.log(`기저율 — 상방추세일 ${(r.baseUp * 100).toFixed(0)}% · 하방추세일 ${(r.baseDown * 100).toFixed(0)}% · 비추세일 ${(r.baseRange * 100).toFixed(0)}%`);
console.log("\n— 선행 조건별 추세일 확률 (리프트 순, n≥5) —");
for (const row of r.rows) {
  console.log(
    `${row.feature.padEnd(24)} n=${String(row.n).padStart(3)} | 상방 ${(row.pUp * 100).toFixed(0).padStart(3)}% | 하방 ${(row.pDown * 100).toFixed(0).padStart(3)}% | 비추세 ${(row.pRange * 100).toFixed(0).padStart(3)}% | 추세일 리프트 ×${row.liftTrend.toFixed(2)}`,
  );
}
console.log("\n— 최근 20일 라벨 —");
for (const rec of r.records) {
  console.log(`${rec.date} ${rec.label} (${rec.labelSource}) 일중 ${rec.intradayPct !== null ? rec.intradayPct.toFixed(1) : "?"}%`);
}
for (const n of r.notes) console.log("\nⓘ " + n);
}
main();
