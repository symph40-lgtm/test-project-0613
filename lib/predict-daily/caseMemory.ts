// 일봉 정성 사례 메모리 1단계 (docs/predict-daily-case-memory.md, 사용자 승인 2026-07-28 —
// 일봉 문자 한정). 표시 전용: 판정·비중 불변, 모든 실패는 삼켜 문자 발송을 막지 않는다.
// 검색은 정량(정규화 거리 top-5), 해석이 정성 — 임베딩·벡터DB 불필요 (표본 수천 일).
// 2단계(점수 승격)는 60일 라이브 채점 후 실측 근거가 있을 때만 (환경 점수판 전례).

import { createAdminClient } from "@/lib/supabase/admin";

export type CaseFeatures = {
  ssGap: number | null; ssChg: number | null; // 삼전 당일 갭%·등락%
  hxGap: number | null; hxChg: number | null; // 하닉
  sox: number | null;    // 간밤 SOX %
  fxChg: number | null;  // 전일 환율 %
  y10pp: number | null;  // 전일 미 10Y 변화 %p
  dxyChg: number | null; // 간밤 DXY %
  envScore?: number | null; // 라이브 전용 (백필 없음 — 거리 계산엔 미사용)
};

export type CaseCause = { text: string; tags: string[] };

type CaseRow = {
  date: string;
  features: CaseFeatures;
  cause_text: string | null;
  cause_tags: string[] | null;
  next_ss: number | null;
  next_hx: number | null;
};

const TABLE = "predict_case_days";

// 당일 사례 저장 — cause는 있을 때만 갱신 (뒤 크론이 null로 덮지 않게)
export async function upsertCaseDay(date: string, features: CaseFeatures, cause: CaseCause | null): Promise<void> {
  try {
    const admin = createAdminClient();
    const row: Record<string, unknown> = { date, features, source: "live", updated_at: new Date().toISOString() };
    if (cause) { row.cause_text = cause.text; row.cause_tags = cause.tags; }
    const { error } = await admin.from(TABLE).upsert(row, { onConflict: "date" });
    if (error) return; // 마이그레이션 032 미적용 등 — 조용히 생략
  } catch { /* 표시 전용 — 실패 무시 */ }
}

// 익일 채점 — next_ss/next_hx 미기입 행을 일봉 종가로 채움 (service 채점 단계에서 호출)
export async function scoreCaseDays(symKey: "ss" | "hx", bars: { date: string; close: number }[]): Promise<void> {
  try {
    const admin = createAdminClient();
    const col = symKey === "ss" ? "next_ss" : "next_hx";
    const { data } = await admin.from(TABLE).select("date").is(col, null).order("date", { ascending: false }).limit(30);
    if (!data?.length) return;
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    for (const r of data as { date: string }[]) {
      const i = idx.get(r.date);
      if (i === undefined || i + 1 >= bars.length) continue;
      const next = (bars[i + 1].close / bars[i].close - 1) * 100;
      await admin.from(TABLE).update({ [col]: next, updated_at: new Date().toISOString() }).eq("date", r.date);
    }
  } catch { /* 실패 무시 */ }
}

// 유사 사례 top-5 문자 라인. 거리 차원 = [해당 종목 갭·등락, SOX, 환율, 10Y] 5차원 z-정규화
// 유클리드 (envScore·태그는 v1 미사용 — 백필분과 축 정합). 3차원 미만 겹치면 제외.
export async function similarCaseLine(
  symKey: "ss" | "hx",
  today: { date: string; gap: number | null; chg: number | null; sox: number | null; fxChg: number | null; y10pp: number | null },
): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data } = await admin.from(TABLE).select("date, features, cause_tags, next_ss, next_hx").lt("date", today.date);
    const rows = (data ?? []) as CaseRow[];
    const nextOf = (r: CaseRow) => (symKey === "ss" ? r.next_ss : r.next_hx);
    // 직전 7일 제외 (오늘과 겹치는 국면은 '사례'가 아니라 현재 진행분)
    const cutoff = new Date(new Date(`${today.date}T00:00:00Z`).getTime() - 7 * 86400e3).toISOString().slice(0, 10);
    const pool = rows.filter((r) => r.date < cutoff && nextOf(r) !== null && r.features);
    if (pool.length < 30) return "";

    const dims: ((f: CaseFeatures) => number | null)[] = symKey === "ss"
      ? [(f) => f.ssGap, (f) => f.ssChg, (f) => f.sox, (f) => f.fxChg, (f) => f.y10pp]
      : [(f) => f.hxGap, (f) => f.hxChg, (f) => f.sox, (f) => f.fxChg, (f) => f.y10pp];
    const todayV = [today.gap, today.chg, today.sox, today.fxChg, today.y10pp];
    // 차원별 표준편차 (풀 기준) — z-정규화
    const stds = dims.map((get) => {
      const vs = pool.map((r) => get(r.features)).filter((v): v is number => v !== null && isFinite(v));
      if (vs.length < 30) return null;
      const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
      const sd = Math.sqrt(vs.reduce((s, v) => s + (v - mean) ** 2, 0) / vs.length);
      return sd > 1e-6 ? sd : null;
    });

    const scored = pool
      .map((r) => {
        let d2 = 0, nd = 0;
        for (let k = 0; k < dims.length; k++) {
          const a = todayV[k], b = dims[k](r.features), sd = stds[k];
          if (a === null || b === null || !isFinite(a) || !isFinite(b) || sd === null) continue;
          d2 += ((a - b) / sd) ** 2;
          nd++;
        }
        return nd >= 3 ? { r, d: Math.sqrt(d2 / nd) } : null;
      })
      .filter((x): x is { r: CaseRow; d: number } => x !== null)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    if (scored.length < 3) return "";

    const nexts = scored.map((x) => nextOf(x.r)!);
    const avg = nexts.reduce((s, v) => s + v, 0) / nexts.length;
    const up = nexts.filter((v) => v > 0).length;
    const near = scored[0].r;
    const nearChg = symKey === "ss" ? near.features.ssChg : near.features.hxChg;
    const tagStr = near.cause_tags?.length ? `·${near.cause_tags.slice(0, 2).join("·")}` : "";
    return ` 유사${scored.length}건 익일 ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%·상승${up}/${scored.length}` +
      `(近 ${near.date.slice(2).replace(/-/g, ".")}${nearChg !== null ? ` ${nearChg >= 0 ? "+" : ""}${nearChg.toFixed(1)}` : ""}→${nextOf(near)! >= 0 ? "+" : ""}${nextOf(near)!.toFixed(1)}%${tagStr}).`;
  } catch {
    return ""; // 표시 전용 — 실패 시 라인 생략
  }
}
