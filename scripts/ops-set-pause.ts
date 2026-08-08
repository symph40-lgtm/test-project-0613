// 문자 일시정지 설정/해제 (모바일 /ops와 동일한 ops_settings.sms_pause 쓰기):
//   npx tsx scripts/ops-set-pause.ts 2026-08-21 [allowStrong]   ← 설정 (기본 allowStrong=false)
//   npx tsx scripts/ops-set-pause.ts clear                      ← 해제
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const arg = process.argv[2] ?? "";
  if (arg === "clear") {
    const { error } = await sb.from("ops_settings").delete().eq("key", "sms_pause");
    console.log(error ? error : "sms_pause 해제됨");
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) { console.error("until 날짜(YYYY-MM-DD) 또는 clear 필요"); process.exit(1); }
  const allowStrong = process.argv[3] === "true";
  const { error } = await sb.from("ops_settings").upsert(
    { key: "sms_pause", value: { until: arg, allowStrong }, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) { console.error(error); process.exit(1); }
  const { data } = await sb.from("ops_settings").select("value,updated_at").eq("key", "sms_pause").maybeSingle();
  console.log("적용:", JSON.stringify(data?.value), data?.updated_at?.slice(0, 16));
}
main();
