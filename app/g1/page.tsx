// 일봉 갭 예측 (G1A·G1B) 대시보드 — 발주자 통합 지시 2026-08-12 반영판.
// A1: T2 맨 위 / A2: 베팅 보류 표기 / A3: 예상잔여갭±불확실성·사이징 헤드라인 / A4: TE 기준 병기 /
// A5: 운영 순서 1줄 / B: 행동 지시선(닫힌 목록·꼬리표) / C: 채점 2단 분리·보류 기회비용 / D: 보류 집계.
// 60일 log-only: 모든 판정 가상 — 실행 금지.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";

export const dynamic = "force-dynamic";

const pp = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const won = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString());
const NAME: Record<string, string> = { "000660": "하이닉스", "005930": "삼성전자" };
const SIZE_KO: Record<string, string> = { "1/3": "1/3 (강)", "1/6": "1/6 (약)", "0": "—" };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline/40 py-1.5 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-48">{label}</span>
      <span className="text-right text-ink-80">{value}</span>
    </div>
  );
}
function ActionLine({ line }: { line?: string | null }) {
  if (!line) return null;
  return <p className="mb-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-800">{line}</p>;
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

type Act = { code: string; line: string } | null;
type G1ARow = {
  date: string; symbol: string;
  t1_snapshot: { gap_score_virtual?: number | null } | null;
  t2: {
    trigger_type?: string | null; trigger_time?: string | null; entry_px_virtual?: number | null;
    verdict?: { direction?: string; confidence?: string | null; size?: string; abstain_reason?: string | null; gap_score?: number; expected_residual_gap?: number | null } | null;
    action?: Act; nf_evening?: { t: string; pct: number } | null; shadow?: { last?: { dir?: string; score?: number } } | null;
    report_r1?: string | null;
  } | null;
  labels: { L1p?: number | null; L1?: number | null } | null;
  outcome: { hit?: boolean | null } | null;
};
type G1BRow = {
  date: string; symbol: string;
  night: Record<string, { v: number | null }> | null;
  r1: { fair_gap_pct?: number | null; sigma_pct?: number; expected_open?: number | null; w_used?: Record<string, number>; action?: Act; report?: string } | null;
  r2: { residual_sigma?: number | null; signal?: string; action?: Act; report?: string } | null;
  labels: { actual_gap_pct?: number; te_r1_pct?: number | null } | null;
};

export default async function G1Page() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const admin = createAdminClient();

  const [aDays, bDays, gate, bState] = await Promise.all([
    admin.from("g1a_days").select("*").order("date", { ascending: false }).limit(8),
    admin.from("g1b_days").select("date,symbol,night,r1,r2,labels").order("date", { ascending: false }).limit(12),
    admin.from("g1b_gate").select("date,metrics").order("date", { ascending: false }).limit(1),
    admin.from("g1b_state").select("symbol,state"),
  ]);
  const aRows = (aDays.data ?? []) as G1ARow[];
  const rows = (bDays.data ?? []) as G1BRow[];
  const m = (gate.data?.[0]?.metrics ?? null) as Record<string, unknown> | null;
  const eff = (m?.effective_start ?? {}) as Record<string, string | null>;
  const abstain = (m?.g1a_abstain ?? null) as Record<string, unknown> | null;
  const sigmaOf: Record<string, number> = {};
  for (const s of bState.data ?? []) {
    const se = (s.state as { sigma_ewma?: Record<string, number> })?.sigma_ewma;
    if (se?.normal) sigmaOf[s.symbol] = Math.sqrt(se.normal);
  }
  const aLatest = aRows[0]?.date;
  const aToday = aRows.filter((r) => r.date === aLatest);
  const bLatest = rows[0]?.date;
  const bToday = rows.filter((r) => r.date === bLatest);

  return (
    <PageShell title="일봉 갭 예측 (G1A·G1B)" badge="60일 검증" width="default">
      <div className="mb-2 rounded-[14px] border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">
        <b>전 판정 가상(log-only)</b> — 60일 검증 완료·게이트 통과 전까지 실행 금지.
      </div>
      {/* A5: 운영 순서 고정 안내 */}
      <p className="mb-4 rounded-[10px] bg-pearl/60 px-3 py-2 text-[12px] text-ink-48">
        운영 순서: <b>T2(저녁 결정) → R1(아침 재판·오판 시 프리장 청산) → R2(시가 확인)</b>
      </p>

      {/* A1: G1A T2 — 맨 위 */}
      {aToday.map((r) => {
        const v = r.t2?.verdict;
        const sig = sigmaOf[r.symbol];
        return (
          <Card key={r.symbol} title={`${NAME[r.symbol] ?? r.symbol} — ${r.date} 저녁 결정`} badge="G1A T2">
            <ActionLine line={r.t2?.action?.line} />
            {/* 방향+등급 복합 표기 (발주자 용어 확정판 8/13): ▲▼갭상승/갭하락, △▽ Lean, ─ Flat, [E] 접두.
                색 규약: 갭상승 적색·갭하락 청색·Lean 연한 톤·Flat 회색 */}
            <p className="mb-1 text-[14px] font-semibold">
              {v ? (() => {
                const g = (r.t2 as { grade?: { grade?: string; lean_dir?: string | null; lean_score?: number; label?: string } })?.grade;
                const label = g?.label ?? "─ Flat (무방향)";
                const color = g?.lean_dir === "UP"
                  ? (g?.grade === "Lean" ? "text-red-400" : "text-red-600")
                  : g?.lean_dir === "DOWN"
                    ? (g?.grade === "Lean" ? "text-blue-400" : "text-blue-600")
                    : "text-ink-48";
                return (<>
                  <span className={color}>{label}</span>
                  <span className="text-ink-80"> {v.direction !== "NEUTRAL"
                    ? <>· {v.direction === "UP" ? `매수 권장 ${SIZE_KO[v.size ?? "0"]}` : "보유분 방어 전용 (신규 숏 없음)"}</>
                    : <>· 베팅 없음{g?.lean_score != null ? ` (score ${g.lean_score})` : ""}</>}</span>
                  {v.abstain_reason ? <span className="font-normal text-[12px] text-ink-48"> ({v.abstain_reason})</span> : null}
                </>);
              })() : "저녁 감시 대기"}
            </p>
            {(() => {
              const sc = (r.t2 as { event_scenario?: { beat?: string; miss?: string } })?.event_scenario;
              return sc ? <p className="mb-1 rounded-[8px] bg-pearl/60 px-2 py-1 text-[11px] text-ink-48">이벤트 시나리오 — {sc.beat} / {sc.miss}</p> : null;
            })()}
            {v ? (
              <Row label={`예상잔여갭${v.direction === "NEUTRAL" ? " (가상 참고)" : ""}`}
                value={<>{pp(v.expected_residual_gap)}{sig ? ` ± ${sig.toFixed(2)}% (G1B σ 준용)` : ""}</>} />
            ) : null}
            <Row label="GapScore / 기준가" value={<>{v?.gap_score ?? "—"} / {won(r.t2?.entry_px_virtual)}</>} />
            <Row label="야간선물 초반 (E1·기록만)" value={r.t2?.nf_evening ? `${r.t2.nf_evening.t} ${pp(r.t2.nf_evening.pct)}` : "18:00~ 대기"} />
            <Row label="T2+ 섀도 (E2·본판정 미반영)" value={r.t2?.shadow?.last ? `${r.t2.shadow.last.dir} (score ${r.t2.shadow.last.score})` : "—"} />
            {(() => {
              const p = (r.t2 as { pieces?: Record<string, number | null> })?.pieces;
              const mo = (r.t2 as { mosaic?: { last?: { dir?: string; score?: number } } })?.mosaic;
              const es = (r.t2 as { e_shadow?: { grade?: string } })?.e_shadow;
              return (<>
                <Row label="정보 조각 P1 유럽반도체" value={p?.p1_eu_semi_avg != null ? `${pp(p.p1_eu_semi_avg)} (ASML ${pp(p.p1_asml)}·IFX ${pp(p.p1_ifx)}·STM ${pp(p.p1_stm)})` : "수집 대기"} />
                <Row label="T2-모자이크 섀도" value={mo?.last ? `${mo.last.dir} (score ${mo.last.score})` : "—"} />
                {es ? <Row label="E-등급 섀도 (헌법 발효 전)" value={es.grade ?? "—"} /> : null}
              </>);
            })()}
            {r.t2?.report_r1 ? (
              <details className="mt-2 text-[12px] text-ink-48"><summary>리포트 전문</summary>
                <pre className="mt-1 whitespace-pre-wrap rounded-[10px] bg-pearl/50 p-2 text-[11px] leading-relaxed text-ink-80">{r.t2.report_r1}</pre>
              </details>
            ) : null}
          </Card>
        );
      })}

      {/* G1B R1·R2 */}
      {bToday.map((r) => (
        <Card key={r.symbol} title={`${NAME[r.symbol] ?? r.symbol} — ${r.date} 아침`} badge="G1B R1·R2">
          <ActionLine line={r.r1?.action?.line} />
          <Row label="R1 공정 갭 (07:20)" value={r.r1 ? <>{pp(r.r1.fair_gap_pct)} ± {r.r1.sigma_pct?.toFixed(2)}% · 예상시가 {won(r.r1.expected_open)}</> : "발행 전"} />
          <Row label="가중 (Hedge)" value={r.r1?.w_used ? Object.entries(r.r1.w_used).map(([k, v]) => `${k} ${v}`).join(" · ") : "—"} />
          <ActionLine line={r.r2?.action?.line} />
          <Row label="R2 (08:55)" value={r.r2 ? <>{r.r2.signal}{r.r2.residual_sigma != null ? ` (${r.r2.residual_sigma}σ)` : ""}</> : "발행 전"} />
          <Row label="야간선물 관측" value={r.night?.night_fut?.v != null ? pp(Number(r.night.night_fut.v) * 100) : "결측"} />
          <Row label="실측 갭 / R1 오차" value={r.labels ? <>{pp(r.labels.actual_gap_pct)} / TE {pp(r.labels.te_r1_pct)}</> : "09:35 채점 대기"} />
          {r.r1?.report ? (
            <details className="mt-2 text-[12px] text-ink-48"><summary>리포트 전문</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded-[10px] bg-pearl/50 p-2 text-[11px] leading-relaxed text-ink-80">{r.r1.report}{r.r2?.report ? "\n\n" + r.r2.report : ""}</pre>
            </details>
          ) : null}
        </Card>
      ))}

      {/* C1·C2: G1A 성적 (베팅 밤 한정 — L1' 진입가 기준) */}
      <Card title="G1A 성적 — 방향·L1′(진입가→시가) 손익" badge="베팅 밤 한정">
        {aRows.filter((r) => ["UP", "DOWN"].includes(String(r.t2?.verdict?.direction)) && r.labels).map((r) => (
          <Row key={`${r.date}-${r.symbol}`} label={`${r.date.slice(5)} ${NAME[r.symbol] ?? r.symbol}`}
            value={<>{r.t2?.verdict?.direction === "UP" ? "매수" : "매도"} → L1′ {pp(r.labels?.L1p)} {r.outcome?.hit != null ? (r.outcome.hit ? "· 적중" : "· 빗나감") : ""}</>} />
        ))}
        {!aRows.some((r) => ["UP", "DOWN"].includes(String(r.t2?.verdict?.direction)) && r.labels)
          ? <p className="text-[13px] text-ink-48">베팅한 밤 없음 (전부 보류) — 아래 보류 기회비용 참조</p> : null}
        {/* C3: 보류 밤 기회비용 */}
        <p className="mt-3 mb-1 text-[12px] font-semibold text-ink-48">보류 밤 기회비용 (가상 기준가 19:40 NXT → 시가)</p>
        {aRows.filter((r) => r.t2?.verdict?.direction === "NEUTRAL" && r.labels?.L1p != null).slice(0, 6).map((r) => (
          <Row key={`ab-${r.date}-${r.symbol}`} label={`${r.date.slice(5)} ${NAME[r.symbol] ?? r.symbol}`}
            value={<>실측 갭 {pp(r.labels?.L1)} · 가상 진입가 기준 {pp(r.labels?.L1p)}</>} />
        ))}
      </Card>

      {/* C1: G1B 성적 (R1 오차) */}
      <Card title="G1B 성적 — R1 번역 오차" badge="TE_r1">
        {rows.filter((r) => r.labels).slice(0, 8).map((r) => (
          <Row key={`${r.date}-${r.symbol}`} label={`${r.date.slice(5)} ${NAME[r.symbol] ?? r.symbol}`}
            value={<>예측 {pp(r.r1?.fair_gap_pct)} → 실측 {pp(r.labels?.actual_gap_pct)} (오차 {pp(r.labels?.te_r1_pct)})</>} />
        ))}
      </Card>

      {/* 계기판 (A4 기준 병기 + D1 보류 집계) */}
      <Card title="게이트 계기판 (D+15 판정 재료)" badge={String(m?.dryrun ?? "—")}>
        <Row label="가동률" value={`${m?.uptime_pct ?? "—"}%`} />
        <Row label="TE_r1 중앙값" value={<>{m?.te_r1_median_pct != null ? `${m.te_r1_median_pct}%` : "—"} <span className="text-[11px] text-ink-48">(기준: 오프라인 1.5배 이내 = 삼전 ≤1.58% · 하닉 ≤2.38%)</span></>} />
        <Row label="절단 위반 (late)" value={String(m?.late_arrival_total ?? "—")} />
        <Row label="기능별 개시일" value={<span className="text-[11px]">야간선물 {eff.night_fut ?? "—"} · 예상체결 {eff.auction_est ?? "—"} · R2잔차 {eff.r2_residual ?? "—"} · 저녁야간선물 {eff.g1a_nf_evening ?? "—"}</span>} />
        <Row label="Lean 채점 (θ 인하 심사 증거)" value={(() => {
          const t = (m?.t2plus_compare ?? null) as { lean_score?: { n: number; hits: number; rate: number | null }; base_bets?: number; shadow_bets?: number; mosaic_bets?: number; nights_tracked?: number } | null;
          if (!t) return "집계 전";
          return <span className="text-[11px]">Lean {t.lean_score?.n ?? 0}밤 적중 {t.lean_score?.hits ?? 0} ({t.lean_score?.rate != null ? Math.round(t.lean_score.rate * 100) + "%" : "—"}) · 베팅가능밤 T2 {t.base_bets}/{t.nights_tracked} vs T2+ {t.shadow_bets} vs 모자이크 {t.mosaic_bets}</span>;
        })()} />
        <Row label="보류 밤 집계 (D1)" value={abstain
          ? <span className="text-[11px]">{String(abstain.nights)}밤 · 실제 갭 평균 {pp(abstain.avg_abs_gap_pct as number)} / 최대 {pp(abstain.max_abs_gap_pct as number)} · 가상 놓친 |수익| 합 {pp(abstain.missed_virtual_sum_pct as number)}</span>
          : "집계 전"} />
      </Card>

      <Disclaimer />
    </PageShell>
  );
}
