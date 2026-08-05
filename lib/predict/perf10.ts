// 신모델 vs 기존 피셔 계층 10일 성능 평가 (사용자 지시 2026-08-06 "SOXX·삼전·하닉 신모델과 기존
// 피셔(F/M/본) 계속 성능평가해서 10일 뒤에 알려줘") — 평가창 8/6~8/16, 보고 8/17(월) 11시 문자.
// 데이터 원천 (전부 기존 스트림이 매일 적재 — 이 모듈은 읽기·집계만):
//   하이닉스: ops_settings predict_nm_cmp — l93(신모델 0930 사다리) vs hier(현행 계층 20/30/50) 일별
//   삼성전자: predict_ssv2_scores(신모델 p) vs predict_track_days(005930·reg — 계층 F/M/본 판정×r_oc 프록시)
//   SOXX: uspredict_v2_scores(주기준 p·구사양 pNP) vs us_predict_days(첫 방향 판정×r_oc 프록시)
// ⚠프록시 주의: 계층 쪽은 '첫 방향 판정 후 시가→종가 부호' 근사(스탑·지침 미반영) — 방향 성능 비교용.
// 10일 표본은 참고 수준(운 지배) — 승격/폐지 판단은 60일 채점이 담당. 보고 후에도 매일 적재는 계속되므로
// 이 함수는 언제든 재실행 가능(perf10_state 삭제 시 재발송).

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";

const FROM = "2026-08-06", TO = "2026-08-16", REPORT_FROM = "2026-08-17";
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

export async function runPerf10Report(): Promise<void> {
  try {
    const kst = new Date(Date.now() + 9 * 3600e3);
    const today = kst.toISOString().slice(0, 10);
    const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (today < REPORT_FROM || kstMin < 11 * 60 || kstMin > 11 * 60 + 30) return;
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (dow < 1 || dow > 5) return;
    const admin = createAdminClient();
    const { data: doneRow } = await admin.from("ops_settings").select("value").eq("key", "perf10_state").maybeSingle();
    if ((doneRow?.value as { done?: boolean } | null)?.done) return;

    const inWin = (d: string) => d >= FROM && d <= TO;

    // 하이닉스 — nm_cmp (신모델 l93 vs 계층 hier)
    const { data: cmpRow } = await admin.from("ops_settings").select("value").eq("key", "predict_nm_cmp").maybeSingle();
    const cmp = (Array.isArray(cmpRow?.value) ? (cmpRow!.value as { date: string; l93: number; hier: number }[]) : []).filter((r) => inWin(r.date));
    const hxNew = cmp.reduce((a, r) => a + (r.l93 ?? 0), 0);
    const hxOld = cmp.reduce((a, r) => a + (r.hier ?? 0), 0);

    // 삼성전자 — ssv2 p vs track_days 계층 프록시
    const { data: ssRow } = await admin.from("ops_settings").select("value").eq("key", "predict_ssv2_scores").maybeSingle();
    const ssSc = (Array.isArray(ssRow?.value) ? (ssRow!.value as { date: string; p: number }[]) : []).filter((r) => inWin(r.date));
    const ssNew = ssSc.reduce((a, r) => a + (r.p ?? 0), 0);
    const { data: trk } = await admin
      .from("predict_track_days").select("date, model, verdict, r_oc")
      .eq("symbol", "005930").eq("session", "reg").gte("date", FROM).lte("date", TO).limit(500);
    const W: Record<string, number> = { fisherf: 0.2, fisherm: 0.3, fisher: 0.5 };
    let ssOld = 0;
    for (const r of (trk ?? []) as { model: string; verdict: string; r_oc: number | null }[]) {
      const w = W[r.model];
      if (!w || r.r_oc == null) continue;
      ssOld += w * (r.verdict === "leverage" ? r.r_oc : r.verdict === "inverse" ? -r.r_oc : 0);
    }

    // SOXX — usv2 p(주기준)·pNP vs us_predict_days 첫 방향 프록시
    const { data: usRow } = await admin.from("ops_settings").select("value").eq("key", "uspredict_v2_scores").maybeSingle();
    const usSc = (Array.isArray(usRow?.value) ? (usRow!.value as { date: string; p: number; pNP?: number; pend?: boolean }[]) : []).filter((r) => inWin(r.date));
    const usNew = usSc.reduce((a, r) => a + (r.p ?? 0), 0);
    const usPend = usSc.some((r) => r.pend);
    const { data: usd } = await admin
      .from("us_predict_days").select("date, revisions, r_oc").gte("date", FROM).lte("date", TO).limit(50);
    let usOld = 0;
    for (const r of (usd ?? []) as { revisions: { verdict: string }[] | null; r_oc: number | null }[]) {
      const first = (r.revisions ?? []).find((v) => v.verdict !== "none");
      if (!first || r.r_oc == null) continue;
      usOld += first.verdict === "leverage" ? r.r_oc : -r.r_oc;
    }

    const line = (nm: string, a: number, b: number, n: number) =>
      `${nm}: 신모델 ${s2(a)}%p vs 기존 ${s2(b)}%p (${n}일) → ${a >= b ? "신모델 우위 " + s2(a - b) : "기존 우위 " + s2(b - a)}`;
    const text = `[신모델 10일 평가] 8/6~8/16 실측 (사용자 지시 8/6)\n▶정보 — 판단 변경 없음 (승격·폐지는 60일 채점 기준)\n----\n${line("하이닉스", hxNew, hxOld, cmp.length)}\n${line("삼성전자", ssNew, ssOld, ssSc.length)}\n${line("SOXX", usNew, usOld, usSc.length)}${usPend ? " ⚠1박 미확정 포함" : ""}\n주의: 기존 쪽은 첫 방향 판정×시가→종가 프록시(스탑 미반영)·10일 표본은 운 지배 — 추세 참고용. 다음 평가는 60일 채점.`;
    try {
      await dispatchToChannels("signal", today, { key: "nm_perf10", severity: "medium", text, smsSubject: "신모델 10일 평가" }, undefined, undefined, { dedupHours: 16 });
    } catch { /* 발송 실패 무시 */ }
    await admin.from("ops_settings").upsert({ key: "perf10_state", value: { done: true, date: today }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  } catch { /* 평가 실패는 본 흐름을 막지 않는다 */ }
}
