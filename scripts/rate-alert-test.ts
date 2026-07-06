// 금리 알람 판정 로직 회귀 검증 — evaluateRateAlerts 시나리오 (docs/rate-alert.md)
// 실행: npx tsx scripts/rate-alert-test.ts  (판정 로직 수정 후 반드시 실행 — 전부 PASS여야 함)
import { evaluateRateAlerts, type RateSample } from "../lib/market/rateAlert";

// 단계 레벨: 4.14 경고 / 4.15 위험 / 4.16 최고위험 (2026-07-07 — 4.125 단일 기준은 진동 노이즈로 제거)
const cfg = { delta30m: 0.03, delta1h: 0.03, levels2y: [4.14, 4.15, 4.16], level10y: 4.45 };
const T0 = Date.parse("2026-07-06T00:00:00Z");
const m = (min: number) => T0 + min * 60000;
const S = (min: number, y2: number | null, y10: number | null = 4.40): RateSample => ({ ts: m(min), y2, y10 });

let failed = 0;
function run(name: string, samples: RateSample[], expectKeys: string[]) {
  const hits = evaluateRateAlerts(samples, cfg);
  const keys = hits.map((h) => h.key).sort();
  const ok = JSON.stringify(keys) === JSON.stringify([...expectKeys].sort());
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} → [${keys.join(", ")}] (기대: [${expectKeys.join(", ")}])`);
  for (const h of hits) {
    const bytes = [...h.text].reduce((n, ch) => n + (ch.charCodeAt(0) <= 0x7f ? 1 : 2), 0);
    console.log(`   ${h.key}: "${h.text}" (${bytes}바이트${bytes > 90 ? " ← LMS 전환됨!" : ""})`);
  }
}

// ── 급변 (변경 없음)
// 1) 평시 — 30분 +0.01: 무알람
run("평시 소폭 변동", [S(0, 4.05), S(10, 4.055), S(20, 4.058), S(30, 4.06)], []);

// 2) 30분 급등 +0.04 (6/5형)
run("30분 급등", [S(0, 4.05), S(10, 4.05), S(30, 4.06), S(60, 4.10)], ["rate2y_spike_up"]);

// 3) 1시간 완만 급등 +0.035 (30분은 +0.02로 미달)
run("1시간 급등", [S(0, 4.05), S(30, 4.065), S(60, 4.085)], ["rate2y_spike_up"]);

// 4) 30분 급락 -0.04
run("30분 급락", [S(0, 4.10), S(30, 4.10), S(60, 4.06)], ["rate2y_spike_down"]);

// ── 단계 레벨
// 5) 옛 기준선(4.125) 주변 진동 — 이제 무알람 (4.14 미만은 안전권)
run("4.125 주변 진동(무알람)", [S(0, 4.122), S(10, 4.127), S(20, 4.122), S(30, 4.127)], []);

// 6) 경고단계 돌파 (4.135 → 4.142)
run("경고단계 돌파", [S(0, 4.135), S(10, 4.142)], ["rate2y_lvl_u4.14"]);

// 7) 경고 → 위험 승격 (4.142 → 4.152)
run("위험단계 승격", [S(0, 4.142), S(10, 4.152)], ["rate2y_lvl_u4.15"]);

// 8) 한 번에 두 단계 점프 (4.13 → 4.165) — 최종 단계 1건만
run("점프 시 최고 단계만", [S(0, 4.13), S(10, 4.165)], ["rate2y_lvl_u4.16"]);

// 9) 경고 해제 (4.142 → 4.135)
run("경고단계 해제", [S(0, 4.142), S(10, 4.135)], ["rate2y_lvl_d4.14"]);

// 10) 최고위험에서 한 번에 전부 해제 (4.165 → 4.135) — 최하 단계 이탈 1건만
run("전단계 해제", [S(0, 4.165), S(10, 4.135)], ["rate2y_lvl_d4.14"]);

// 11) 단계 내 유지 (4.142 → 4.145): 무알람
run("단계 내 유지", [S(0, 4.142), S(10, 4.145)], []);

// 12) 첫 가동(샘플 1개) — 2Y 4.145는 경고단계, 10Y 4.485는 기준 위 → 각 1회 상태 알림
run("첫 가동 부트스트랩", [S(0, 4.145, 4.485)], ["rate2y_lvl_u4.14", "rate10y_level_up"]);

// 13) 첫 가동인데 단계 아래(4.11) — 무알람 (옛 4.125 부트스트랩 알림 제거 확인)
run("첫 가동 안전권", [S(0, 4.11, 4.40)], []);

// 14) 24시간 공백 후(주말) — 직전 샘플 무효 → 부트스트랩 취급
run("24h+ 공백 후", [S(-3000, 4.13, 4.46), S(0, 4.145, 4.46)], ["rate2y_lvl_u4.14", "rate10y_level_up"]);

// 15) 10년물 상향 돌파 (4.44 → 4.46)
run("10년물 돌파", [S(0, 4.10, 4.44), S(10, 4.10, 4.46)], ["rate10y_level_up"]);

// 16) 급등 + 단계 돌파 동시 (4.11 → 4.152: 1시간 +0.042 급등 + 위험단계)
run("급등+단계 동시", [S(0, 4.11), S(30, 4.12), S(60, 4.152)], ["rate2y_spike_up", "rate2y_lvl_u4.15"]);

// 17) y2 null (조회 실패) — 10Y만 판정
run("2Y 조회 실패", [S(0, null, 4.44), S(10, null, 4.46)], ["rate10y_level_up"]);

// 18) 50분 전 샘플만 존재 — 30분 창(20~40분)엔 안 걸치지만 1시간 창(45~75분)엔 포함 → 1시간 조건으로 감지
run("샘플 공백(1시간 창)", [S(0, 4.05), S(50, 4.10)], ["rate2y_spike_up"]);

// 19) 90분 전 샘플만 존재 — 모든 창 밖 → 급변 판정 불가, 무알람
run("샘플 공백(창 밖)", [S(0, 4.05), S(90, 4.10)], []);

console.log(`\n총 실패 ${failed}건`);
process.exit(failed > 0 ? 1 : 0);
