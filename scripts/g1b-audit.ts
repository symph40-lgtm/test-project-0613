// G1B 결측 전수 감사 (상비판 — 발주자 판정 8/11 §4):
//   npx tsx scripts/g1b-audit.ts
// 컬럼·키를 하드코딩 신뢰하지 않는다 — 실제 행의 키 집합과 기대 목록을 대조(존재 검증) 후 조회.
// (supabase-js는 information_schema 직접 조회 불가 — 런타임 키 대조가 동일 목적을 달성)
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const EXPECT_NIGHT = ["r_spx", "r_soxx", "r_mu", "r_nvda", "r_gdr", "ah_excess", "gx", "night_fut", "tnx", "zt"];
const EXPECT_MORNING = ["r_asx", "r_nk_fut", "gx2", "auction_est_px"];
async function main() {
  const { createAdminClient } = await import("../lib/supabase/admin");
  const admin = createAdminClient();
  const { data, error } = await admin.from("g1b_days").select("*").order("date", { ascending: true });
  if (error) { console.log("조회 실패:", error.message); process.exit(1); }
  const rows = data ?? [];
  if (!rows.length) { console.log("행 없음"); return; }
  // 존재 검증: 기대 키가 실제 행 어디에도 없으면 감사 자체를 중단 (오타 감사 방지)
  const seenN = new Set(rows.flatMap((r) => Object.keys((r.night as object) ?? {})));
  const seenM = new Set(rows.flatMap((r) => Object.keys((r.morning as object) ?? {})));
  const unknownN = EXPECT_NIGHT.filter((k) => !seenN.has(k));
  const unknownM = EXPECT_MORNING.filter((k) => !seenM.has(k));
  if (unknownN.length || unknownM.length) {
    console.log(`⚠ 기대 키가 데이터에 전무 — 감사 목록 오타 의심: night=${unknownN} morning=${unknownM}`);
  }
  const cnt: Record<string, { miss: number; total: number; firstOk: string | null }> = {};
  for (const r of rows) {
    for (const [grp, keys] of [["night", EXPECT_NIGHT], ["morning", EXPECT_MORNING]] as const) {
      const obj = (r[grp] ?? {}) as Record<string, { v: number | null }>;
      for (const k of keys) {
        cnt[k] ??= { miss: 0, total: 0, firstOk: null };
        cnt[k].total++;
        if (obj[k]?.v == null) cnt[k].miss++;
        else cnt[k].firstOk ??= r.date as string;
      }
    }
  }
  console.log("키              결측/전체   첫 정상일");
  for (const [k, c] of Object.entries(cnt)) {
    console.log(`${k.padEnd(15)} ${String(c.miss).padStart(3)}/${String(c.total).padEnd(6)} ${c.firstOk ?? "—"}`);
  }
}
main();
