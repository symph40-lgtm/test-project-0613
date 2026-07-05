// 금리 알람 판정 로직 회귀 검증 — evaluateRateAlerts 시나리오 14종 (docs/rate-alert.md)
// 실행: npx tsx scripts/rate-alert-test.ts  (판정 로직 수정 후 반드시 실행 — 전부 PASS여야 함)
import { evaluateRateAlerts, type RateSample } from "../lib/market/rateAlert";

const cfg = { delta30m: 0.03, delta1h: 0.03, level2y: 4.125, level10y: 4.45 };
const T0 = Date.parse("2026-07-06T00:00:00Z");
const m = (min: number) => T0 + min * 60000;
const S = (min: number, y2: number | null, y10: number | null = 4.40): RateSample => ({ ts: m(min), y2, y10 });

function run(name: string, samples: RateSample[], expectKeys: string[]) {
  const hits = evaluateRateAlerts(samples, cfg);
  const keys = hits.map((h) => h.key).sort();
  const ok = JSON.stringify(keys) === JSON.stringify([...expectKeys].sort());
  console.log(`${ok ? "PASS" : "FAIL"} ${name} → [${keys.join(", ")}] (기대: [${expectKeys.join(", ")}])`);
  for (const h of hits) {
    const bytes = [...h.text].reduce((n, ch) => n + (ch.charCodeAt(0) <= 0x7f ? 1 : 2), 0);
    console.log(`   ${h.key}: "${h.text}" (${bytes}바이트${bytes > 90 ? " ← LMS 전환됨!" : ""})`);
  }
}

// 1) 평시 — 30분 +0.01: 무알람
run("평시 소폭 변동", [S(0, 4.05), S(10, 4.055), S(20, 4.058), S(30, 4.06)], []);

// 2) 30분 급등 +0.04 (6/5형)
run("30분 급등", [S(0, 4.05), S(10, 4.05), S(30, 4.06), S(60, 4.10)], ["rate2y_spike_up"]);

// 3) 1시간 완만 급등 +0.035 (30분은 +0.02로 미달)
run("1시간 급등", [S(0, 4.05), S(30, 4.065), S(60, 4.085)], ["rate2y_spike_up"]);

// 4) 30분 급락 -0.04
run("30분 급락", [S(0, 4.10), S(30, 4.10), S(60, 4.06)], ["rate2y_spike_down"]);

// 5) 레벨 상향 돌파 (4.12 → 4.13)
run("레벨 상향돌파", [S(0, 4.12), S(10, 4.13)], ["rate2y_level_up"]);

// 6) 레벨 하향 이탈 (4.13 → 4.12)
run("레벨 하향이탈", [S(0, 4.13), S(10, 4.12)], ["rate2y_level_down"]);

// 7) 레벨 위에 머무름 (4.13 → 4.14): 재돌파 아님 → 무알람
run("레벨 위 유지", [S(0, 4.13), S(10, 4.14)], []);

// 8) 첫 가동(샘플 1개) — 현재 2Y 4.137, 10Y 4.485: 둘 다 레벨 위 → 상태 알림
run("첫 가동 부트스트랩", [S(0, 4.137, 4.485)], ["rate2y_level_up", "rate10y_level_up"]);

// 9) 24시간 공백 후(주말) 레벨 위 — 직전 샘플 무효 → 부트스트랩 취급
run("24h+ 공백 후", [S(-3000, 4.13, 4.46), S(0, 4.14, 4.46)], ["rate2y_level_up", "rate10y_level_up"]);

// 10) 10년물 상향 돌파 (4.44 → 4.46)
run("10년물 돌파", [S(0, 4.10, 4.44), S(10, 4.10, 4.46)], ["rate10y_level_up"]);

// 11) 급등 + 레벨 돌파 동시 (6/30·7/1형 복합)
run("급등+레벨 동시", [S(0, 4.10), S(30, 4.11), S(60, 4.15)], ["rate2y_spike_up", "rate2y_level_up"]);

// 12) y2 null (조회 실패) — 10Y만 판정
run("2Y 조회 실패", [S(0, null, 4.44), S(10, null, 4.46)], ["rate10y_level_up"]);

// 13) 50분 전 샘플만 존재 — 30분 창(20~40분)엔 안 걸치지만 1시간 창(45~75분)엔 포함 → 1시간 조건으로 감지
run("샘플 공백(1시간 창)", [S(0, 4.05), S(50, 4.10)], ["rate2y_spike_up"]);

// 14) 90분 전 샘플만 존재 — 모든 창 밖 → 급변 판정 불가, 무알람
run("샘플 공백(창 밖)", [S(0, 4.05), S(90, 4.10)], []);
