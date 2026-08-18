// 등급-행동 축 분리 소급 정정 (발주자 확정 2026-08-18) — g1a_days.t2.grade / t2.action 재산출.
//   npx tsx scripts/g1a-grade-fix-0818.ts [--save]
// 종전 t2Grade는 direction=NEUTRAL이면 |score|와 무관하게 Lean으로 매핑 → 8/18 삼전 -4.35(θ_low 3.0 초과)가 "▽ 갭하락 Lean".
// 정정: 등급 = 점수 구간(트리거 시각 θ 기준), 행동 = 트리거 결과. 갭하락 분리 채점(Lean/High·Low)은 저장값을 읽으므로 자동 반영.
// 리포트 텍스트(report_r1)의 둘째 줄(등급 라벨)도 함께 정정. 첫 줄(행동)은 코드가 바뀌는 행만 교체.

import { readFileSync } from "fs";
import { resolve } from "path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const SAVE = process.argv.includes("--save");

async function main() {
  const { createAdminClient } = await import("../lib/supabase/admin");
  const { t2Grade, thetaAt } = await import("../lib/g1a/score");
  const { t2Action, gradeLabel } = await import("../lib/g1/action");
  const { G1A_CONFIG } = await import("../lib/g1a/config");
  const admin = createAdminClient();
  const { data } = await admin.from("g1a_days").select("date,symbol,t2").order("date", { ascending: true });
  let changed = 0;
  for (const r of (data ?? []) as { date: string; symbol: string; t2: Record<string, unknown> | null }[]) {
    const t2 = r.t2; if (!t2?.verdict) continue;
    const v = t2.verdict as { direction: string; confidence: string | null; gap_score: number; abstain_reason: string | null; size: string; expected_residual_gap: number | null; theta_applied?: number | null };
    const oldG = t2.grade as { grade?: string; label?: string; lean_dir?: "UP" | "DOWN" | null } | undefined;
    const oldA = t2.action as { code?: string; line?: string; phase?: "가상" | "실사용" } | undefined;
    // θ: 트리거 시각 기준 (없으면 최종 19:40)
    const trig = String(t2.trigger_time ?? "").slice(0, 5);
    const th = trig ? thetaAt(trig) : thetaAt(G1A_CONFIG.windows.t2Final);
    const g0 = t2Grade(v, th);
    const isEvt = (v.abstain_reason ?? "").startsWith("보류1");
    const g = { ...g0, label: gradeLabel(g0.grade, g0.lean_dir, isEvt) };
    // 행동: 트리거 밤(UP/DOWN)은 불변. NEUTRAL 밤만 재산출 (blocked 사유는 기존 라인의 괄호에서 복원)
    let action = oldA;
    if (v.direction === "NEUTRAL") {
      const why = oldA?.line?.match(/·([^)]+)\)/)?.[1] ?? null;
      const a = t2Action(v, why, oldA?.phase ?? "가상", g);
      action = { ...oldA, ...a };
    }
    const same = oldG?.grade === g.grade && oldG?.label === g.label && oldA?.code === action?.code;
    if (same) continue;
    // 이벤트 밤(보류1)은 E-등급 헌법(E-Lean/E-Low/E-Hold, 8/12 개정안) 소관 — 본 정정 범위 밖. 표시만 하고 저장하지 않는다 (상신).
    if (isEvt) { console.log(`[E 밤 — 정정 보류·상신] ${r.date} ${r.symbol}: ${oldG?.label ?? "(등급 없음)"} → ${g.label} (score ${v.gap_score}) — E-체계 별건`); continue; }
    changed++;
    console.log(`${r.date} ${r.symbol}: 등급 ${oldG?.label ?? "—"} → ${g.label} · 행동 ${oldA?.code ?? "—"} → ${action?.code ?? "—"} (score ${v.gap_score}, θ_low ${th.low}${trig ? ` @${trig}` : ""})`);
    if (!SAVE) continue;
    const next: Record<string, unknown> = { ...t2, grade: g, action, grade_fix_0818: { old_grade: oldG?.label ?? null, old_action: oldA?.code ?? null } };
    // report_r1 둘째 줄(등급 라벨) 교체 — 첫 줄은 행동 코드가 바뀐 경우만
    if (typeof t2.report_r1 === "string") {
      const lines = (t2.report_r1 as string).split("\n");
      if (lines.length >= 2 && oldG?.label && lines[1] === oldG.label) lines[1] = g.label;
      if (action?.line && oldA?.line && lines[0] === oldA.line && action.code !== oldA.code) lines[0] = action.line;
      next.report_r1 = lines.join("\n");
    }
    const { error } = await admin.from("g1a_days").update({ t2: next, updated_at: new Date().toISOString() }).eq("date", r.date).eq("symbol", r.symbol);
    if (error) console.log(`  저장 실패: ${error.message}`);
  }
  console.log(`\n정정 대상 ${changed}행${SAVE ? " — 저장 완료" : " (미저장 — --save로 반영)"}`);
}
main();
