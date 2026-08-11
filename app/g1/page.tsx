// 일봉 갭 예측 (G1A·G1B) 현황 — 사용자 지시 2026-08-11 "메뉴 시장·알림·분석 > 신모델 현황 윗줄".
// 60일 log-only 검증 중: 모든 판정·지시는 가상 — 실행 금지 (발주자 규율, 첫날부터).
// 데이터: g1b_days(R1/R2·라벨)·g1b_gate(계기판)·g1a_days(T1/T2) — 크론이 창구별 자동 갱신.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";

export const dynamic = "force-dynamic";

const pp = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const won = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString());
const NAME: Record<string, string> = { "000660": "하이닉스", "005930": "삼성전자" };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline/40 py-1.5 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-48">{label}</span>
      <span className="text-right text-ink-80">{value}</span>
    </div>
  );
}

function Card({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[15px] font-semibold">{title}</p>
        {badge ? <span className="rounded-full bg-pearl px-2 py-0.5 text-[11px] font-semibold text-ink-48">{badge}</span> : null}
      </div>
      {children}
    </div>
  );
}

type G1BRow = {
  date: string; symbol: string;
  night: Record<string, { v: number | null }> | null;
  r1: { fair_gap_pct?: number | null; sigma_pct?: number; expected_open?: number | null; w_used?: Record<string, number>; regime?: string; report?: string } | null;
  r2: { fair_gap_r2_pct?: number | null; residual_sigma?: number | null; signal?: string; report?: string } | null;
  labels: { actual_gap_pct?: number; te_r1_pct?: number | null } | null;
};
type G1ARow = {
  date: string; symbol: string;
  t1_snapshot: { gap_score_virtual?: number | null } | null;
  t2: { trigger_type?: string | null; trigger_time?: string | null; verdict?: { direction?: string; confidence?: string | null; size?: string; abstain_reason?: string | null; gap_score?: number } | null; evals?: unknown[]; report_r1?: string | null } | null;
};

export default async function G1Page() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const admin = createAdminClient();

  const [bDays, gate, aDays] = await Promise.all([
    admin.from("g1b_days").select("date,symbol,night,r1,r2,labels").order("date", { ascending: false }).limit(10),
    admin.from("g1b_gate").select("date,metrics").order("date", { ascending: false }).limit(1),
    admin.from("g1a_days").select("date,symbol,t1_snapshot,t2").order("date", { ascending: false }).limit(6),
  ]);
  const rows = (bDays.data ?? []) as G1BRow[];
  const m = (gate.data?.[0]?.metrics ?? null) as Record<string, unknown> | null;
  const eff = (m?.effective_start ?? {}) as Record<string, string | null>;
  const aRows = (aDays.data ?? []) as G1ARow[];
  const latestDate = rows[0]?.date;
  const today = rows.filter((r) => r.date === latestDate);

  return (
    <PageShell title="일봉 갭 예측 (G1A·G1B)" badge="60일 검증" width="default">
      <div className="mb-4 rounded-[14px] border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">
        <b>전 판정 가상(log-only)</b> — 60일 검증 완료·게이트 통과 전까지 실행 금지. 리포트의 지시는 기록용입니다.
      </div>

      {/* G1B 오늘 — 야간 번역 R1/R2 */}
      {today.map((r) => (
        <Card key={r.symbol} title={`${NAME[r.symbol] ?? r.symbol} — ${r.date}`} badge="G1B 야간 번역">
          <Row label="R1 공정 갭 (07:20)" value={r.r1 ? <>{pp(r.r1.fair_gap_pct)} ± {r.r1.sigma_pct?.toFixed(2)}% · 예상시가 {won(r.r1.expected_open)}</> : "발행 전"} />
          <Row label="가중 (Hedge)" value={r.r1?.w_used ? Object.entries(r.r1.w_used).map(([k, v]) => `${k} ${v}`).join(" · ") : "—"} />
          <Row label="R2 잔차 판정 (08:55)" value={r.r2 ? <>{r.r2.signal} {r.r2.residual_sigma != null ? `(${r.r2.residual_sigma}σ)` : ""}</> : "발행 전"} />
          <Row label="야간선물 관측" value={r.night?.night_fut?.v != null ? pp(Number(r.night.night_fut.v) * 100) : "결측"} />
          <Row label="실측 갭 / 오차" value={r.labels ? <>{pp(r.labels.actual_gap_pct)} / TE {pp(r.labels.te_r1_pct)}</> : "09:35 채점 대기"} />
          {r.r1?.report ? (
            <details className="mt-2 text-[12px] text-ink-48"><summary>리포트 전문</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded-[10px] bg-pearl/50 p-2 text-[11px] leading-relaxed text-ink-80">{r.r1.report}{r.r2?.report ? "\n\n" + r.r2.report : ""}</pre>
            </details>
          ) : null}
        </Card>
      ))}
      {!today.length ? <Card title="G1B" badge="대기"><p className="text-[13px] text-ink-48">첫 사이클 대기 중 (평일 06:00~)</p></Card> : null}

      {/* G1A 저녁 판정 */}
      <Card title="G1A 저녁 갭 판정 (T2)" badge="16:30~19:55">
        {aRows.length ? aRows.map((r) => (
          <Row key={`${r.date}-${r.symbol}`} label={`${r.date.slice(5)} ${NAME[r.symbol] ?? r.symbol}`}
            value={r.t2?.verdict
              ? <>{r.t2.trigger_type === "E" ? "조기 " : ""}{r.t2.verdict.direction}{r.t2.verdict.confidence ? `·${r.t2.verdict.confidence}` : ""}{r.t2.verdict.abstain_reason ? ` (${r.t2.verdict.abstain_reason})` : ` (score ${r.t2.verdict.gap_score})`}</>
              : r.t1_snapshot ? `T1 가상점수 ${r.t1_snapshot.gap_score_virtual ?? "—"} · 저녁 감시 대기` : "대기"} />
        )) : <p className="text-[13px] text-ink-48">기록 없음</p>}
      </Card>

      {/* 게이트 계기판 */}
      <Card title="게이트 계기판 (D+15 판정 재료)" badge={String(m?.dryrun ?? "—")}>
        <Row label="가동률" value={`${m?.uptime_pct ?? "—"}%`} />
        <Row label="번역오차 중앙값 (TE_r1)" value={m?.te_r1_median_pct != null ? `${m.te_r1_median_pct}%` : "—"} />
        <Row label="절단 위반 (late)" value={String(m?.late_arrival_total ?? "—")} />
        <Row label="기능별 개시일" value={
          <span className="text-[11px]">야간선물 {eff.night_fut ?? "—"} · 예상체결 {eff.auction_est ?? "—"} · R2잔차 {eff.r2_residual ?? "—"}</span>
        } />
      </Card>

      {/* 최근 이력 */}
      <Card title="최근 채점 이력" badge="G1B">
        {rows.filter((r) => r.labels).slice(0, 8).map((r) => (
          <Row key={`${r.date}-${r.symbol}`} label={`${r.date.slice(5)} ${NAME[r.symbol] ?? r.symbol}`}
            value={<>예측 {pp(r.r1?.fair_gap_pct)} → 실측 {pp(r.labels?.actual_gap_pct)} (오차 {pp(r.labels?.te_r1_pct)})</>} />
        ))}
        {!rows.some((r) => r.labels) ? <p className="text-[13px] text-ink-48">채점 대기</p> : null}
      </Card>

      <Disclaimer />
    </PageShell>
  );
}
