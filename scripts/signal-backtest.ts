// 신호 엔진 6월 재현 검증 러너 — `npx tsx scripts/signal-backtest.ts`
// 엔진(lib/signal/engine)·backtest는 외부 의존성 없는 순수 함수라 DB·API 없이 실행된다.

import { runBacktest } from "../lib/signal/backtest";
import { buildMoveAlerts, buildReversalAlert, buildVolumeAlert, buildFlowAlerts } from "../lib/signal/alerts";
import { detectReversal } from "../lib/signal/engine/reversal";
import { computeSwingStructure } from "../lib/signal/engine/trend";
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
  hynixVol: null, kospiFrgn: null, kospiPrgm: null, futFrgn: null, futFrgnQty: null,
  nikkeiChg: null, twiiChg: null, nqChg: null, breadth: null, basis: null, ...over,
});
const moveCases: { name: string; ticks: IntradayTick[]; expectKeys: string[] }[] = [
  { name: "하닉 -5.2% (급락 2단계)", ticks: [mkTick({ hynixChg: -5.2 })], expectKeys: ["move_hynix_d5"] },
  { name: "하닉 +3.4% 급등 + 선물 -1.8%", ticks: [mkTick({ hynixChg: 3.4, futChg: -1.8 })], expectKeys: ["move_hynix_u3", "move_fut_d1.68"] },
  { name: "선물 -2.3% (2.24단계)", ticks: [mkTick({ futChg: -2.3 })], expectKeys: ["move_fut_d2.24"] },
  { name: "선물 -0.8% (첫 감지선 0.56)", ticks: [mkTick({ hynixChg: -2.9, futChg: -0.8 })], expectKeys: ["move_fut_d0.56"] },
  { name: "미돌파 (하닉 -2.9% · 선물 -0.5%)", ticks: [mkTick({ hynixChg: -2.9, futChg: -0.5 })], expectKeys: [] },
  { name: "장외 시간 (16:30)", ticks: [mkTick({ hynixChg: -8, minuteOfDay: 990 })], expectKeys: [] },
  // 반락·반등 스윙 (0.56%p 스텝 — 2026-07-13 20% 축소. 키에 극값 에피소드 포함, 극값 갱신 시 재무장)
  {
    name: "선물 반락 +1.5%→-1.1% (고점 대비 -2.6%p)",
    ticks: [mkTick({ futChg: 0.2 }), mkTick({ futChg: 1.5 }), mkTick({ futChg: 0.4 }), mkTick({ futChg: -1.1 })],
    expectKeys: ["move_fut_d0.56", "swing_fut_d2.2e2"],
  },
  {
    name: "선물 반락 조기 경고 +1.5%→+0.4% (고점 대비 -1.1%p, 아직 플러스권)",
    ticks: [mkTick({ futChg: 0.2 }), mkTick({ futChg: 1.5 }), mkTick({ futChg: 0.4 })],
    expectKeys: ["swing_fut_d0.6e2"],
  },
  {
    // 2026-07-09 수정: 반등 중(-2.4→-0.8)의 "급락 -0.8%" 절대단계 재발송 제거 — 스윙 알림만
    name: "선물 반등 -2.4%→-0.8% (저점 대비 +1.6%p)",
    ticks: [mkTick({ futChg: -1.0 }), mkTick({ futChg: -2.4 }), mkTick({ futChg: -0.8 })],
    expectKeys: ["swing_fut_u1.1e-5"],
  },
  {
    // 2026-07-09 사용자 보고 사례: 고점 +4.3% 후 +2.7%로 하락 중 — "급등 +2.7%" 문자 금지, 반락 스윙만
    name: "고점 +4.3% 후 +2.7% 하락 중 — 절대단계(급등) 재발송 금지",
    ticks: [mkTick({ futChg: 1.0 }), mkTick({ futChg: 4.3 }), mkTick({ futChg: 2.7 })],
    expectKeys: ["swing_fut_d1.1e7"],
  },
  {
    name: "일방향 하락은 반전 아님 (고점 +0.1%)",
    ticks: [mkTick({ futChg: 0.1 }), mkTick({ futChg: -1.2 }), mkTick({ futChg: -1.6 })],
    expectKeys: ["move_fut_d1.12"],
  },
  {
    // 2026-07-09 수정: 마지막 틱 -5.5는 저점(-6.3) 대비 반등 중 — 절대단계 없이 스윙만
    // (실시간에서는 -6.3 틱 시점에 move_fut_d6.3이 이미 발송됨)
    name: "저점 갱신 후 새 반등 — 에피소드 리셋 (저점 -6.3, +0.8 반등이 새 키로)",
    ticks: [mkTick({ futChg: -1.0 }), mkTick({ futChg: -4.3 }), mkTick({ futChg: -2.8 }), mkTick({ futChg: -6.3 }), mkTick({ futChg: -5.5 })],
    expectKeys: ["swing_fut_u0.6e-12"],
  },
  {
    name: "폭락 연장 단계 — -7.1%도 알림 (상위 구간)",
    ticks: [mkTick({ futChg: -7.1 })],
    expectKeys: ["move_fut_d6.72"],
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

// 거래량 급증 알람 검증 (사용자 지정 2026-07-08 — 하닉 5분봉이 당일 평균 1.3배 이상)
console.log("\n── 거래량 급증 검증");
// 분당 누적 거래량을 주면 5분봉 거래량은 완성 버킷 간 차로 계산됨
const volTicks = (cumAt: (min: number) => number, from: number, to: number): IntradayTick[] => {
  const out: IntradayTick[] = [];
  for (let min = from; min <= to; min++) out.push(mkTick({ minuteOfDay: min, hynixVol: cumAt(min), hynixChg: -3.2 }));
  return out;
};
{
  // 평상 봉 10만주 × 5개 후 마지막 봉 20만주 (2.0배) → 발동
  const spike = buildVolumeAlert(volTicks((m) => (m < 565 ? (m - 539) * 20000 : 500000 + (m - 564) * 40000), 540, 570));
  const okSpike = spike?.key === "vol_hynix_b113";
  if (!okSpike) failed++;
  console.log(`[${okSpike ? "PASS" : "FAIL"}] 5분봉 2.0배 급증 — 기대 vol_hynix_b113 / 실제 ${spike?.key ?? "없음"}`);
  if (spike) console.log(`  📱 ${spike.text}`);
  // 1.2배는 기준(1.3) 미달 → 무알람
  const mild = buildVolumeAlert(volTicks((m) => (m < 565 ? (m - 539) * 20000 : 500000 + (m - 564) * 24000), 540, 570));
  const okMild = mild === null;
  if (!okMild) failed++;
  console.log(`[${okMild ? "PASS" : "FAIL"}] 1.2배는 무알람 — 실제 ${mild?.key ?? "없음"}`);
  // 거래량 데이터 없음(마이그레이션 전) → 무알람
  const noVol = buildVolumeAlert(volTicks(() => NaN, 540, 570).map((t) => ({ ...t, hynixVol: null })));
  const okNoVol = noVol === null;
  if (!okNoVol) failed++;
  console.log(`[${okNoVol ? "PASS" : "FAIL"}] 거래량 데이터 없음 — 무알람 ${okNoVol}`);
  // 급증 + 상승 반전 동반 — 문자에 '상승반전' 표기 (2026-07-08 사용자 요청)
  const spikeRev = buildVolumeAlert(
    Array.from({ length: 31 }, (_, i) => {
      const min = 540 + i;
      const cum = min < 565 ? (min - 539) * 20000 : 500000 + (min - 564) * 40000;
      const chg = min < 565 ? -3.2 : -3.2 + (min - 564) * 0.2; // 급증 구간에 5분봉 +1.0%p 반등
      return mkTick({ minuteOfDay: min, hynixVol: cum, hynixChg: Number(chg.toFixed(2)) });
    }),
  );
  const okRev = spikeRev !== null && spikeRev.text.includes("상승반전");
  if (!okRev) failed++;
  console.log(`[${okRev ? "PASS" : "FAIL"}] 급증 + 상승반전 표기 — 실제 "${spikeRev?.text ?? "없음"}"`);
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

// ── 외인·프로그램 수급 반전 알림 검증 (사용자 지정 2026-07-09)
console.log("\n── 수급 반전 알림 검증");
const flowTicks = (vals: (number | null)[], sel: "kospiFrgn" | "kospiPrgm"): IntradayTick[] =>
  vals.map((v, i) => mkTick({ minuteOfDay: 575 + i, [sel]: v }));
const flowCases: { name: string; ticks: IntradayTick[]; expectKeys: string[] }[] = [
  {
    // 순매수 +3,200억 고점 후 +1,900억 — 매수세 이탈 (매도기회 관찰)
    name: "외인 순매수 고점 +3,200억 → +1,900억 반락",
    ticks: flowTicks([500, 1500, 3200, 2600, 1900], "kospiFrgn"),
    expectKeys: ["flow_kfrgn_d800e4"],
  },
  {
    // 순매도 -4,100억 저점 후 -2,900억 — 순매도 감속 (매수기회 관찰)
    name: "외인 순매도 저점 -4,100억 → -2,900억 감속",
    ticks: flowTicks([-1000, -2500, -4100, -3500, -2900], "kospiFrgn"),
    expectKeys: ["flow_kfrgn_u800e-6"],
  },
  {
    // 일방향 확대 (반전 없음) — 무알림
    name: "프로그램 일방향 순매수 확대 — 무알림",
    ticks: flowTicks([200, 900, 1800, 2600, 3300], "kospiPrgm"),
    expectKeys: [],
  },
  {
    // 진폭 미달 (선행 되돌림 minSpan 300억 미만) — 무알림
    name: "미세 등락 (진폭 250억) — 무알림",
    ticks: flowTicks([100, 350, 200, 150, 120], "kospiFrgn"),
    expectKeys: [],
  },
];
for (const c of flowCases) {
  const got = buildFlowAlerts(c.ticks).map((a) => a.key).sort();
  const want = [...c.expectKeys].sort();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name} — 기대 [${want.join(",")}] / 실제 [${got.join(",")}]`);
  for (const a of buildFlowAlerts(c.ticks)) console.log(`  📱 ${a.text}`);
}

// ── 스윙 구조(T6 재정의) 단위 검증 (사용자 지정 2026-07-09)
console.log("\n── 스윙 구조 판정 검증");
const swingPts = (pcts: number[]): { min: number; px: number }[] =>
  pcts.map((p, i) => ({ min: 540 + i * 5, px: 400 * (1 + p / 100) }));
const swingCases: { name: string; pcts: number[]; expect: string }[] = [
  // 고점·저점 모두 상승 (2점 일치) — 계단식 상승
  { name: "고점선·저점선 상승 → 상방 추세", pcts: [0, 0.8, 0.3, 1.5, 0.9, 2.0, 1.6], expect: "추세/UP" },
  // 고점·저점 모두 하락
  { name: "고점선·저점선 하락 → 하방 추세", pcts: [0, -0.8, -0.3, -1.5, -0.9, -2.2, -1.7], expect: "추세/DOWN" },
  // 같은 높이 반복 — 횡보
  { name: "같은 높이 산·골 반복 → 횡보", pcts: [0, 0.5, -0.4, 0.52, -0.38, 0.49, -0.41, 0.3], expect: "횡보/-" },
  // 고점 하락·저점 상승(수렴) 후 3번째 고점까지 하락 지향 → 하방 반영
  { name: "2점 불일치 → 고점 3점 하락 지향 → 하방", pcts: [0, 1.2, -0.8, 0.7, -0.3, 0.1, -0.5], expect: "추세/DOWN" },
  // 스윙 부족 (일방향 상승 — 산·골이 안 생김) → 미정 (횡보 아님)
  { name: "일방향 상승 (스윙 부족) → 미정", pcts: [0, 0.4, 0.9, 1.4, 2.0], expect: "미정/-" },
];
for (const c of swingCases) {
  const r = computeSwingStructure(swingPts(c.pcts));
  const got = `${r.status}/${r.dir ?? "-"}`;
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name} — 기대 ${c.expect} / 실제 ${got} (${r.detail})`);
}

console.log(`\n총 실패 ${failed}건`);
process.exit(failed > 0 ? 1 : 0);
