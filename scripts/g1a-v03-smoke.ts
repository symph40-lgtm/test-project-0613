// G1A v0.3 스모크 — 수집기·판정 엔진·서비스 경로가 크래시 없이 도는지 확인:
//   npx tsx scripts/g1a-v03-smoke.ts
// 주말·장외 시각엔 대부분 null이 정상이다 — 여기서 보는 건 값이 아니라 결측 내성이다.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { fetchPremarketBasket, fetchUsFutDelta, fetchEuropeTone, fetchTsmcResidual, fetchDayCharacter, fetchFrnDecel, fetchMacroZ, fetchNxtState, fetchCircuitBreaker, fetchEventTonight } = await import("../lib/g1a/data");
  const { evaluateT2, isExpiryDay } = await import("../lib/g1a/score");

  const basket = await fetchPremarketBasket("000660");
  const [usfut, eu, tsmc, dayChar, frn, macro, cb, ev] = await Promise.all([
    fetchUsFutDelta(), fetchEuropeTone(), fetchTsmcResidual(), fetchDayCharacter("000660"),
    fetchFrnDecel("000660"), fetchMacroZ(), fetchCircuitBreaker(), fetchEventTonight(),
  ]);
  const nxt = await fetchNxtState("000660", dayChar.regClose);
  console.log("수집기:", JSON.stringify({ basket, usfut, eu, tsmc, dayChar, frn, macro, nxt, cb, ev }, null, 1));

  const f = {
    F21_basket: basket.rBasket, F21_dcpm: basket.dcpm, F21_obs_min: basket.obsMin,
    F22_usfut: usfut, F20_europe: eu.pct, F20_obs_min: eu.obsMin, F11p_tsmc_resid: tsmc,
    F01_clv: dayChar.clv, F02_dc1: dayChar.dc1, F04_o1: dayChar.o1, F09_c1: null,
    F08_frn_decel: frn, F05_w1: null, F07_b1_z: null,
    F13_rate_z: macro.rateZ, F14_fx_z: macro.fxZ, F24_news: null,
    r_nxt: nxt.rNxt, nxt_last_px: nxt.lastPx, spread_pct: null,
  };
  const ctx = { dateKst: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), weekday: new Date(Date.now() + 9 * 3600e3).getUTCDay(), eventTonight: ev, impliedMoveRatio: null, circuitBreaker: cb, expiryToday: isExpiryDay(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)) };
  console.log("\n판정(18:00 가정):", JSON.stringify(evaluateT2("000660", f, ctx, "18:00", false, false)));
  console.log("판정(19:40 최종):", JSON.stringify(evaluateT2("000660", f, ctx, "19:40", true, false)));

  const { runG1AService } = await import("../lib/g1a/service");
  console.log("\n서비스:", JSON.stringify(await runG1AService()));
}
main();
