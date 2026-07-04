// 신호 엔진 6월 재현 검증 러너 — `npx tsx scripts/signal-backtest.ts`
// 엔진(lib/signal/engine)·backtest는 외부 의존성 없는 순수 함수라 DB·API 없이 실행된다.

import { runBacktest } from "../lib/signal/backtest";

const results = runBacktest();
for (const r of results) {
  console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`  기대: ${r.expected}`);
  console.log(`  실제: ${r.actual}`);
  console.log(`  상세: ${r.detail}`);
  if (r.smsPreview) console.log(`  📱 SMS: ${r.smsPreview.replace(/\n/g, " / ")}`);
}
let failed = results.filter((r) => !r.pass).length;

// 문자 알림 검증 — 발송돼야 하는 사례 / 발송되면 안 되는 사례
const smsExpect: Record<string, boolean> = {
  "6/12": true,          // 추세일 하방 → 인버스 검토 문자
  "6/23": true,          // 추세일 하방 → 인버스 검토 문자
  "7/3": true,           // V반등 강한신호 → 레버리지 검토 문자
  "6/17": true,          // 추세일 상방 → 레버리지 검토 문자
  "횡보일": true,        // 매매 금지 문자
  "장중형성": true,      // 지연 추세 → 레버리지 검토 문자
  "6/9 (a) 시초": false, // X1·XS1 차단 + 반전 대기 — 문자 없어야 함
};
console.log("\n── SMS 발송 판정 검증");
for (const [name, want] of Object.entries(smsExpect)) {
  const r = results.find((x) => x.name === name);
  if (!r) continue;
  const got = r.smsPreview !== null;
  const ok = got === want;
  if (!ok) failed++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} — 발송 ${want ? "필요" : "금지"} / 실제 ${got ? "발송" : "미발송"}`);
}

console.log(`\n총 실패 ${failed}건`);
process.exit(failed > 0 ? 1 : 0);
