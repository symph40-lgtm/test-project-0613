// 신호 엔진 6월 재현 검증 러너 — `npx tsx scripts/signal-backtest.ts`
// 엔진(lib/signal/engine)·backtest는 외부 의존성 없는 순수 함수라 DB·API 없이 실행된다.

import { runBacktest } from "../lib/signal/backtest";
import { buildMoveAlerts, buildReversalAlert } from "../lib/signal/alerts";
import { detectReversal } from "../lib/signal/engine/reversal";
import type { IntradayTick, Judgment } from "../lib/signal/types";

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
  { name: "하닉 +3.4% 급등 + 선물 -1.8%", ticks: [mkTick({ hynixChg: 3.4, futChg: -1.8 })], expectKeys: ["move_hynix_u3", "move_fut_d1.4"] },
  { name: "선물 -2.3% (2.1단계)", ticks: [mkTick({ futChg: -2.3 })], expectKeys: ["move_fut_d2.1"] },
  { name: "선물 -0.8% (첫 감지선 0.7)", ticks: [mkTick({ hynixChg: -2.9, futChg: -0.8 })], expectKeys: ["move_fut_d0.7"] },
  { name: "미돌파 (하닉 -2.9% · 선물 -0.5%)", ticks: [mkTick({ hynixChg: -2.9, futChg: -0.5 })], expectKeys: [] },
  { name: "장외 시간 (16:30)", ticks: [mkTick({ hynixChg: -8, minuteOfDay: 990 })], expectKeys: [] },
  // 반전 스윙 (2026-07-06 사용자 요청 — 고점 대비 반락 / 저점 대비 반등, 0.7%p 등간격)
  {
    name: "선물 반락 +1.5%→-1.1% (고점 대비 -2.6%p)",
    ticks: [mkTick({ futChg: 0.2 }), mkTick({ futChg: 1.5 }), mkTick({ futChg: 0.4 }), mkTick({ futChg: -1.1 })],
    expectKeys: ["move_fut_d0.7", "swing_fut_d2.1"],
  },
  {
    name: "선물 반락 조기 경고 +1.5%→+0.4% (고점 대비 -1.1%p, 아직 플러스권)",
    ticks: [mkTick({ futChg: 0.2 }), mkTick({ futChg: 1.5 }), mkTick({ futChg: 0.4 })],
    expectKeys: ["swing_fut_d0.7"],
  },
  {
    name: "선물 반등 -2.4%→-0.8% (저점 대비 +1.6%p)",
    ticks: [mkTick({ futChg: -1.0 }), mkTick({ futChg: -2.4 }), mkTick({ futChg: -0.8 })],
    expectKeys: ["move_fut_d0.7", "swing_fut_u1.4"],
  },
  {
    name: "일방향 하락은 반전 아님 (고점 +0.1%)",
    ticks: [mkTick({ futChg: 0.1 }), mkTick({ futChg: -1.2 }), mkTick({ futChg: -1.6 })],
    expectKeys: ["move_fut_d1.4"],
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

// RV1 하닉 분봉 모멘텀 검증 (사용자 지정 2026-07-07 — 추세·반전 무관, 분봉 조건 7종 + XS1 게이트)
console.log("\n── RV1 분봉 모멘텀 검증");
// 하닉 등락률 시계열 → 1분 틱 배열
const hynixSeries = (fn: (min: number) => number, from: number, to: number): IntradayTick[] => {
  const out: IntradayTick[] = [];
  for (let min = from; min <= to; min++) out.push(mkTick({ minuteOfDay: min, hynixChg: Number(fn(min).toFixed(2)) }));
  return out;
};
const revCases: { name: string; ticks: IntradayTick[]; expect: string }[] = [
  {
    // 지속 하락(-0.1%/분) 후 마지막 1분 +0.9 — 추세 무관이므로 둘 다 성립,
    // |변동|이 큰 5분봉7개 하락(-3.5%p)이 우선 판정
    name: "지속 하락 중 — 큰 쪽(5분봉7개 하락) 우선",
    ticks: hynixSeries((m) => (m <= 590 ? -0.1 * (m - 540) : -4.1), 540, 591),
    expect: "DOWN/5분봉7개",
  },
  {
    // 상승 후 15분 하락 — 5분봉 3개 합 -2.55 (≥2.2)
    name: "5분봉 3개 합 -2.5 하락",
    ticks: hynixSeries((m) => (m <= 584 ? 0.1 * (m - 540) : 4.4 - 0.17 * (m - 584)), 540, 600),
    expect: "DOWN/5분봉3개",
  },
  {
    // 횡보(보합) 중 1분봉 +0.9 (≥0.8)
    name: "횡보 중 1분봉 +0.9 상승",
    ticks: hynixSeries((m) => (m <= 590 ? 0 : 0.9), 540, 591),
    expect: "UP/1분봉",
  },
  {
    // 신규 조건: 1분봉 5개 합 +1.6 (≥1.5) — 1개(0.32)·3개(0.96)로는 미달
    name: "1분봉 5개 합 +1.6 상승 (신규 조건)",
    ticks: hynixSeries((m) => (m <= 589 ? 0 : 0.32 * (m - 589)), 540, 594),
    expect: "UP/1분봉5개",
  },
  {
    // 임계값 미달 (1분봉 +0.7 < 0.8) → 무판정
    name: "임계값 미달은 무판정",
    ticks: hynixSeries((m) => (m <= 590 ? 0 : 0.7), 540, 591),
    expect: "없음",
  },
];
for (const c of revCases) {
  const hit = detectReversal(c.ticks);
  const got = hit ? `${hit.dir}/${hit.cond.split(" ")[0]}` : "없음";
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name} — 기대 ${c.expect} / 실제 ${got}${hit ? ` (${hit.cond}, 직전 ${hit.preMovePct}%p)` : ""}`);
}
// XS1 게이트 — 폭락 분기 활성 시 하락 반전(인버스) 문자 차단, 해제 시 발송
const downHit = detectReversal(revCases[1].ticks);
const fakeJ = (crash: boolean): Judgment =>
  ({ ext: { reversal: downHit }, phase: "판정", crashContext: { active: crash }, date: "2026-07-07", ts: "", dayType: "대기" }) as unknown as Judgment;
const blockedOk = buildReversalAlert(fakeJ(true)) === null;
const sentAlert = buildReversalAlert(fakeJ(false));
const sentOk = sentAlert?.key === "rev_down";
if (!blockedOk || !sentOk) failed++;
console.log(`[${blockedOk && sentOk ? "PASS" : "FAIL"}] XS1 게이트 — 폭락 중 인버스 차단 ${blockedOk} · 평시 발송 ${sentOk}`);
if (sentAlert) console.log(`  📱 ${sentAlert.text}`);

console.log(`\n총 실패 ${failed}건`);
process.exit(failed > 0 ? 1 : 0);
