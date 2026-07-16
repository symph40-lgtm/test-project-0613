// 예측 모델 저장/로드 — predict_model_days(모델별 판정·채점)·predict_days(앙상블).
// 쓰기는 service role 전용. 서버 코드에서만 import할 것.

import { createAdminClient } from "@/lib/supabase/admin";
import type { AccuracyStat, EnsembleResult, ModelId, ModelOutput, Verdict } from "./types";
import { MODEL_IDS, emptyStat } from "./types";

export type Revision = { at: string; verdict: Verdict; strength: number };

export type PredictDayRow = {
  date: string;
  label: Verdict | null;
  r_oc: number | null;
  final_verdict: Verdict;
  strength: number;
  stage: "early" | "final";
  early_verdict: Verdict | null;
  early_strength: number | null;
  revisions: Revision[] | null;
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

// 누적 성적 (채점 완료분 전체 — 백테스트 시딩분 포함). 리프트 가중치용 분포 포함
export async function loadAccuracyStats(): Promise<Record<ModelId, AccuracyStat>> {
  const admin = createAdminClient();
  const stats = Object.fromEntries(MODEL_IDS.map((m) => [m, emptyStat()])) as Record<ModelId, AccuracyStat>;
  const { data } = await admin
    .from("predict_model_days")
    .select("model, verdict, label, correct")
    .not("correct", "is", null)
    .limit(20000);
  for (const row of data ?? []) {
    const m = row.model as ModelId;
    const v = row.verdict as Verdict;
    const l = row.label as Verdict;
    if (!stats[m] || !(v in stats[m].verdicts) || !(l in stats[m].labels)) continue;
    stats[m].total += 1;
    stats[m].verdicts[v] += 1;
    stats[m].labels[l] += 1;
    if (row.correct) stats[m].correct += 1;
  }
  return stats;
}

export async function hasJudgment(date: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin.from("predict_days").select("date").eq("date", date).limit(1);
  return Boolean(data && data.length > 0);
}

export async function loadDayRow(date: string): Promise<PredictDayRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("predict_days")
    .select("date, label, r_oc, final_verdict, strength, stage, early_verdict, early_strength, revisions, weights, model_verdicts, source")
    .eq("date", date)
    .maybeSingle();
  return (data as PredictDayRow | null) ?? null;
}

// 조기 판정(09:31) 저장 / 모니터링 구간(~10:30) 판정 변경 누적.
// final_verdict에는 잠정값을 넣고 stage='early' — 10:31 확정 시 saveJudgment가 덮어쓴다.
export async function saveEarlyJudgment(
  date: string,
  verdict: Verdict,
  strengthPct: number,
  prior: PredictDayRow | null,
): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  if (!prior) {
    await admin.from("predict_days").upsert(
      {
        date,
        final_verdict: verdict,
        strength: strengthPct,
        stage: "early",
        early_verdict: verdict,
        early_strength: strengthPct,
        early_at: nowIso,
        revisions: [{ at: nowIso, verdict, strength: strengthPct }],
        source: "live",
      },
      { onConflict: "date" },
    );
    return;
  }
  const revs = prior.revisions ?? [];
  const last = revs[revs.length - 1];
  if (last && last.verdict === verdict) return; // 판정 유지 — 기록 없음
  await admin
    .from("predict_days")
    .update({
      final_verdict: verdict,
      strength: strengthPct,
      revisions: [...revs, { at: nowIso, verdict, strength: strengthPct }],
    })
    .eq("date", date);
}

export async function saveJudgment(
  date: string,
  outputs: ModelOutput[],
  final: { finalVerdict: Verdict; strengthPct: number },
  ens: EnsembleResult, // 참고 기록 — 가중치 스냅샷 + 앙상블 판정(_ensemble 키)
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
  const verdicts: Record<string, string> = Object.fromEntries(outputs.map((o) => [o.model, o.verdict]));
  verdicts._ensemble = ens.finalVerdict; // 앙상블 참고 판정 (피셔 단독 모드에서의 대조용)
  await admin.from("predict_days").upsert(
    {
      date,
      final_verdict: final.finalVerdict,
      strength: final.strengthPct,
      stage: "final", // 조기(early) 행이 있으면 확정으로 전환 — early_*·revisions는 보존
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
    .select("date, label, r_oc, final_verdict, strength, stage, early_verdict, early_strength, revisions, weights, model_verdicts, source")
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
