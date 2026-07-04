// Supabase 저장/로드 — signal_ticks(장중 시계열)·signal_judgments(판정 로그)·signal_daily_features(피처·라벨).
// 쓰기는 service role(admin) 전용 (RLS에 쓰기 정책 없음). 서버 코드에서만 import할 것.

import { createAdminClient } from "@/lib/supabase/admin";
import type { DailyFeatureRow, IntradayTick, Judgment } from "./types";

// 30초 미만 간격 중복 적재 방지 (여러 클라이언트가 동시에 폴링해도 시계열이 과밀해지지 않게)
const MIN_TICK_GAP_MS = 30_000;

export async function appendTick(date: string, tick: IntradayTick): Promise<boolean> {
  const admin = createAdminClient();
  const { data: lastRows } = await admin
    .from("signal_ticks")
    .select("ts")
    .eq("date", date)
    .order("ts", { ascending: false })
    .limit(1);
  const lastTs = lastRows?.[0]?.ts ? new Date(lastRows[0].ts).getTime() : 0;
  if (Date.now() - lastTs < MIN_TICK_GAP_MS) return false;

  const { error } = await admin.from("signal_ticks").insert({
    date,
    ts: tick.ts,
    fut_px: tick.futPx,
    fut_chg: tick.futChg,
    k200_px: tick.k200Px,
    hynix_px: tick.hynixPx,
    hynix_chg: tick.hynixChg,
    samsung_px: tick.samsungPx,
    samsung_chg: tick.samsungChg,
    hynix_frgn: tick.hynixFrgn,
    samsung_frgn: tick.samsungFrgn,
    hynix_inst: tick.hynixInst,
    samsung_inst: tick.samsungInst,
    nikkei_chg: tick.nikkeiChg,
    twii_chg: tick.twiiChg,
    nq_chg: tick.nqChg,
    breadth: tick.breadth,
    basis: tick.basis,
  });
  return !error;
}

export async function loadTicks(date: string): Promise<IntradayTick[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("signal_ticks")
    .select("*")
    .eq("date", date)
    .order("ts", { ascending: true })
    .limit(1000);
  if (!data) return [];
  return data.map((r) => {
    const kst = new Date(new Date(r.ts).getTime() + 9 * 3600 * 1000);
    return {
      ts: r.ts,
      minuteOfDay: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
      futPx: r.fut_px,
      futChg: r.fut_chg,
      k200Px: r.k200_px,
      hynixPx: r.hynix_px,
      hynixChg: r.hynix_chg,
      samsungPx: r.samsung_px,
      samsungChg: r.samsung_chg,
      hynixFrgn: r.hynix_frgn,
      samsungFrgn: r.samsung_frgn,
      hynixInst: r.hynix_inst,
      samsungInst: r.samsung_inst,
      nikkeiChg: r.nikkei_chg,
      twiiChg: r.twii_chg,
      nqChg: r.nq_chg,
      breadth: r.breadth,
      basis: r.basis,
    };
  });
}

// 판정 스냅샷 로그 — 페이즈 전환·판정 변경 시에만 기록 (같은 판정 반복 저장 방지)
export async function logJudgment(j: Judgment): Promise<void> {
  const admin = createAdminClient();
  const { data: lastRows } = await admin
    .from("signal_judgments")
    .select("phase, day_type")
    .eq("date", j.date)
    .order("ts", { ascending: false })
    .limit(1);
  const prev = lastRows?.[0];
  if (prev && prev.phase === j.phase && prev.day_type === j.dayType) return;

  await admin.from("signal_judgments").insert({
    date: j.date,
    ts: j.ts,
    phase: j.phase,
    day_type: j.dayType,
    bias: j.bias,
    trend: j.trend,
    setups: j.setups,
    risk: j.risk,
    ext: j.ext,
  });
}

// daily_features 진행형 upsert — 판정 때마다 갱신, 장후 배치가 라벨 확정
export async function upsertDailyFeatures(j: Judgment, extra?: Record<string, unknown>): Promise<void> {
  const admin = createAdminClient();
  const row: Record<string, unknown> = {
    date: j.date,
    bias_0830: j.bias,
    nr7_flag: j.ext.nr7,
    nr4_ib_flag: j.ext.nr4Ib,
    open_type: j.trend?.openType ?? null,
    open_cross_count: j.trend?.openCrossCount ?? null,
    open_max_adverse: j.trend?.openMaxAdverse ?? null,
    breadth_10am: j.ext.breadth,
    breadth_divergence: j.ext.breadthDivergence,
    distortion_tag: j.ext.distortionTag,
    basis_slope_10am: j.ext.basisSlope,
    atr14_pct: j.risk.atr14Pct,
    stop_pct_used: j.risk.stopMode === "atr" && j.risk.stopAtrPct !== null ? j.risk.stopAtrPct : j.risk.stopFixedPct,
    stop_mode: j.risk.stopMode,
    dc1: j.trend?.dc1 ?? null,
    dc2: j.trend?.dc2 ?? null,
    ...extra,
  };
  // 판정 시각별 기록
  if (j.phase === "판정") row.judgment_0930 = j.dayType;
  if (j.phase === "관리" || j.phase === "마감") row.judgment_1030 = j.dayType;

  await admin.from("signal_daily_features").upsert(row, { onConflict: "date" });
}

export async function loadDailyFeatures(date: string): Promise<DailyFeatureRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("signal_daily_features")
    .select("*")
    .eq("date", date)
    .maybeSingle();
  return (data as DailyFeatureRow | null) ?? null;
}

export async function loadRecentFeatures(limit = 20): Promise<DailyFeatureRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("signal_daily_features")
    .select("*")
    .order("date", { ascending: false })
    .limit(limit);
  return (data as DailyFeatureRow[] | null) ?? [];
}

// 수동 주석 저장 (annotate API)
export async function saveAnnotation(date: string, fields: {
  cause_tag?: string | null;
  cause_note?: string | null;
  consensus_intact?: boolean | null;
  cause_non_earnings?: boolean | null;
}): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("signal_daily_features")
    .upsert({ date, ...fields }, { onConflict: "date" });
  return !error;
}
