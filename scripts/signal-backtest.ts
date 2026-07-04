// 신호 엔진 6월 재현 검증 러너 — `npx tsx scripts/signal-backtest.ts`
// 엔진(lib/signal/engine)·backtest는 외부 의존성 없는 순수 함수라 DB·API 없이 실행된다.

import { runBacktest } from "../lib/signal/backtest";

const results = runBacktest();
for (const r of results) {
  console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`  기대: ${r.expected}`);
  console.log(`  실제: ${r.actual}`);
  console.log(`  상세: ${r.detail}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n총 ${results.length}건 중 ${results.length - failed}건 통과, ${failed}건 실패`);
process.exit(failed > 0 ? 1 : 0);
