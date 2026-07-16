// 예측 모델 저장/로드 — predict_model_days(모델별 판정·채점)·predict_days(앙상블).
// 쓰기는 service role 전용. 서버 코드에서만 import할 것.

import { createAdminClient } from "@/lib/supabase/admin";
import type { AccuracyStat, EnsembleResult, ModelId, ModelOutput, Verdict } from "./types";
import { MODEL_IDS } from "./types";

export type PredictDayRow = {
  date: string;
  label: Verdict | null;
  r_oc: number | null;
  final_verdict: Verdict;
  strength: number;
  weights: Record<ModelId, number> | null;
  model_verdicts: Record<ModelId, Verdict> | null;
  source: string;
};

export type PredictModelRow = {
  date: string;
  model: ModelId;
  verdict: Verdict;
  confidence: number | null;
  reason: string | null;
  label: Verdict | null;
  correct: boolean | null;
};

// 마이그레이션 026 적용 여부 — 페이지가 안내 문구를 띄우기 위한 프로브
export async function predictTablesReady(): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("predict_days").select("date").limit(1);
  return !error;
}

// 누적 정확도 (채점 완료분 전체 — 백테스트 시딩분 포함)
export async function loadAccuracyStats(): Promise<Record<ModelId, AccuracyStat>> {
  const admin = createAdminClient();
  const stats = Object.fromEntries(MODEL_IDS.map((m) => [m, { correct: 0, total: 0 }])) as Record<ModelId, AccuracyStat>;
  const { data } = await admin
    .from("predict_model_days")
    .select("model, correct")
    .not("correct", "is", null)
    .limit(20000);
  for (const row of data ?? []) {
    const m = row.model as ModelId;
    if (!stats[m]) continue;
    stats[m].total += 1;
    if (row.correct) stats[m].correct += 1;
  }
  return stats;
}

export async function hasJudgment(date: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin.from("predict_days").select("date").eq("date", date).limit(1);
  return Boolean(data && data.length > 0);
}

export async function saveJudgment(
  date: string,
  outputs: ModelOutput[],
  ens: EnsembleResult,
  source: "live" | "backfill",
): Promise<void> {
  const admin = createAdminClient();
  const modelRows = outputs.map((o) => ({
    date,
    model: o.model,
    verdict: o.verdict,
    confidence: o.confidence,
    reason: o.reason,
    source,
  }));
  await admin.from("predict_model_days").upsert(modelRows, { onConflict: "date,model" });
  const verdicts = Object.fromEntries(outputs.map((o) => [o.model, o.verdict]));
  await admin.from("predict_days").upsert(
    {
      date,
      final_verdict: ens.finalVerdict,
      strength: ens.strengthPct,
      weights: ens.weights,
      model_verdicts: verdicts,
      source,
    },
    { onConflict: "date" },
  );
}

// 장 마감 후 채점 — 라벨 확정 + 모델별 correct 갱신
export async function scoreDay(date: string, label: Verdict, rOC: number): Promise<void> {
  const admin = createAdminClient();
  const { data: rows } = await admin.from("predict_model_days").select("model, verdict").eq("date", date);
  for (const row of rows ?? []) {
    await admin
      .from("predict_model_days")
      .update({ label, correct: row.verdict === label })
      .eq("date", date)
      .eq("model", row.model);
  }
  await admin
    .from("predict_days")
    .update({ label, r_oc: rOC, labeled_at: new Date().toISOString() })
    .eq("date", date);
}

// 미채점일 목록 (판정은 있는데 라벨 없음)
export async function listUnscoredDates(beforeDate: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("predict_days")
    .select("date")
    .is("label", null)
    .lt("date", beforeDate)
    .order("date", { ascending: true })
    .limit(30);
  return (data ?? []).map((r) => String(r.date));
}

export async function loadRecentDays(n: number): Promise<PredictDayRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("predict_days")
    .select("date, label, r_oc, final_verdict, strength, weights, model_verdicts, source")
    .order("date", { ascending: false })
    .limit(n);
  return (data ?? []) as PredictDayRow[];
}

export async function loadModelRows(dates: string[]): Promise<PredictModelRow[]> {
  if (dates.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from("predict_model_days")
    .select("date, model, verdict, confidence, reason, label, correct")
    .in("date", dates);
  return (data ?? []) as PredictModelRow[];
}
