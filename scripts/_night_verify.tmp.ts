import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data } = await sb.from("g1a_days").select("symbol,t2").eq("date", "2026-08-20");
  for (const r of data ?? []) {
    const bars = ((r.t2 as Record<string, unknown>)?.nf as { bars?: { t: string; pct: number }[] } | undefined)?.bars ?? [];
    const night = bars.filter((b) => b.t > "19:40");
    console.log(`[bars] ${r.symbol} 총 ${bars.length}개 · 야간(19:40 이후) ${night.length}개 ${night.length ? `첫 ${night[0].t} ${night[0].pct}% ~ 끝 ${night[night.length - 1].t} ${night[night.length - 1].pct}%` : "— 아직 없음"}`);
  }
  const { data: gb } = await sb.from("g1b_days").select("symbol,night").eq("date", "2026-08-21");
  for (const r of gb ?? []) {
    const w = (r.night as Record<string, unknown> | null)?.watch as { cp?: Record<string, { t?: string; nf_pct?: number | null }> } | undefined;
    console.log(`[cp 8/21라벨] ${r.symbol} 2340=${w?.cp?.["2340"] ? `${w.cp["2340"].t} ${w.cp["2340"].nf_pct}%` : "없음"}`);
  }
}
main();
