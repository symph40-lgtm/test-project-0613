// 야간선물 오염 기록 소급 정정 (발주자 판정 2026-08-15 §2ⓐⓑ) — 1회성 실행 스크립트 (증거 보존용 커밋)
//   npx tsx scripts/g1-nf-correct-0815.ts
//
// 대상: 라이브 소스 결함(시장구분 F = 주간 전일 등락률) 기간의 기록 전부 — src "(F)" 규칙 선별.
//   실측 오염값: 8/12 +1.10(=주간 8/11)·8/13 +4.60(=주간 8/12)·8/14 +3.71(=주간 8/13) — 전점 일치 확인.
// 정본: KRX 정보데이터시스템 MDCSTAT12902 야간 세션 (T+1 라벨), g1br/data/nightfut_u1.parquet 산출·
//   KIS CM 교차 일치 검증분 (T7_U1_REPORT §1). 아래 상수는 그 산출값의 사본 (재현 경로: fetch_night_krx.py).
// 원칙: corrected=true + 원기록(orig) 보존. 본판정 무접촉 — night_fut은 관측 전용(Hedge 가중 0)이었음.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// KRX 정본 u1 (라벨일 기준 %) — nightfut_u1 산출값
const KRX_U1: Record<string, number> = { "2026-08-12": 1.2831, "2026-08-13": 3.2889, "2026-08-14": 2.0210 };
// KRX 정본 세션 시가 근사 (저녁 18:05 스냅샷 정정용): 세션 시가/주간 종가 − 1 (%)
// 8/13 저녁(라벨 8/14 세션): 1066.00/1073.70 = -0.72 / 8/14 저녁(라벨 8/18 세션): 1101.00/1098.90 = +0.19
const KRX_EVE_OPEN: Record<string, number> = { "2026-08-13": -0.72, "2026-08-14": 0.19 };
const BETA_MKT: Record<string, number> = { "000660": 1.517, "005930": 1.316 }; // kalman.beta_mkt (init 고정 — dailyUpdate 미갱신 확인)
const CORRECTION_TAG = "KRX 정본 소급 정정 12902·T+1 (발주자 판정 8/15 ⓐ)";

async function main() {
  const { createAdminClient } = await import("../lib/supabase/admin");
  const admin = createAdminClient();

  // ── ⓐ g1b_days.night.night_fut — src "(F)" 전 행 정정 ──
  const { data: bRows } = await admin.from("g1b_days").select("date,symbol,night,r1").gte("date", "2026-08-10");
  for (const r of bRows ?? []) {
    const night = (r.night ?? {}) as Record<string, Record<string, unknown>>;
    const nf = night.night_fut;
    if (!nf || typeof nf.src !== "string" || !nf.src.includes("(F)") || nf.corrected) continue;
    const u1 = KRX_U1[r.date as string];
    if (u1 == null) { console.log(`SKIP ${r.date} ${r.symbol} — 정본값 없음`); continue; }
    night.night_fut = {
      v: Math.round(u1 * 1e6) / 1e8, src: CORRECTION_TAG, fetch_ts: nf.fetch_ts, late_arrival: false,
      corrected: true, corrected_at: new Date().toISOString(), orig: { v: nf.v, src: nf.src },
    };
    // r1 3자 대조 재료: 오염 night_fut_ref의 정본 환산치 병기 (원기록 experts는 불변 보존)
    const r1 = (r.r1 ?? null) as Record<string, unknown> | null;
    if (r1) r1.night_fut_ref_corrected = { v: Math.round(u1 * BETA_MKT[r.symbol as string] * 100) / 100, basis: CORRECTION_TAG };
    const { error } = await admin.from("g1b_days").update({ night, r1, updated_at: new Date().toISOString() })
      .eq("date", r.date).eq("symbol", r.symbol);
    console.log(`g1b ${r.date} ${r.symbol}: night_fut ${(nf.v as number) * 100}% → ${u1}% ${error ? "실패 " + error.message : "OK"}`);
  }

  // ── ⓐⓑ g1a_days.t2 — nf_evening 정정 + 섀도·모자이크 재채점 (rescored, 원기록 보존) ──
  const { data: aRows } = await admin.from("g1a_days").select("date,symbol,t2,labels").in("date", Object.keys(KRX_EVE_OPEN));
  for (const r of aRows ?? []) {
    const t2 = (r.t2 ?? null) as Record<string, unknown> | null;
    if (!t2) continue;
    const eve = KRX_EVE_OPEN[r.date as string];
    const nfe = t2.nf_evening as { t?: string; pct?: number; corrected?: boolean } | undefined;
    if (nfe && !nfe.corrected) {
      t2.nf_evening = { t: nfe.t, pct: eve, corrected: true, basis: "KRX 세션 시가 근사 — " + CORRECTION_TAG, orig: { pct: nfe.pct } };
    }
    if (t2.nf_evening_snaps && !t2.nf_evening_snaps_note) {
      t2.nf_evening_snaps_note = "오염(주간 등락률·4점 동일값) — 일중 야간 경로 미보유로 값 정정 불가, 원기록 보존 (판정 8/15 ⓐ)";
    }
    // ⓑ 재채점 — 그 밤의 등록 로직(구판: w_nf 1.0 고정, tanh(pct/0.4)) 그대로, 입력만 정본 근사로 교체
    const gs = (t2.verdict as { gap_score?: number } | undefined)?.gap_score;
    if (gs != null) {
      const s = Math.round((gs + 1.0 * Math.tanh(eve / 0.4)) * 100) / 100;
      const dir = s >= 0.5 ? "UP" : s <= -0.5 ? "DOWN" : null;
      const L1 = (r.labels as { L1?: number | null } | null)?.L1 ?? null;
      const hit = dir && L1 != null && Math.abs(L1) >= 0.3 ? (dir === "UP") === (L1 > 0) : null;
      t2.shadow = {
        ...(t2.shadow as Record<string, unknown> ?? {}),
        rescored: { score: s, dir: dir ?? "NEUTRAL", grade: dir ? "Lean" : "Flat", hit, basis: "정본 세션 시가 근사 재채점 (판정 8/15 ⓑ)", logic: "구판(w_nf 1.0 고정)" },
      };
      const p1 = (t2.pieces as { p1_eu_semi_avg?: number | null } | undefined)?.p1_eu_semi_avg;
      if (p1 != null) {
        const m = Math.round((s + 0.75 * Math.tanh(p1 / 0.5)) * 100) / 100;
        const md = m >= 0.5 ? "UP" : m <= -0.5 ? "DOWN" : null;
        t2.mosaic = { ...(t2.mosaic as Record<string, unknown> ?? {}), rescored: { score: m, dir: md ?? "NEUTRAL", hit: md && L1 != null && Math.abs(L1) >= 0.3 ? (md === "UP") === (L1 > 0) : null } };
      }
    }
    const { error } = await admin.from("g1a_days").update({ t2 }).eq("date", r.date).eq("symbol", r.symbol);
    console.log(`g1a ${r.date} ${r.symbol}: nf_evening → ${eve}% · 섀도 재채점 ${error ? "실패 " + error.message : "OK"}`);
  }
  console.log("완료 — 정정 요약은 g1br/reports/NF_RECONCILE_2026-08-15.md 참조");
}
main();
