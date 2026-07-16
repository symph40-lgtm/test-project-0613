// 대가 방법론 예측 모델 대시보드 (docs/predict-models-spec.md)
// 5개 모델(크레이블·라쉬케·피셔·달튼·그라임스)의 일일 판정 + 정확도 가중 앙상블 최종 판정.
// 기존 M7(/signal)과 완전 분리 — 사용자 자체 조건과 대가 기법의 성능을 따로 비교하기 위한 시스템.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageShell, Disclaimer } from "../_components/Shell";
import { loadAccuracyStats, loadModelRows, loadRecentDays, predictTablesReady } from "@/lib/predict/store";
import { liftWeight, chanceBaseline } from "@/lib/predict/ensemble";
import { MODEL_IDS, MODEL_LABELS } from "@/lib/predict/types";
import type { Verdict } from "@/lib/predict/types";
import RunButton from "./RunButton";

export const dynamic = "force-dynamic";

const V_LABEL: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };
const V_STYLE: Record<Verdict, string> = {
  leverage: "text-red-600 font-semibold",
  inverse: "text-blue-600 font-semibold",
  none: "text-ink-48",
};

function verdictCell(v: string | null | undefined) {
  const key = (v ?? "none") as Verdict;
  return <span className={V_STYLE[key] ?? "text-ink-48"}>{V_LABEL[key] ?? "—"}</span>;
}

