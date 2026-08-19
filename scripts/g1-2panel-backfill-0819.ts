// 발주자 시각 규율 8/19 — ①4자 대조 2판 규약 소급 재분류 ②상충 v2 소급(8/19 밤 발동 기록) ③04:50 vs 06:00 마감 근접도 1회 보고
//   npx tsx scripts/g1-2panel-backfill-0819.ts
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const sgnOf = (x: number | null | undefined, band: number) => (x == null ? null : Math.abs(x) < band ? 0 : Math.sign(x));
async function main() {
  const { createAdminClient } = await import("../lib/supabase/admin");
  const { conflictV2 } = await import("../lib/g1/copy");
  const admin = createAdminClient();
  // ② G1A conflict_v2 소급 (기록 있는 전 행)
  const { data: aRows } = await admin.from("g1a_days").select("date,symbol,t2").gte("date", "2026-08-12");
  for (const r of aRows ?? []) {
    const t2 = r.t2 as Record<string, unknown> | null; if (!t2?.verdict) continue;
    const v = t2.verdict as { gap_score?: number; expected_residual_gap?: number | null; r_nxt_pre_entry?: number | null };
    const nfl = (t2.nf as { level?: { nf_level?: number } } | undefined)?.level?.nf_level ?? null;
    const cv = conflictV2({ gapScore: v.gap_score ?? null, residGap: v.expected_residual_gap ?? null, nxtPx: (t2.entry_px_virtual as number | null) ?? null, rNxt: v.r_nxt_pre_entry ?? null, nfLevel: nfl });
    t2.conflict_v2 = { ...cv, backfilled: true };
    await admin.from("g1a_days").update({ t2 }).eq("date", r.date).eq("symbol", r.symbol);
    if (cv.conflict) console.log(`상충v2 발동 ${r.date} ${r.symbol}: NXT경로 ${cv.openExp_resid} vs 야간선물 ${cv.openExp_nf} (괴리 ${cv.divergence_pp}%p) — ${cv.pairs.join("·")}`);
  }
  // ① four_way 2판 소급 + g1a_ref.resid_open_exp
  const { data: bRows } = await admin.from("g1b_days").select("date,symbol,r1,labels,night").gte("date", "2026-08-12");
  const aMap = new Map((aRows ?? []).map((r) => [`${r.date}|${r.symbol}`, r.t2 as Record<string, unknown> | null]));
  for (const r of bRows ?? []) {
    const r1 = r.r1 as Record<string, unknown> | null; const lab = r.labels as Record<string, unknown> | null;
    if (!r1?.g1a_ref) continue;
    const gref = r1.g1a_ref as Record<string, unknown>;
    const t2 = aMap.get(`${gref.date}|${r.symbol}`);
    const cv = t2?.conflict_v2 as { openExp_resid?: number | null } | undefined;
    gref.resid_open_exp = cv?.openExp_resid ?? null;
    const actual = lab?.actual_gap_pct as number | undefined;
    if (lab && lab.four_way && actual != null) {
      const fw = lab.four_way as Record<string, unknown>;
      const x = gref.resid_open_exp as number | null; const c = (r1.challenger_v11c as { fair_gap_pct?: number | null } | undefined)?.fair_gap_pct ?? null;
      fw.evening = { cut: "19:35", resid_open_exp: x, hit_resid: sgnOf(x, 0.3) && sgnOf(actual, 0.3) ? sgnOf(x, 0.3) === sgnOf(actual, 0.3) : null };
      fw.morning = { cut: "07:15", v11c_pct: c, hit_v11c: sgnOf(c, 0.3) && sgnOf(actual, 0.3) ? sgnOf(c, 0.3) === sgnOf(actual, 0.3) : null };
      fw.backfilled_2panel = true;
    }
    await admin.from("g1b_days").update({ r1, labels: lab }).eq("date", r.date).eq("symbol", r.symbol);
    console.log(`2판 소급 ${r.date} ${r.symbol}: 저녁 번역(NXT경로) ${gref.resid_open_exp ?? "—"} · 아침 v1.1c ${(r1.challenger_v11c as { fair_gap_pct?: number } | undefined)?.fair_gap_pct ?? "—"}`);
  }
  // ③ 04:50 vs 06:00 마감 근접도 — KRX 정본 마감(06:00) vs 라이브 04:50 vs 실측 (라벨 있는 밤)
  const { fetchKrxNightU1 } = await import("../lib/market/krxNight");
  console.log("\n[04:50 vs 06:00 마감 근접도] 라벨일 | 04:50 라이브 | 06:00 정본 | 실측갭(삼전/하닉) | β환산 오차 04:50 vs 06:00");
  for (const date of ["2026-08-19"]) {
    const krx = await fetchKrxNightU1(date);
    const rows = (bRows ?? []).filter((r) => r.date === date);
    for (const r of rows) {
      const nf = ((r.night as Record<string, unknown>)?.night_fut as { v?: number } | undefined)?.v;
      const act = (r.labels as { actual_gap_pct?: number } | null)?.actual_gap_pct;
      const beta = r.symbol === "005930" ? 1.316 : 1.517;
      if (nf == null || act == null || !krx) continue;
      const e1 = Math.abs(nf * 100 * beta - act), e2 = Math.abs(krx.u1_pct * beta - act);
      console.log(`${date} ${r.symbol} | ${(nf * 100).toFixed(2)} | ${krx.u1_pct} | ${act} | ${e1.toFixed(2)} vs ${e2.toFixed(2)} (${e2 < e1 ? "06:00 우위 " + (e1 - e2).toFixed(2) + "%p" : "04:50 우위"})`);
    }
  }
}
main();
