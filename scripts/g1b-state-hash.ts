// 영속성 복구 훈련용 — g1b_state 해시 산출 (재배포 전후 대조):
//   npx tsx scripts/g1b-state-hash.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
async function main() {
  const { createAdminClient } = await import("../lib/supabase/admin");
  const admin = createAdminClient();
  const { data, error } = await admin.from("g1b_state").select("symbol,state,updated_at");
  if (error) { console.log("로드 실패:", error.message); return; }
  for (const r of data ?? []) {
    const h = createHash("sha256").update(JSON.stringify(r.state)).digest("hex").slice(0, 16);
    console.log(`${r.symbol}  hash=${h}  nights=${(r.state as { nights?: number }).nights}  updated=${r.updated_at}`);
  }
  const { data: snaps } = await admin.from("g1b_state_snapshots").select("date,symbol,state_hash").order("date", { ascending: false }).limit(4);
  console.log("스냅샷:", JSON.stringify(snaps));
}
main();
