// 대가 방법론 예측 모델 대시보드 (docs/predict-models-spec.md)
// 5개 모델(크레이블·라쉬케·피셔·달튼·그라임스)의 일일 판정 + 정확도 가중 앙상블 최종 판정.
// 기존 M7(/signal)과 완전 분리 — 사용자 자체 조건과 대가 기법의 성능을 따로 비교하기 위한 시스템.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageShell, Disclaimer } from "../_components/Shell";
import { loadAccuracyStats, loadModelRows, loadRecentDays, loadRescueStats, predictTablesReady } from "@/lib/predict/store";
import { fetchDailyPredict } from "@/lib/predict/data";
import { fetchDayMinutes } from "@/lib/predict/kisMinute";
import { atrPct } from "@/lib/predict/indicators";
import { PREDICT_CONFIG } from "@/lib/predict/config";
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

  const [days, acc, dailyBars, rescue] = await Promise.all([
    loadRecentDays(21),
    loadAccuracyStats(),
    fetchDailyPredict(PREDICT_CONFIG.symbol, 40).catch(() => []),
    loadRescueStats().catch(() => ({}) as Record<string, { c: number; t: number }>),
  ]);
  // 오늘의 권장 스탑 (스펙 3.3 — 신호 유형별): 산·골 조기 = ATR 0.7배(클램프), 피셔 = ETF -3%
  const kstTodayStr = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const atr = atrPct(dailyBars.filter((b) => b.date < kstTodayStr), 14); // 오늘의 미완성 봉 제외
  const sw = PREDICT_CONFIG.stops.earlySwing;
  const atrStop = atr !== null ? Math.min(sw.maxPct, Math.max(sw.minPct, sw.k * atr)) : null;

  // 오늘 시초 레인지 폭 → 유사 사례 기준 피셔 적중률 (광폭 ≥4%는 저신뢰 경고 — 스펙/220일 실측)
  let orInfo: { widthPct: number; similarHit: number; wide: boolean } | null = null;
  try {
    const bars = await fetchDayMinutes(PREDICT_CONFIG.symbol, kstTodayStr.replace(/-/g, ""), "092000");
    const or = (bars ?? []).filter((b) => b.time < "09:15");
    if (or.length >= 15 && or[0].open > 0) {
      const w = ((Math.max(...or.map((b) => b.high)) - Math.min(...or.map((b) => b.low))) / or[0].open) * 100;
      const OB = PREDICT_CONFIG.orBuckets;
      orInfo = {
        widthPct: w,
        similarHit: w >= OB.wideMinPct ? OB.hit.wide : w >= 2 ? OB.hit.mid : OB.hit.calm,
        wide: w >= OB.wideMinPct,
      };
    }
  } catch { /* 장전·휴장 — 미표시 */ }
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

  // 체크포인트 슬롯별 라이브 적중률 (채점 완료 + 타임라인 있는 날만 — 시딩분엔 타임라인 없음)
  const slotStats = new Map<string, { c: number; t: number }>();
  for (const d of days) {
    if (!d.label || !d.revisions) continue;
    for (const r of d.revisions) {
      if (!r.checkpoint) continue;
      const s = slotStats.get(r.checkpoint) ?? { c: 0, t: 0 };
      s.t++;
      if (r.verdict === d.label) s.c++;
      slotStats.set(r.checkpoint, s);
    }
  }
  // 하루치 체크포인트 점수 (채점 후): 타임라인 판정 중 실제와 일치한 비율
  const cpScore = (d: (typeof days)[number]): { c: number; t: number } | null => {
    if (!d.label || !d.revisions || d.revisions.length === 0) return null;
    let c = 0;
    for (const r of d.revisions) if (r.verdict === d.label) c++;
    return { c, t: d.revisions.length };
  };
  // 오늘 판정의 "실측 확률" — 판정자(피셔)의 방향 판정 누적 적중률
  const fisherStat = acc.fisher;
  const fisherDirPct = fisherStat.dirTotal > 0 ? (fisherStat.dirCorrect / fisherStat.dirTotal) * 100 : null;

  return (
    <PageShell title="대가 예측 모델" badge="PREDICT" width="wide">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-48">
        크레이블·라쉬케·피셔·달튼·그라임스 + 사용자(RV1+T6) 6개 <b>독립 모델</b>.
        판정은 <b>08:30 첫 판정 → 30분마다 체크포인트 → 14:00 확정</b> (09:30 전엔 사용자 모델,
        이후 피셔 — 220일 실측 최적 조합. 14:00 피셔 정확도 64.3%). 사이 구간 모니터링에서 판정이
        바뀌면 타임라인 기록 + 문자. 대상 하닉 본주 · 기존 /signal 판정과 무관.
      </p>

      <div className="mb-4"><RunButton /></div>

      {/* 실전 운용 규칙 (220일 실측 확정 — 스펙 3.3) */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5 text-[13px] leading-relaxed">
        <p className="mb-1 font-semibold">실전 운용 규칙 (검증 확정)</p>
        <p className="text-ink-48">
          ① <b>조기 신호(08:30~09:00, 산·골)</b>: 1/3 비중 선진입 · 스탑 ATR 0.7배
          {atrStop !== null && <b className="text-ink-80"> = 오늘 본주 −{atrStop.toFixed(1)}% (2배 ETF −{(atrStop * 2).toFixed(1)}%)</b>}
          {" "}— 타이트 스탑 금지(노이즈컷).
          ② <b>피셔 신호(09:30~, 확인형)</b>: 본진입 · 스탑 <b className="text-ink-80">ETF −3% 고정</b> — 역행은 확인 실패 증거, 빨리 자를 것.
          ③ 판정은 늦을수록 정확(14:00 확정 65.5%) — 확정과 반대 방향 보유 시 청산 검토. ④ 당일 청산 원칙 유지.
        </p>
      </div>

      {/* 오늘 판정 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">오늘 ({kstToday})</p>
        {orInfo && (
          <p className={`mb-2 text-[12px] ${orInfo.wide ? "font-semibold text-red-600" : "text-ink-48"}`}>
            {orInfo.wide ? "⚠ " : ""}오늘 시초 레인지 {orInfo.widthPct.toFixed(1)}% — 유사일 피셔 방향적중 {orInfo.similarHit}%
            {orInfo.wide ? " · 광폭 저신뢰 구간: 신호가 와도 비중 축소 권장 (220일 중 11일 유형)" : ""}
          </p>
        )}
        {today ? (
          <>
            <p className="text-[15px]">
              {today.stage === "early" ? "현재 판정(잠정, 14:00 확정 전)" : "확정 판정(14:00)"}: {verdictCell(today.final_verdict)}{" "}
              <span className="text-[13px] text-ink-48">강도 {today.strength?.toFixed(1)}%</span>
              {today.early_verdict && (
                <span className="ml-2 text-[12px] text-ink-48">
                  (첫 판정 {V_LABEL[(today.early_verdict ?? "none") as Verdict]})
                </span>
              )}
              {today.final_verdict !== "none" && fisherDirPct !== null && (
                <span className="ml-2 text-[12px] text-ink-48">
                  · 피셔 누적 적중 {fisherDirPct.toFixed(0)}% ({fisherStat.dirTotal}회) — 시각별 적중률은 아래 체크포인트 통계
                </span>
              )}
              {today.label && (
                <span className="ml-2 text-[13px]">
                  → 실제 {verdictCell(today.label)}{" "}
                  <span className="text-ink-48">({(today.r_oc ?? 0) >= 0 ? "+" : ""}{today.r_oc}%)</span>
                </span>
              )}
            </p>
            {today.revisions && today.revisions.length > 0 && (
              <p className="mt-1 text-[12px] leading-relaxed text-ink-48">
                판정 타임라인:{" "}
                {today.revisions
                  .map((r) => {
                    const t = r.checkpoint ?? new Date(new Date(r.at).getTime() + 9 * 3600e3).toISOString().slice(11, 16) + "*";
                    const mark = today.label ? (r.verdict === today.label ? "○" : "✕") : "";
                    return `${t} ${V_LABEL[(r.verdict ?? "none") as Verdict]}${mark}`;
                  })
                  .join(" → ")}{" "}
                (*표시는 체크포인트 사이 변경 감지)
                {(() => {
                  const s = cpScore(today);
                  return s ? (
                    <b className="text-ink-80"> — 채점: 실제 {V_LABEL[(today.label ?? "none") as Verdict]}, 체크포인트 점수 {s.c}/{s.t} ({((s.c / s.t) * 100).toFixed(0)}%)</b>
                  ) : null;
                })()}
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
        {slotStats.size > 0 && (
          <p className="mb-2 text-[12px] text-ink-48">
            체크포인트별 라이브 적중률(3분류):{" "}
            {[...slotStats.entries()]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([cp, s]) => `${cp} ${s.c}/${s.t}`)
              .join(" · ")}{" "}
            — 라이브 채점일만 집계 (시딩 이력엔 타임라인 없음)
          </p>
        )}
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

      {/* 피셔 공백일 보완 모니터 — 승격 기준 사전 등록 (2026-07-20) */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-1 text-[14px] font-semibold">피셔 공백일 보완 모니터 (라이브)</p>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-48">
          피셔가 "추세없음"이라 한 날, 다른 모델의 방향 판정이 실제와 맞았는지 라이브로만 집계.
          <b> 승격 기준(사전 등록): 방향 판정 20회 이상 + 적중 55% 이상</b> → 보완 후보로 검토.
          220일 백테스트에선 전 모델 17~32%로 전부 탈락 — 라이브에서 이 기준을 넘는 모델이 나오는지 감시.
        </p>
        <p className="text-[12px] text-ink-48">
          {MODEL_IDS.filter((m) => m !== "fisher").map((m) => {
            const s = rescue[m];
            const pct = s && s.t > 0 ? ` ${((s.c / s.t) * 100).toFixed(0)}%` : " —";
            const pass = s && s.t >= 20 && s.c / s.t >= 0.55;
            return (
              <span key={m} className={pass ? "font-semibold text-green-600" : undefined}>
                {MODEL_LABELS[m].split(" ")[0]} {s ? `${s.c}/${s.t}` : "0/0"}{pct}{pass ? " ★승격기준 도달" : ""}{"  ·  "}
              </span>
            );
          })}
        </p>
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
                <th className="py-1.5 pr-2">실제</th>
                <th className="py-1.5">CP점수</th>
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
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {d.label ? (
                        <>
                          {verdictCell(d.label)}{" "}
                          <span className="text-ink-48">({(d.r_oc ?? 0) >= 0 ? "+" : ""}{d.r_oc}%)</span>
                        </>
                      ) : (
                        <span className="text-ink-48">채점 전</span>
                      )}
                    </td>
                    <td className="py-1.5 whitespace-nowrap text-ink-48">
                      {(() => {
                        const s = cpScore(d);
                        return s ? `${s.c}/${s.t}` : "—";
                      })()}
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
