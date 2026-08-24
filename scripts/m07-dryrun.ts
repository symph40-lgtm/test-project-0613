// 아침판 07:00 미기록 사고 조사 (2026-08-24) — runMorning0700 경로 드라이런 (쓰기 없음)
//   npx tsx scripts/m07-dryrun.ts
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const symbol = "005930" as const;
  const sessionNight = "2026-08-21";
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const [ga, gb] = await Promise.all([
    admin.from("g1a_days").select("t2").eq("date", sessionNight).eq("symbol", symbol).maybeSingle(),
    admin.from("g1b_days").select("night,r1").eq("date", today).eq("symbol", symbol).maybeSingle(),
  ]);
  console.log("ga.error:", ga.error?.message ?? null, "| ga.data null?", ga.data == null);
  console.log("gb.error:", gb.error?.message ?? null, "| gb.data null?", gb.data == null);
  const t2e = (ga.data?.t2 ?? null) as Record<string, unknown> | null;
  if (!t2e) { console.log("EXIT: t2e null"); return; }
  const nfo = (gb.data?.night as { night_fut?: { v?: number | null; late_arrival?: boolean } } | null)?.night_fut;
  const nfClose = nfo?.v != null && !nfo.late_arrival ? nfo.v * 100 : null;
  console.log("nfClose:", nfClose);

  // T2 트랙
  try {
    const { fetchPremarketBasket, fetchUsFutDelta, fetchEuropeTone, fetchTsmcResidual, fetchDayCharacter, fetchFrnDecel, fetchMacroZ } = await import("@/lib/g1a/data");
    const [basket, usfut, europe, tsmc, dayChar, frn, macro] = await Promise.all([
      fetchPremarketBasket(symbol), fetchUsFutDelta(), fetchEuropeTone(), fetchTsmcResidual(), fetchDayCharacter(symbol), fetchFrnDecel(symbol), fetchMacroZ(),
    ]);
    console.log("T2 track fetches OK", { basket: basket.rBasket, usfut, europe: europe.pct, tsmc, frn, macroKeys: Object.keys(macro ?? {}) });
    const { gapScore } = await import("@/lib/g1a/score");
    const gs = gapScore({
      F21_basket: basket.rBasket, F21_dcpm: basket.dcpm, F21_obs_min: basket.obsMin,
      F22_usfut: usfut, F20_europe: europe.pct, F20_obs_min: europe.obsMin, F11p_tsmc_resid: tsmc,
      F01_clv: dayChar.clv, F02_dc1: dayChar.dc1, F04_o1: dayChar.o1, F09_c1: null,
      F08_frn_decel: frn, F05_w1: null, F07_b1_z: null,
      F13_rate_z: macro.rateZ, F14_fx_z: macro.fxZ, F24_news: null,
      r_nxt: null, nxt_last_px: null, spread_pct: null,
    } as never);
    console.log("gapScore OK:", gs.score);
  } catch (e) { console.log("T2 track ERR:", e instanceof Error ? e.message : e); }

  // v2/v2.1 트랙
  try {
    const { judgeDrift, buildShadowV2 } = await import("@/lib/g1a/t2plusV2");
    const { fetchBasketAccel30m } = await import("@/lib/g1a/data");
    const accel = await fetchBasketAccel30m(symbol);
    const drift = judgeDrift({ basketAccel30m: accel, dcNf: null, nfCumSign: 0, dcPm: null, basketSign: 0, p1Slope: null, eventTonight: null, macro: { dTnxBp: null, dFxPct: null, dWtiPct: null } });
    const { G1B_CONFIG } = await import("@/lib/g1b/config");
    const sigma = G1B_CONFIG.sigmaBase[symbol].normal;
    const s = buildShadowV2({ t: "dry", nfCutPct: nfClose ?? 0, beta: 1.316, drift, sigma, volRatio: null, thetaLow: 2.5 });
    console.log("v2 track OK:", s.expected_gap_pct, drift.dir);
    const { judgeDriftV21 } = await import("@/lib/g1a/t2plusV21");
    const { fetchBasketWindows, fetchP1Windows, fetchEventsTiered } = await import("@/lib/g1a/data");
    const [bw, p1w, ev] = await Promise.all([fetchBasketWindows(symbol), fetchP1Windows(), fetchEventsTiered()]);
    const d21 = judgeDriftV21({ basket: bw, dcNf: null, nfCumSign: 0, dcPm: null, basketSign: 0, p1: p1w, events: { ...ev, tier1: null }, macro: { dTnxBp: null, dFxPct: null, dWtiPct: null } });
    const s21 = buildShadowV2({ t: "dry", nfCutPct: nfClose ?? 0, beta: 1.316, drift: d21, sigma, volRatio: null, thetaLow: 2.5 });
    console.log("v21 track OK:", s21.expected_gap_pct, d21.dir);
  } catch (e) { console.log("v2/v21 track ERR:", e instanceof Error ? e.message : e); }

  // update 경로 (실제 쓰기 대신 no-op 필터로 에러만 관찰: 존재하지 않는 date 조건 → 0행 갱신)
  const upd = await admin.from("g1a_days").update({ t2: t2e }).eq("date", "1999-01-01").eq("symbol", symbol);
  console.log("update(no-op) error:", upd.error?.message ?? null);
}
main().catch((e) => { console.error("TOP ERR:", e); process.exit(1); });
