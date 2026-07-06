// 신호 엔진 6월 재현 검증 러너 — `npx tsx scripts/signal-backtest.ts`
// 엔진(lib/signal/engine)·backtest는 외부 의존성 없는 순수 함수라 DB·API 없이 실행된다.

import { runBacktest } from "../lib/signal/backtest";
import { buildMoveAlerts } from "../lib/signal/alerts";
import type { IntradayTick } from "../lib/signal/types";

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
  "페이드형(가상)": true, // 추세일 하방 → 인버스 검토 문자
  "6/12 실측": false,     // 방향 미형성 — 미진입, 문자 없어야 함 (특이도)
  "6/23": true,          // 추세일 하방 → 인버스 검토 문자
  "7/3 실측": true,      // V반등 본진입 → 레버리지 검토 문자
  "7/3 조기": true,      // 조기 반전 → 1/3 선진입 문자
  "6/17": true,          // 추세일 상방 → 레버리지 검토 문자
  "횡보일": true,        // 매매 금지 문자
  "장중형성": true,      // 지연 추세 → 레버리지 검토 문자
  "6/9 (a) 시초": false, // X1·XS1 차단 + 반전 대기 — 문자 없어야 함
  "6/25": false,         // XS1 차단 + 롱도 X1 확인 전 — 문자 없어야 함 (시초 시점)
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

// 장중 급변 알림 검증 — 단계 돌파·미돌파·장외 시간
console.log("\n── 급변 알림 검증");
const mkTick = (over: Partial<IntradayTick>): IntradayTick => ({
  ts: "", minuteOfDay: 650, futPx: null, futChg: null, k200Px: null,
  hynixPx: null, hynixChg: null, samsungPx: null, samsungChg: null,
  hynixFrgn: null, samsungFrgn: null, hynixInst: null, samsungInst: null,
  nikkeiChg: null, twiiChg: null, nqChg: null, breadth: null, basis: null, ...over,
});
const moveCases: { name: string; ticks: IntradayTick[]; expectKeys: string[] }[] = [
  { name: "하닉 -5.2% (급락 2단계)", ticks: [mkTick({ hynixChg: -5.2 })], expectKeys: ["move_hynix_d5"] },
  { name: "하닉 +3.4% 급등 + 선물 -1.8%", ticks: [mkTick({ hynixChg: 3.4, futChg: -1.8 })], expectKeys: ["move_hynix_u3", "move_fut_d1.5"] },
  { name: "선물 -2.3% (1.5단계)", ticks: [mkTick({ futChg: -2.3 })], expectKeys: ["move_fut_d1.5"] },
  { name: "선물 -0.8% (첫 감지선 0.7)", ticks: [mkTick({ hynixChg: -2.9, futChg: -0.8 })], expectKeys: ["move_fut_d0.7"] },
  { name: "미돌파 (하닉 -2.9% · 선물 -0.5%)", ticks: [mkTick({ hynixChg: -2.9, futChg: -0.5 })], expectKeys: [] },
  { name: "장외 시간 (16:30)", ticks: [mkTick({ hynixChg: -8, minuteOfDay: 990 })], expectKeys: [] },
  // 반전 스윙 (2026-07-06 사용자 요청 — 고점 대비 반락 / 저점 대비 반등)
  {
    name: "선물 반락 +1.5%→-1.1% (고점 대비 -2.6%p)",
    ticks: [mkTick({ futChg: 0.2 }), mkTick({ futChg: 1.5 }), mkTick({ futChg: 0.4 }), mkTick({ futChg: -1.1 })],
    expectKeys: ["move_fut_d0.7", "swing_fut_d2"],
  },
  {
    name: "선물 반락 조기 경고 +1.5%→+0.4% (고점 대비 -1.1%p, 아직 플러스권)",
    ticks: [mkTick({ futChg: 0.2 }), mkTick({ futChg: 1.5 }), mkTick({ futChg: 0.4 })],
    expectKeys: ["swing_fut_d1"],
  },
  {
    name: "선물 반등 -2.4%→-0.8% (저점 대비 +1.6%p)",
    ticks: [mkTick({ futChg: -1.0 }), mkTick({ futChg: -2.4 }), mkTick({ futChg: -0.8 })],
    expectKeys: ["move_fut_d0.7", "swing_fut_u1"],
  },
  {
    name: "일방향 하락은 반전 아님 (고점 +0.1%)",
    ticks: [mkTick({ futChg: 0.1 }), mkTick({ futChg: -1.2 }), mkTick({ futChg: -1.6 })],
    expectKeys: ["move_fut_d1.5"],
  },
];
for (const c of moveCases) {
  const got = buildMoveAlerts(c.ticks).map((a) => a.key).sort();
  const want = [...c.expectKeys].sort();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name} — 기대 [${want.join(",")}] / 실제 [${got.join(",")}]`);
  for (const a of buildMoveAlerts(c.ticks)) console.log(`  📱 ${a.text}`);
}

console.log(`\n총 실패 ${failed}건`);
process.exit(failed > 0 ? 1 : 0);
