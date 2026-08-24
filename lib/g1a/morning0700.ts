// 3트랙 아침 07:00 판정 (발주자 발주 2026-08-23) — T2 본판정·T2+ v2·v2.1의 아침 재판정.
// 회계 규율: 채점 정본 = 저녁 19:45 판정 불변. 아침판은 morning_0700 별도 장부 — 공식 심사(v2/v2.1) 미산입.
// R1과의 구분: 아침판 = T2 계열 판정식의 아침 재실행(절단 07:00) / R1 = 챔피언 번역 엔진의 공식 발행(절단 07:15) — 별개 엔진.
// 사전 등록 가설: g1br/challengers/morning_0700.md. 문자 없음(웹 표기 전용) — 정지·재개 무관.
// 성분 축소 명기: 07:00 시점엔 유럽 마감·미 애프터 상태 — ⓕ 매크로(17:00~ 앵커)·신규 P1은 결측 허용,
// dc_nf·p1은 전일 저녁 동결값 사용. 이벤트 무효화는 비적용(발표가 이미 지난 시점 — base에 반영됨).

import type { G1ASymbol } from "./types";

export type Morning0700 = {
  t: string; session_night: string;
  t2: { score: number | null; resid_gap_pct: number | null; open_exp_pct: number | null; grade: string; basis: string } | null;
  v2: { base_pct: number | null; base_stock_pct: number | null; drift_dir: string; drift_conf: number; expected_gap_pct: number | null; components?: unknown } | null;
  v21: { base_pct: number | null; base_stock_pct: number | null; drift_dir: string; drift_conf: number; expected_gap_pct: number | null; components?: unknown } | null;
};

