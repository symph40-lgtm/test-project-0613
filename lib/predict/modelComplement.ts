// 대가 모델 분야별 보완 모니터 (사용자 지시 2026-08-06 "신모델과 대가 모델의 인버스/레버/무추세
// 영역별 보완 가능성을 모니터링해서 가능하면 승격") — scripts/model-class-analysis.ts(233일)에서 나온
// 가설 셀을 여기 '고정'하고(선택 편향 방지 — 새 셀 추가 금지), 매일 라이브 누적으로 재계산.
// ①동의 필터: 피셔(신모델 심판 계열) 방향 판정에 특정 모델 동의 여부 → 적중률 격차 유지되는가
// ②인버스 오버라이드: "모델 M이 인버스 판정 시 채택" 하이브리드 → 손익 프록시 우위 유지되는가
// 발견 시점 기준치(233일): m7 동의 레버 91 vs 57 · dalton 동의 레버 87 vs 61 · raschke 동의 레버 74/인버 72
// vs 55/51 · 오버라이드 crabel 인버 +35.8 · m7 인버 +29.1 · raschke 인버 +27.2%p.
// 승격 기준(고정): 발견 이후 신규 축적 60일에서 ①동의 격차 ≥15%p·동의 표본 ≥15건 ②오버라이드
// 프록시 ≥ +5%p·3분류 적중 -2%p 이내 → 결정 통지 문자(무응답=현행 유지 — decision-notify 관례).
// 보고: 금요일 15:33~50 주간 요약 문자(predict_nm_comp — 실전 제목). 기록: ops_settings nm_complement.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";

type V = "leverage" | "inverse" | "none";
type MRow = { date: string; model: string; verdict: V; label: V | null };
const BASELINE_FROM = "2026-08-06"; // 가설 고정일 — 승격 판정은 이날 이후 신규 데이터만
const K: Record<V, string> = { leverage: "레버", inverse: "인버", none: "무추세" };

const AGREE_CELLS: { model: string; cls: V }[] = [
  { model: "m7", cls: "leverage" }, { model: "dalton", cls: "leverage" },
  { model: "raschke", cls: "leverage" }, { model: "raschke", cls: "inverse" }, { model: "m7", cls: "inverse" },
];
const OVERRIDE_MODELS = ["crabel", "m7", "raschke"]; // 인버스 오버라이드 후보 (고정)