export default async function PredictPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const ready = await predictTablesReady();
  if (!ready) {
    return (
      <PageShell title="대가 예측 모델" badge="PREDICT" width="wide">
        <div className="rounded-[18px] border border-hairline bg-canvas p-5 text-[13px] leading-relaxed">
          <p className="font-semibold text-red-600">마이그레이션 026 미적용</p>
          <p className="mt-1 text-ink-48">
            Supabase SQL Editor에서 <code>supabase/migrations/026_predict.sql</code>을 실행한 뒤,
            로컬에서 <code>npx tsx scripts/predict-backtest.ts --seed</code>로 90일 초기 이력을 적재하세요.
          </p>
        </div>
      </PageShell>
    );
  }

  const [days, acc] = await Promise.all([loadRecentDays(21), loadAccuracyStats()]);
  const modelRows = await loadModelRows(days.map((d) => d.date));
  const byDate = new Map<string, typeof modelRows>();
  for (const r of modelRows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }

  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const today = days.find((d) => d.date === kstToday) ?? null;
  const todayModels = today ? byDate.get(today.date) ?? [] : [];

  return (
    <PageShell title="대가 예측 모델" badge="PREDICT" width="wide">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-48">
        크레이블·라쉬케·피셔·달튼·그라임스 5개 방법론을 <b>독립 모델</b>로 돌립니다.
        <b> 최종 판정은 피셔(ACD) 단독</b> — 220거래일×3종목 검증에서 앙상블이 피셔를 넘지 못해
        확정(2026-07-16). 나머지 4개는 대조군으로 매일 채점만 계속하며, 리프트 가중 앙상블은 참고
        지표로 병기합니다. 판정 확정 10:31 · 대상 하닉 본주 · 기존 /signal 판정과 무관.
      </p>

      <div className="mb-4"><RunButton /></div>

      {/* 오늘 판정 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">오늘 ({kstToday})</p>
        {today ? (
          <>
            <p className="text-[15px]">
              {today.stage === "early" ? "조기 판정(잠정, 10:31 확정 전)" : "최종 판정"}: {verdictCell(today.final_verdict)}{" "}
              <span className="text-[13px] text-ink-48">강도 {today.strength?.toFixed(1)}%</span>
              {today.stage === "final" && today.early_verdict && (
                <span className="ml-2 text-[12px] text-ink-48">
                  (조기 09:31 {V_LABEL[(today.early_verdict ?? "none") as Verdict]}
                  {today.revisions && today.revisions.length > 1 ? ` · 변경 ${today.revisions.length - 1}회` : ""})
                </span>
              )}
              {today.label && (
                <span className="ml-2 text-[13px]">
                  → 실제 {verdictCell(today.label)}{" "}
                  <span className="text-ink-48">({(today.r_oc ?? 0) >= 0 ? "+" : ""}{today.r_oc}%)</span>
                </span>
              )}
            </p>
            {today.stage === "early" && today.revisions && today.revisions.length > 0 && (
              <p className="mt-1 text-[12px] text-ink-48">
                모니터링 (10:31 확정 전 변경 추적):{" "}
                {today.revisions
                  .map((r) => {
                    const kst = new Date(new Date(r.at).getTime() + 9 * 3600e3).toISOString().slice(11, 16);
                    return `${kst} ${V_LABEL[(r.verdict ?? "none") as Verdict]}`;
                  })
                  .join(" → ")}
              </p>
            )}
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {MODEL_IDS.map((m) => {
                const row = todayModels.find((r) => r.model === m);
                return (
                  <div key={m} className="rounded-[12px] border border-hairline p-3 text-[12px]">
                    <p className="font-semibold">{MODEL_LABELS[m]}</p>
                    <p className="mt-0.5">
                      {verdictCell(row?.verdict)}{" "}
                      {row?.confidence != null && <span className="text-ink-48">신뢰도 {(row.confidence * 100).toFixed(0)}%</span>}
                    </p>
                    {row?.reason && <p className="mt-1 leading-relaxed text-ink-48">{row.reason}</p>}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="text-[13px] text-ink-48">아직 판정 없음 — 거래일 10:31 이후 "지금 실행"을 누르거나 크론이 처리합니다.</p>
        )}
      </div>

      {/* 누적 정확도 = 앙상블 가중치 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">모델별 누적 정확도 → 리프트 가중치 (우연 이하 모델은 0 = 침묵)</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {MODEL_IDS.map((m) => {
            const s = acc[m];
            const pct = s.total > 0 ? (s.correct / s.total) * 100 : null;
            return (
              <div key={m} className="rounded-[12px] border border-hairline p-3 text-[12px]">
                <p className="font-semibold leading-tight">{MODEL_LABELS[m]}</p>
                <p className="mt-1 text-[16px] font-semibold">{pct === null ? "—" : `${pct.toFixed(1)}%`}</p>
                <p className="text-ink-48">
                  {s.correct}/{s.total}일 · 우연 {(chanceBaseline(s) * 100).toFixed(0)}% · 가중치 {liftWeight(s).toFixed(3)}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* 최근 기록 */}
      <div className="rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">최근 판정 기록</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12px]">
            <thead>
              <tr className="border-b border-hairline text-left text-ink-48">
                <th className="py-1.5 pr-2">날짜</th>
                {MODEL_IDS.map((m) => (
                  <th key={m} className="py-1.5 pr-2">{MODEL_LABELS[m].split(" ")[0]}</th>
                ))}
                <th className="py-1.5 pr-2">최종 (강도)</th>
                <th className="py-1.5">실제</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const rows = byDate.get(d.date) ?? [];
                return (
                  <tr key={d.date} className="border-b border-hairline/60">
                    <td className="py-1.5 pr-2 whitespace-nowrap">{d.date}</td>
                    {MODEL_IDS.map((m) => {
                      const row = rows.find((r) => r.model === m);
                      const hit = row?.correct;
                      return (
                        <td key={m} className="py-1.5 pr-2 whitespace-nowrap">
                          {verdictCell(row?.verdict)}
                          {hit != null && <span className={hit ? "text-green-600" : "text-red-500"}> {hit ? "○" : "✕"}</span>}
                        </td>
                      );
                    })}
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {verdictCell(d.final_verdict)} <span className="text-ink-48">{d.strength?.toFixed(0)}%</span>
                      {d.label != null && (
                        <span className={d.final_verdict === d.label ? "text-green-600" : "text-red-500"}>
                          {" "}{d.final_verdict === d.label ? "○" : "✕"}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 whitespace-nowrap">
                      {d.label ? (
                        <>
                          {verdictCell(d.label)}{" "}
                          <span className="text-ink-48">({(d.r_oc ?? 0) >= 0 ? "+" : ""}{d.r_oc}%)</span>
                        </>
                      ) : (
                        <span className="text-ink-48">채점 전</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