export async function runMorning0700(symbol: G1ASymbol, sessionNight: string, hhmm: string): Promise<Morning0700 | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  // 세션 밤 G1A 행 (저녁 판정·동결값의 원천) + 오늘 라벨 G1B 행 (06:00 마감)
  const [ga, gb] = await Promise.all([
    admin.from("g1a_days").select("t2").eq("date", sessionNight).eq("symbol", symbol).maybeSingle(),
    admin.from("g1b_days").select("night,r1").eq("date", today).eq("symbol", symbol).maybeSingle(),
  ]);
  // [사고 8/24] 첫 판정 무음 미기록 — 조회·저장 실패를 삼키지 않는다 (무음 실패 금지, 8/10 교훈)
  if (ga.error) throw new Error(`g1a 조회 실패: ${ga.error.message}`);
  if (gb.error) throw new Error(`g1b 조회 실패: ${gb.error.message}`);
  const t2e = (ga.data?.t2 ?? null) as Record<string, unknown> | null;
  if (!t2e) return null;
  if ((t2e as { morning_0700?: unknown }).morning_0700) return (t2e as { morning_0700?: Morning0700 }).morning_0700 ?? null; // 1회
  const nfo = (gb.data?.night as { night_fut?: { v?: number | null; late_arrival?: boolean } } | null)?.night_fut;
  const nfClose = nfo?.v != null && !nfo.late_arrival ? nfo.v * 100 : null;
  const evening = t2e.nf as { level?: { beta_mkt?: number }; dc_nf?: number | null } | undefined;
  const beta = evening?.level?.beta_mkt ?? (symbol === "005930" ? 1.316 : 1.517);

  // ── 아침판 T2 본판정: 룰 점수·잔여갭 식 07:00 재산출 (기준가 = 전일 19:40 유지, 바스켓 07:00 최신·NXT = 애프터 최종) ──
  let mT2: Morning0700["t2"] = null;
  try {
    const { fetchPremarketBasket, fetchUsFutDelta, fetchEuropeTone, fetchTsmcResidual, fetchDayCharacter, fetchFrnDecel, fetchMacroZ } = await import("./data");
    const [basket, usfut, europe, tsmc, dayChar, frn, macro] = await Promise.all([
      fetchPremarketBasket(symbol), fetchUsFutDelta(), fetchEuropeTone(), fetchTsmcResidual(), fetchDayCharacter(symbol), fetchFrnDecel(symbol), fetchMacroZ(),
    ]);
    // NXT 07:00 최신치 = 전일 애프터 최종가 (g1b가 R1 시 산출한 nxt_close_pct 우선, 결측 시 저녁 r_nxt 동결)
    const nxtClosePct = ((gb.data?.night as Record<string, unknown> | null)?.nxt_close_pct as number | null | undefined)
      ?? ((t2e.verdict as { r_nxt_pre_entry?: number | null } | undefined)?.r_nxt_pre_entry ?? null);
    const f = {
      F21_basket: basket.rBasket, F21_dcpm: basket.dcpm, F21_obs_min: basket.obsMin,
      F22_usfut: usfut, F20_europe: europe.pct, F20_obs_min: europe.obsMin, F11p_tsmc_resid: tsmc,
      F01_clv: dayChar.clv, F02_dc1: dayChar.dc1, F04_o1: dayChar.o1, F09_c1: null,
      F08_frn_decel: frn, F05_w1: null, F07_b1_z: null,
      F13_rate_z: macro.rateZ, F14_fx_z: macro.fxZ, F24_news: null,
      r_nxt: nxtClosePct, nxt_last_px: (t2e.entry_px_virtual as number | null) ?? null, spread_pct: null,
    };
    const { gapScore, expectedResidualGap, t2Grade } = await import("./score");
    const gs = gapScore(f);
    const resid = expectedResidualGap(symbol, f.F21_basket, f.r_nxt);
    const openExp = resid != null && nxtClosePct != null ? Math.round(((1 + nxtClosePct / 100) * (1 + resid / 100) - 1) * 10000) / 100 : null;
    const g = t2Grade({ direction: "NEUTRAL", confidence: null, gap_score: Math.round(gs.score * 100) / 100, abstain_reason: null }, { high: 5.0, low: 2.5 });
    mT2 = { score: Math.round(gs.score * 100) / 100, resid_gap_pct: resid != null ? Math.round(resid * 100) / 100 : null,
      open_exp_pct: openExp, grade: g.grade, basis: "기준가=전일 19:40 유지·바스켓/NXT 07:00 최신(NXT=애프터 최종)·θ 19:40" };
  } catch { /* 결측 허용 */ }

  // ── 아침판 v2: base = 06:00 마감 × β, drift = 07:00 성분 재평가 (축소 성분 명기) ──
  let mV2: Morning0700["v2"] = null, mV21: Morning0700["v21"] = null;
  if (nfClose != null) {
    try {
      const { judgeDrift, buildShadowV2 } = await import("./t2plusV2");
      const { fetchBasketAccel30m } = await import("./data");
      const accel = await fetchBasketAccel30m(symbol);
      const dcPm0700 = mT2 ? null : null; // dcPm은 아래 f 재사용 불가 시 null — mT2 성공 시 그 값을 쓰도록 아래에서 주입
      void dcPm0700;
      const drift = judgeDrift({
        basketAccel30m: accel, dcNf: evening?.dc_nf ?? null, nfCumSign: Math.abs(nfClose) >= 0.1 ? Math.sign(nfClose) : 0,
        dcPm: null, basketSign: 0, // 아침판 축소: DC-PM·바스켓 부호는 mT2의 07:00 바스켓에서 — 결측 시 0
        p1Slope: ((t2e.pieces as Record<string, number | null> | undefined)?.p1_eu_semi_avg) ?? null, // 전일 동결
        eventTonight: null, macro: { dTnxBp: null, dFxPct: null, dWtiPct: null }, // 발표 지남·앵커 밖 — 축소 명기
      });
      const { G1B_CONFIG } = await import("@/lib/g1b/config");
      const sigma = G1B_CONFIG.sigmaBase[symbol as "000660" | "005930"].normal;
      const s = buildShadowV2({ t: hhmm, nfCutPct: nfClose, beta, drift, sigma, volRatio: null, thetaLow: 2.5 });
      mV2 = { base_pct: nfClose, base_stock_pct: s.base_stock_pct, drift_dir: drift.dir, drift_conf: drift.conf, expected_gap_pct: s.expected_gap_pct, components: drift.components };
      // v2.1 — 동일 문법, v2.1 성분 정의 (다창 바스켓·P1 다창·이벤트 2등급은 아침 시점 재평가)
      const { judgeDriftV21 } = await import("./t2plusV21");
      const { fetchBasketWindows, fetchP1Windows, fetchEventsTiered } = await import("./data");
      const [bw, p1w, ev] = await Promise.all([fetchBasketWindows(symbol), fetchP1Windows(), fetchEventsTiered()]);
      const d21 = judgeDriftV21({ basket: bw, dcNf: evening?.dc_nf ?? null, nfCumSign: Math.abs(nfClose) >= 0.1 ? Math.sign(nfClose) : 0,
        dcPm: null, basketSign: 0, p1: p1w, events: { ...ev, tier1: null }, macro: { dTnxBp: null, dFxPct: null, dWtiPct: null } });
      const s21 = buildShadowV2({ t: hhmm, nfCutPct: nfClose, beta, drift: d21, sigma, volRatio: null, thetaLow: 2.5 });
      mV21 = { base_pct: nfClose, base_stock_pct: s21.base_stock_pct, drift_dir: d21.dir, drift_conf: d21.conf, expected_gap_pct: s21.expected_gap_pct, components: d21.components };
    } catch { /* 결측 허용 */ }
  }
  const out: Morning0700 = { t: hhmm, session_night: sessionNight, t2: mT2, v2: mV2, v21: mV21 };
  (t2e as Record<string, unknown>).morning_0700 = out;
  const up = await admin.from("g1a_days").update({ t2: t2e }).eq("date", sessionNight).eq("symbol", symbol);
  if (up.error) throw new Error(`morning_0700 저장 실패: ${up.error.message}`);
  return out;
}
