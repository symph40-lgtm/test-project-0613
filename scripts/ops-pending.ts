// 모바일 /ops에서 남긴 운영 지시·설정 조회 (세션 시작 루틴):
//   npx tsx scripts/ops-pending.ts
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await sb
    .from("ops_directives")
    .select("id,created_at,content,status,note")
    .order("id", { ascending: false })
    .limit(15);
  if (error) console.error(error);
  else for (const r of data ?? []) console.log(`[${r.status}] #${r.id} ${r.created_at?.slice(0, 16)} :: ${r.content}${r.note ? ` (note: ${r.note})` : ""}`);
  const { data: s } = await sb.from("ops_settings").select("key,value,updated_at");
  console.log("--- settings ---");
  for (const r of s ?? []) console.log(r.key, JSON.stringify(r.value), r.updated_at?.slice(0, 16));
}
main();