export async function runModelComplementMonitor(): Promise<void> {
  try {
    const kst = new Date(Date.now() + 9 * 3600e3);
    const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const today = kst.toISOString().slice(0, 10);
    if (kstMin < 15 * 60 + 33 || kstMin > 15 * 60 + 55) return;
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (dow < 1 || dow > 5) return;

    const admin = createAdminClient();
    const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "nm_complement").maybeSingle();
    const prev = (stRow?.value ?? null) as { date?: string } | null;
    if (prev?.date === today) return; // 1일 1회

    const { data: rowsRaw } = await admin
      .from("predict_model_days").select("date, model, verdict, label")
      .gte("date", BASELINE_FROM).order("date", { ascending: true }).limit(3000);
    const rows = ((rowsRaw ?? []) as MRow[]).filter((r) => r.label !== null);
    const { data: dRows } = await admin
      .from("predict_days").select("date, r_oc").gte("date", BASELINE_FROM).limit(500);
    const rocBy = new Map(((dRows ?? []) as { date: string; r_oc: number | null }[]).map((d) => [d.date, d.r_oc]));

    const byModel = new Map<string, MRow[]>();
    for (const r of rows) { const a = byModel.get(r.model) ?? []; a.push(r); byModel.set(r.model, a); }
    const fisher = byModel.get("fisher") ?? [];
    const nDays = new Set(fisher.map((r) => r.date)).size;

    const pnlOf = (list: MRow[]): number => {
      let s = 0;
      for (const r of list) {
        const roc = rocBy.get(r.date);
        if (roc == null) continue;
        if (r.verdict === "leverage") s += roc; else if (r.verdict === "inverse") s -= roc;
      }
      return s;
    };
    const acc3 = (list: MRow[]): number => (list.length ? Math.round((100 * list.filter((r) => r.verdict === r.label).length) / list.length) : 0);

    const lines: string[] = [];
    let promoted = 0;
    // ① 동의 필터
    for (const { model, cls } of AGREE_CELLS) {
      const mb = new Map((byModel.get(model) ?? []).map((r) => [r.date, r]));
      const days = fisher.filter((r) => r.verdict === cls && mb.has(r.date));
      const agree = days.filter((r) => mb.get(r.date)!.verdict === cls);
      const dis = days.filter((r) => mb.get(r.date)!.verdict !== cls);
      const a = agree.length ? Math.round((100 * agree.filter((r) => r.label === cls).length) / agree.length) : null;
      const d = dis.length ? Math.round((100 * dis.filter((r) => r.label === cls).length) / dis.length) : null;
      if (a === null || d === null) continue;
      const gap = a - d;
      const ok = agree.length >= 15 && gap >= 15;
      if (ok) promoted++;
      lines.push(`${ok ? "★" : "·"}동의필터 ${model}×${K[cls]}: 동의 ${a}%(${agree.length}) vs 비동의 ${d}% (격차 ${gap})`);
    }
    // ② 인버스 오버라이드
    const fAcc = acc3(fisher), fPnl = pnlOf(fisher);
    for (const m of OVERRIDE_MODELS) {
      const mb = new Map((byModel.get(m) ?? []).map((r) => [r.date, r]));
      const hybrid = fisher.map((f) => (mb.get(f.date)?.verdict === "inverse" ? { ...f, verdict: "inverse" as V } : f));
      const hAcc = acc3(hybrid), hPnl = pnlOf(hybrid);
      const ok = nDays >= 60 && hPnl - fPnl >= 5 && hAcc - fAcc >= -2;
      if (ok) promoted++;
      lines.push(`${ok ? "★" : "·"}인버 오버라이드 ${m}: 프록시 ${(hPnl - fPnl >= 0 ? "+" : "")}${(hPnl - fPnl).toFixed(1)}%p·적중 ${hAcc - fAcc >= 0 ? "+" : ""}${hAcc - fAcc}`);
    }

    const value = { date: today, nDays, lines, promoted };
    await admin.from("ops_settings").upsert({ key: "nm_complement", value, updated_at: new Date().toISOString() }, { onConflict: "key" });

    // 문자: 금요일 주간 요약 or 승격 기준 충족(60일 이후) 즉시
    const promoteReady = promoted > 0 && nDays >= 60;
    if (dow === 5 || promoteReady) {
      try {
        await dispatchToChannels("signal", today, {
          key: promoteReady ? "predict_nm_comp_promote" : "predict_nm_comp",
          severity: promoteReady ? "medium" : "low",
          text: promoteReady
            ? `[신모델 보완 승격 제안] 대가 모델 분야별 보완 기준 충족 (누적 ${nDays}일)\n▶다음 세션에서 반영 여부 회신 — 무응답=현행 유지\n----\n${lines.join("\n")}\n승격 기준: 동의 격차 ≥15%p·표본 ≥15 / 오버라이드 +5%p·적중 -2 이내 (8/6 고정).`
            : `[신모델 보완 주간점검] 신규 누적 ${nDays}일 (승격 판정은 60일부터)\n▶행동 없음 — 정보\n----\n${lines.join("\n")}\n기준치(233일): m7 레버 동의 91/57 · 오버라이드 crabel +35.8 등 — 라이브 재현 추적 중.`,
          smsSubject: "예측 판정",
        }, undefined, undefined, { dedupHours: 16 });
      } catch { /* 발송 실패 무시 */ }
    }
  } catch { /* 보완 모니터 실패는 본 흐름을 막지 않는다 */ }
}
