// NM3 W1 — V5 소급 재계산 (IMPL_SPEC §B3 DoD③): 현재 페이퍼 누적분의 대역·SPRT 상태 1회 산출.
//   npx tsx scripts/nm3-v5-status.ts
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createAdminClient } from "../lib/supabase/admin";
import { v5Line } from "../lib/predict/nm3V5";

async function main() {
  const admin = createAdminClient();
  const get = async (key: string) => {
    const { data } = await admin.from("ops_settings").select("value").eq("key", key).maybeSingle();
    return Array.isArray(data?.value) ? (data!.value as Record<string, unknown>[]) : [];
  };
  const lad = await get("predict_cw_ladder");
  const ss = await get("predict_ssv2_scores");
  const us = await get("uspredict_v2_scores");
  console.log(`하닉 사다리 (${lad.length}행): ${v5Line(lad.map((r) => r.pnl as number), "hx") || "표본 부족"}`);
  console.log(`삼전 v2   (${ss.length}행): ${v5Line(ss.map((r) => r.p as number), "ss") || "표본 부족"}`);
  const usDone = us.filter((r) => !r.pend);
  console.log(`SOXX v2   (${us.length}행·확정 ${usDone.length}): ${v5Line(usDone.map((r) => r.p as number), "soxx") || "표본 부족"}`);
}
main();
