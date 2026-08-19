// 일봉 갭 예측 (G1A·G1B) 대시보드 — 발주자 통합 지시 2026-08-12 반영판.
// A1: T2 맨 위 / A2: 베팅 보류 표기 / A3: 예상잔여갭±불확실성·사이징 헤드라인 / A4: TE 기준 병기 /
// A5: 운영 순서 1줄 / B: 행동 지시선(닫힌 목록·꼬리표) / C: 채점 2단 분리·보류 기회비용 / D: 보류 집계.
// 60일 log-only: 모든 판정 가상 — 실행 금지.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";
import { nfFlowLines, r1Footnote, r2Footnote, t2Footnote, verdictSentence, type TwoLines } from "@/lib/g1/copy";
import { mtCardLines, MT_DISCLAIMER } from "@/lib/mt/report";
import type { MtDay } from "@/lib/mt/types";

export const dynamic = "force-dynamic";

const pp = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const won = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString());
const NAME: Record<string, string> = { "000660": "하이닉스", "005930": "삼성전자" };
const SIZE_KO: Record<string, string> = { "1/3": "1/3 (강)", "1/6": "1/6 (약)", "0": "—" };
// 표시 순서 삼성전자 → 하이닉스 통일 (발주자 표기 지시 8/15 §1) — 카드·이력 전부
const SYM_ORDER: Record<string, number> = { "005930": 0, "000660": 1 };
const bySymOrder = <T extends { date: string; symbol: string }>(a: T, b: T) =>
  a.date !== b.date ? b.date.localeCompare(a.date) : (SYM_ORDER[a.symbol] ?? 9) - (SYM_ORDER[b.symbol] ?? 9);

// 사이클 짝 표기 (발주자 8/19): T2 카드 "채점: M-D 아침" 예고 / R1·R2 카드 "(← M-D 저녁 T2의 밤)"
const KR_HOLI = new Set(["2026-09-24", "2026-09-25", "2026-10-05", "2026-10-09", "2026-12-25"]);
const nextKrxDay = (d: string) => {
  const x = new Date(d + "T00:00:00Z");
  do { x.setUTCDate(x.getUTCDate() + 1); } while ([0, 6].includes(x.getUTCDay()) || KR_HOLI.has(x.toISOString().slice(0, 10)));
  return x.toISOString().slice(0, 10);
};
const md = (d: string) => d.slice(5);
// §A 카드 하단 고정 각주 — 2줄 (템플릿 자동 생성, 자유 서술 금지)
function Footnote({ f }: { f: TwoLines }) {
  if (!f) return null;
  return (
    <div className="mt-2 rounded-[10px] bg-pearl/60 px-3 py-2 text-[18px] md:text-[15px] md:text-[12px] leading-relaxed">
      <p><span className="font-semibold text-ink-48">해석</span> <span className="text-ink-80">{f.해석}</span></p>
      <p><span className="font-semibold text-ink-48">할 일</span> <span className="text-ink-80">{f.할일}</span></p>
    </div>
  );
}

// MT 상시 줄 (스펙 SPEC_MT_v04.md §3.2) — 국면 확률·부품 충족도·톤·박스. 판정 무개입.
function MtLine({ day }: { day: MtDay | undefined }) {
  if (!day) return null;
  const l = mtCardLines(day);
  return (
    <div className="border-b border-hairline/40 py-1.5 text-[18px] md:text-[15px] md:text-[12px]">
      <p className="text-ink-80">{l.head}</p>
      <p className="text-ink-48">{l.panel}</p>
      <p className="text-ink-48">{l.tail}</p>
      {l.flags.length ? <p className="mt-0.5 text-[17px] md:text-[14px] md:text-[11px] font-semibold text-amber-700">{l.flags.join(" · ")}</p> : null}
      {/* 전환 선언 트랙 동결 (2026-08-16 발주자 판정 4 — 재채점 1회 미달·오탐률 86%): 화면 노출 없음, 로그만. 톤·패널·박스는 유지 */}
      <p className="text-[17px] md:text-[14px] md:text-[11px] text-ink-48"><i>톤 트랙 검증 미달 꼬리표: 방향 적중 54% (기준선 대비 초과 ±2%p 이내) — 참고만, 판정 무개입</i></p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline/40 py-1.5 text-[16px] md:text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-48">{label}</span>
      <span className="text-right text-ink-80">{value}</span>
    </div>
  );
}
function ActionLine({ line }: { line?: string | null }) {
  if (!line) return null;
  return <p className="mb-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[16px] md:text-[13px] font-semibold text-amber-800">{line}</p>;
}
function Card({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[18px] md:text-[15px] font-semibold">{title}</p>
        {badge ? <span className="rounded-full bg-pearl px-2 py-0.5 text-[17px] md:text-[14px] md:text-[11px] font-semibold text-ink-48">{badge}</span> : null}
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

  const [aDays, bDays, gate, bState, mtDays] = await Promise.all([
    admin.from("g1a_days").select("*").order("date", { ascending: false }).limit(8),
    admin.from("g1b_days").select("date,symbol,night,r1,r2,labels").order("date", { ascending: false }).limit(12),
    admin.from("g1b_gate").select("date,metrics").order("date", { ascending: false }).limit(1),
    admin.from("g1b_state").select("symbol,state"),
    admin.from("mt_days").select("*").order("date", { ascending: false }).limit(30),
  ]);
  // MT 1단계 = 표시 전용 (판정 무개입). 마이그레이션 037 미적용이면 조용히 비활성.
  const mtLatest = new Map<string, MtDay>();
  for (const r of (mtDays.data ?? []) as MtDay[]) if (!mtLatest.has(r.symbol)) mtLatest.set(r.symbol, r);
  const aRows = (aDays.data ?? []) as G1ARow[];
  const rows = (bDays.data ?? []) as G1BRow[];
  const m = (gate.data?.[0]?.metrics ?? null) as Record<string, unknown> | null;
  const eff = (m?.effective_start ?? {}) as Record<string, string | null>;
  const abstain = (m?.g1a_abstain ?? null) as Record<string, unknown> | null;
  const sigmaOf: Record<string, number> = {};
  // 학습 상태 (사용자 논의 8/15 — 적응 η 도입 시점 판단 재료): CUSUM·bias·Hedge 가중 표시 (저장값만)
  const learnOf: Record<string, { cusum: number; bias: number; hedge_w: Record<string, number>; nights: number }> = {};
  for (const s of bState.data ?? []) {
    const st = s.state as { sigma_ewma?: Record<string, number>; cusum?: number; bias?: number; hedge_w?: Record<string, number>; nights?: number };
    if (st?.sigma_ewma?.normal) sigmaOf[s.symbol] = Math.sqrt(st.sigma_ewma.normal);
    learnOf[s.symbol] = { cusum: st?.cusum ?? 0, bias: st?.bias ?? 0, hedge_w: st?.hedge_w ?? {}, nights: st?.nights ?? 0 };
  }
  aRows.sort(bySymOrder);
  rows.sort(bySymOrder);
  const aLatest = aRows[0]?.date;
  const aToday = aRows.filter((r) => r.date === aLatest);
  const bLatest = rows[0]?.date;
  const bToday = rows.filter((r) => r.date === bLatest);
  // §C β 환산용 — 오늘 행의 nf.level.beta_mkt 우선, 없으면 pack 초기값
  const betaOf: Record<string, number> = { "005930": 1.316, "000660": 1.517 };
  for (const r of aToday) {
    const b = (r.t2 as { nf?: { level?: { beta_mkt?: number } } } | null)?.nf?.level?.beta_mkt;
    if (typeof b === "number" && b > 0) betaOf[r.symbol] = b;
  }

  return (
    <PageShell title="일봉 갭 예측 (G1A·G1B)" badge="60일 검증" width="default">
      <div className="mb-2 rounded-[14px] border border-red-200 bg-red-50 p-3 text-[18px] md:text-[15px] md:text-[12px] text-red-700">
        <b>전 판정 가상(log-only)</b> — 60일 검증 완료·게이트 통과 전까지 실행 금지.
      </div>
      {/* A5: 운영 순서 고정 안내 */}
      <p className="mb-4 rounded-[10px] bg-pearl/60 px-3 py-2 text-[18px] md:text-[15px] md:text-[12px] text-ink-48">
        운영 순서: <b>T2(저녁 결정) → R1(아침 재판·오판 시 프리장 청산) → R2(시가 확인)</b>
      </p>

      {/* MT 시장 톤 (KOSPI200) — 1단계 표시 전용. 종목 톤은 각 카드 안에 상시 줄로 들어간다. */}
      {mtLatest.has("KOSPI200") ? (
        <Card title={`시장 톤·에너지 — ${mtLatest.get("KOSPI200")!.date}`} badge="MT 1단계">
          <MtLine day={mtLatest.get("KOSPI200")} />
          <p className="mt-2 text-[17px] md:text-[14px] md:text-[11px] text-ink-48">{MT_DISCLAIMER}</p>
        </Card>
      ) : null}

      {/* A1: G1A T2 — 맨 위 */}
      {aToday.map((r) => {
        const v = r.t2?.verdict;
        const sig = sigmaOf[r.symbol];
        return (
          <Card key={r.symbol} title={`${NAME[r.symbol] ?? r.symbol} — ${md(r.date)} 저녁 결정 (채점: ${md(nextKrxDay(r.date))} 아침)`} badge="G1A T2">
            <ActionLine line={r.t2?.action?.line} />
            {/* 방향+등급 복합 표기 (발주자 용어 확정판 8/13): ▲▼갭상승/갭하락, △▽ Lean, ─ Flat, [E] 접두.
                색 규약: 갭상승 적색·갭하락 청색·Lean 연한 톤·Flat 회색 */}
            <p className="mb-1 text-[17px] md:text-[14px] font-semibold">
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
                    : <>· 베팅 없음{g?.lean_score != null ? ` (score ${g.lean_score}` : ""}{(g?.grade === "High" || g?.grade === "Low") ? " · 트리거 조건 미달 — 등급은 점수대로" : ""}{g?.lean_score != null ? ")" : ""}</>}</span>
                  {v.abstain_reason ? <span className="font-normal text-[18px] md:text-[15px] md:text-[12px] text-ink-48"> ({v.abstain_reason})</span> : null}
                </>);
              })() : "저녁 감시 대기"}
            </p>
            {(() => {
              const sc = (r.t2 as { event_scenario?: { beat?: string; miss?: string } })?.event_scenario;
              return sc ? <p className="mb-1 rounded-[8px] bg-pearl/60 px-2 py-1 text-[17px] md:text-[14px] md:text-[11px] text-ink-48">이벤트 시나리오 — {sc.beat} / {sc.miss}</p> : null;
            })()}
            {v ? (
              <Row label={`예상잔여갭 · 번역 추정(G1B)${(r.t2 as {conflict?:boolean})?.conflict ? " ⚠방향 상충" : ""}${v.direction === "NEUTRAL" ? " (가상 참고)" : ""}`}
                value={<>{pp(v.expected_residual_gap)}{sig ? ` ± ${sig.toFixed(2)}% (G1B σ 준용)` : ""}</>} />
            ) : null}
            {/* 기준가 라벨 명시 (발주자 8/18): 주식수 오독 방지 — "기준가(19:40 NXT 주가)" */}
            <Row label="GapScore · 방향 판단(G1A) / 기준가(19:40 NXT 주가)" value={<>{v?.gap_score ?? "—"} / {won(r.t2?.entry_px_virtual)}{r.t2?.entry_px_virtual ? "원" : ""}</>} />
            {/* 트리거 조건 줄 (사용자 지적 8/15: DC-PM이 화면에 없어 DC-NF와 비대칭) — 저장값 표시만, 판정 무접촉 */}
            {v ? (() => {
              const vv = v as { dc_pm?: number | null; r_basket?: number | null; three_way_agree?: boolean | null; economics_pass?: boolean | null };
              const dc = vv.dc_pm != null ? `${Math.round(vv.dc_pm * 100)}%${vv.dc_pm >= 0.6 ? " ✓" : " ✗"}` : "—";
              // 용어 (발주자 8/18): 바스켓은 |수익률| 절대값 조건 — "|-1.28%| ≥ 0.5% 통과" 형식으로 표기
              const rb = vv.r_basket;
              const basketTxt = rb == null ? "—" : `|${pp(rb)}| ${Math.abs(rb) >= 0.5 ? "≥ 0.5% 통과" : "< 0.5% 미달"}`;
              return <Row label="트리거 조건 (DC-PM ≥60% · 바스켓 |수익률|(미 반도체 프리장 평균, 크기 기준) ≥0.5% · 3자 일치 · 경제성)"
                value={<span className="text-[18px] md:text-[15px] md:text-[12px]">DC-PM {dc} · 바스켓 {basketTxt} · 3자 {vv.three_way_agree == null ? "—" : vv.three_way_agree ? "일치" : "불일치"} · 경제성 {vv.economics_pass == null ? "—" : vv.economics_pass ? "통과" : "미달"}</span>} />;
            })() : null}
            {(() => {
              // §C 야간선물 흐름 줄 (8/18 DC-NF 첫 수집부터) — 미래 예측 서술 금지, 현재 상태·일관성만
              const nf = (r.t2 as { nf?: { bars?: { t: string; pct: number }[]; level?: { pct: number } | null; dc_nf?: number | null } } | null)?.nf;
              if (nf?.bars?.length) {
                const lines = nfFlowLines({ bars: nf.bars, level: nf.level, dc_nf: nf.dc_nf }, betaOf["005930"], betaOf["000660"]);
                return (
                  <div className="border-b border-hairline/40 py-1.5 text-[18px] md:text-[15px] md:text-[12px]">
                    <p className="text-ink-80">{lines[0]}</p>
                    <p className="text-ink-48">{lines[1]} · {lines[2]}</p>
                  </div>
                );
              }
              const nfe = r.t2?.nf_evening as { t: string; pct: number; corrected?: boolean } | null | undefined;
              return <Row label="야간선물 초반 (E1·기록만)" value={nfe ? `${nfe.t} ${pp(nfe.pct)}${nfe.corrected ? " (정정)" : ""}` : "18:00~ 대기"} />;
            })()}
            <MtLine day={mtLatest.get(r.symbol)} />
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
            {/* §A 카드 하단 고정 각주 — 템플릿 자동 생성 */}
            {(() => {
              if (!v) return null;
              const g = (r.t2 as { grade?: { grade?: string; lean_dir?: "UP" | "DOWN" | null }; action?: { phase?: string } | null })!;
              return <Footnote f={t2Footnote({
                grade: g.grade?.grade ?? "Flat",
                dir: v.direction === "UP" || v.direction === "DOWN" ? v.direction : g.grade?.lean_dir ?? null,
                size: SIZE_KO[v.size ?? "0"] ?? v.size ?? "—", entryPx: r.t2?.entry_px_virtual ?? null,
                score: v.gap_score ?? 0, abstain: v.abstain_reason ?? null,
                phase: (r.t2?.action as { phase?: string } | null)?.phase ?? "가상",
                // 등급-행동 분리 (8/18): 등급 High/Low인데 direction NEUTRAL = 트리거 차단 밤 → 각주 사유 = 행동 라인의 괄호 사유
                blockedNoBet: (g.grade?.grade === "High" || g.grade?.grade === "Low") && v.direction === "NEUTRAL"
                  ? ((r.t2?.action as { line?: string } | null)?.line?.match(/·([^)]+)\)/)?.[1] ?? "트리거 조건 미달") : null,
              })} />;
            })()}
            {r.t2?.report_r1 ? (
              <details className="mt-2 text-[18px] md:text-[15px] md:text-[12px] text-ink-48"><summary>리포트 전문</summary>
                <pre className="mt-1 whitespace-pre-wrap rounded-[10px] bg-pearl/50 p-2 text-[17px] md:text-[14px] md:text-[11px] leading-relaxed text-ink-80">{r.t2.report_r1}</pre>
              </details>
            ) : null}
          </Card>
        );
      })}

      {/* G1B R1·R2 */}
      {bToday.map((r) => {
        const nfObs = r.night?.night_fut as { v: number | null; corrected?: boolean } | undefined;
        const r1a = r.r1?.action as ({ code: string; line: string; phase?: string; residual_sigma?: number | null } | null | undefined);
        const r2a = r.r2?.action as ({ code: string; line: string; phase?: string } | null | undefined);
        const prevClose = (r.r1 as { prev_close?: number | null } | null)?.prev_close ?? null;
        const fair2 = (r.r2 as { fair_gap_r2_pct?: number | null } | null)?.fair_gap_r2_pct ?? null;
        const expOpen2 = fair2 != null && prevClose ? Math.round(prevClose * (1 + fair2 / 100)) : null;
        return (
        <Card key={r.symbol} title={`${NAME[r.symbol] ?? r.symbol} — ${md(r.date)} 아침${(r.r1 as { g1a_ref?: { date?: string } | null } | null)?.g1a_ref?.date ? ` (← ${md((r.r1 as { g1a_ref?: { date?: string } }).g1a_ref!.date!)} 저녁 T2의 밤)` : ""}`} badge="G1B R1·R2">
          <ActionLine line={r.r1?.action?.line} />
          <Row label="R1 공정 갭 (07:20)" value={r.r1 ? <>{pp(r.r1.fair_gap_pct)} ± {r.r1.sigma_pct?.toFixed(2)}% · 예상시가 {won(r.r1.expected_open)}</> : "발행 전"} />
          {/* 미편입 전문가 신분 명기 (발주자 표기 지시 8/15 §2) — 리스트 부재 ≠ 누락 */}
          <Row label="가중 (Hedge)" value={<>
            {r.r1?.w_used ? Object.entries(r.r1.w_used).map(([k, v]) => `${k} ${v}`).join(" · ") : "—"}
            {nfObs?.v != null ? <span className="text-[17px] md:text-[14px] md:text-[11px] text-ink-48"> · 야간선물 관측 {pp(nfObs.v * 100)} (검증 중 — 챌린저 v1.1c 병행)</span> : null}
          </>} />
          {r.r1 ? <Footnote f={r1Footnote({ code: r1a?.code ?? "", line: r1a?.line, residualSigma: r1a?.residual_sigma ?? null, sigmaPct: r.r1.sigma_pct ?? null, fairGapPct: r.r1.fair_gap_pct ?? null, phase: r1a?.phase ?? "가상" })} /> : null}
          <ActionLine line={r.r2?.action?.line} />
          <Row label="R2 (08:55)" value={r.r2 ? <>{r.r2.signal}{r.r2.residual_sigma != null ? ` (${r.r2.residual_sigma}σ)` : ""}</> : "발행 전"} />
          {r.r2 ? <Footnote f={r2Footnote({ code: r2a?.code ?? "", residualSigma: r.r2.residual_sigma ?? null, expectedOpen: expOpen2, phase: r2a?.phase ?? "가상" })} /> : null}
          <MtLine day={mtLatest.get(r.symbol)} />
          {/* 절단 시각 공통 스냅샷 (발주자 검수 8/18 §2): 저녁 19:35 절단값은 G1A 저장값 인용 — 재조회 없음, T2 카드와 동일 값 */}
          {(() => {
            const gr = (r.r1 as { g1a_ref?: { nf_cut1935_pct?: number | null; nf_cut_t?: string | null; rule_score?: number | null } | null } | null)?.g1a_ref;
            const cov = (r.night as Record<string, unknown> | null)?.nf_coverage as { kind?: string; us_sessions?: number } | undefined;
            const covTxt = cov ? (cov.kind === "partial" ? ` ⚠커버리지 부분(미 세션 ${cov.us_sessions})` : cov.kind === "none" ? " (미 휴장 밤)" : "") : "";
            return <Row label={`야간선물 — 저녁 19:35 절단 / 아침 04:50 관측${covTxt}`}
              value={<>{gr?.nf_cut1935_pct != null ? `${pp(gr.nf_cut1935_pct)} (${gr.nf_cut_t ?? "19:35"} 절단·T2 공유값)` : "저녁 결측"} / {nfObs?.v != null ? <>{pp(nfObs.v * 100)}{nfObs.corrected ? <span className="text-[17px] md:text-[14px] md:text-[11px] text-ink-48"> (정정 — KRX 정본 소급)</span> : null}</> : "결측"}</>} />;
          })()}
          {(() => {
            // 4자 대조 (발주자 검수 8/18 §3): 룰 vs 야간선물 vs 번역 vs 실측 — 신호 대결 표본
            const fw = (r.labels as { four_way?: { rule_score?: number | null; nf_cut1935_pct?: number | null; fair_r1_pct?: number | null; actual_gap_pct?: number; hit?: { rule?: boolean | null; nf?: boolean | null; fair?: boolean | null } } } | null)?.four_way;
            if (!fw) return null;
            const mk = (h: boolean | null | undefined) => (h == null ? "" : h ? " ✓" : " ✗");
            return <Row label="4자 대조 (신호 대결 표본)" value={<span className="text-[18px] md:text-[15px] md:text-[12px]">룰 {fw.rule_score ?? "—"}{mk(fw.hit?.rule)} · 야간선물 {pp(fw.nf_cut1935_pct)}{mk(fw.hit?.nf)} · 번역 {pp(fw.fair_r1_pct)}{mk(fw.hit?.fair)} · <b>실측 {pp(fw.actual_gap_pct)}</b></span>} />;
          })()}
          <Row label="실측 갭 / R1 오차" value={r.labels ? <>{pp(r.labels.actual_gap_pct)} / TE {pp(r.labels.te_r1_pct)}</> : "09:35 채점 대기"} />
          {r.r1?.report ? (
            <details className="mt-2 text-[18px] md:text-[15px] md:text-[12px] text-ink-48"><summary>리포트 전문</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded-[10px] bg-pearl/50 p-2 text-[17px] md:text-[14px] md:text-[11px] leading-relaxed text-ink-80">{r.r1.report}{r.r2?.report ? "\n\n" + r.r2.report : ""}</pre>
            </details>
          ) : null}
        </Card>
        );
      })}

      {/* §B: 성적표·기회비용 — 서술형 판결문 (판정 코드→템플릿, 방향축 태그 자동) */}
      <Card title="G1A 성적 — 판결문 (베팅 밤 · 보류 기회비용)" badge="서술형">
        {aRows.filter((r) => ["UP", "DOWN"].includes(String(r.t2?.verdict?.direction)) && r.labels).map((r) => (
          <p key={`${r.date}-${r.symbol}`} className="border-b border-hairline/40 py-1.5 text-[18px] md:text-[15px] md:text-[12px] leading-relaxed text-ink-80">
            {r.date.slice(5)} {verdictSentence({
              name: NAME[r.symbol] ?? r.symbol, bet: true,
              gradeLabel: (r.t2 as { grade?: { label?: string } } | null)?.grade?.label ?? null,
              dir: r.t2?.verdict?.direction ?? null, score: r.t2?.verdict?.gap_score ?? null,
              abstain: r.t2?.verdict?.abstain_reason ?? null,
              L1: r.labels?.L1 ?? null, L1p: r.labels?.L1p ?? null, hit: r.outcome?.hit ?? null,
            })}
          </p>
        ))}
        {!aRows.some((r) => ["UP", "DOWN"].includes(String(r.t2?.verdict?.direction)) && r.labels)
          ? <p className="text-[16px] md:text-[13px] text-ink-48">베팅한 밤 없음 (전부 보류) — 아래 보류 기회비용 참조</p> : null}
        <p className="mt-3 mb-1 text-[18px] md:text-[15px] md:text-[12px] font-semibold text-ink-48">보류 밤 기회비용 (가상 기준가(19:40 NXT 주가) → 시가)</p>
        {aRows.filter((r) => r.t2?.verdict?.direction === "NEUTRAL" && r.labels?.L1p != null).slice(0, 6).map((r) => (
          <p key={`ab-${r.date}-${r.symbol}`} className="border-b border-hairline/40 py-1.5 text-[18px] md:text-[15px] md:text-[12px] leading-relaxed text-ink-80">
            {r.date.slice(5)} {verdictSentence({
              name: NAME[r.symbol] ?? r.symbol, bet: false,
              score: r.t2?.verdict?.gap_score ?? null, abstain: r.t2?.verdict?.abstain_reason ?? null,
              L1: r.labels?.L1 ?? null, L1p: r.labels?.L1p ?? null,
            })}
          </p>
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
        <Row label="TE 레짐 분리 (평상 / 이벤트)" value={(() => { const t = (m?.te_r1_by_regime ?? null) as { normal?: number | null; event?: number | null; n?: { normal: number; event: number } } | null; return t ? `평상 ${t.normal ?? "—"}% (${t.n?.normal ?? 0}밤) · 이벤트 ${t.event ?? "—"}% (${t.n?.event ?? 0}밤)` : "집계 전"; })()} />
        <Row label="TE_r1 중앙값" value={<>{m?.te_r1_median_pct != null ? `${m.te_r1_median_pct}%` : "—"} <span className="text-[17px] md:text-[14px] md:text-[11px] text-ink-48">(기준: 오프라인 1.5배 이내 = 삼전 ≤1.58% · 하닉 ≤2.38%)</span></>} />
        <Row label="절단 위반 (late)" value={String(m?.late_arrival_total ?? "—")} />
        <Row label="학습 상태 (CUSUM·bias·Hedge 가중)" value={<span className="text-[17px] md:text-[14px] md:text-[11px]">
          {["005930", "000660"].filter((s) => learnOf[s]).map((s) => {
            const l = learnOf[s];
            const cus = l.cusum;
            const flag = Math.abs(cus) >= 4 ? " ⚠뒤처짐" : "";
            return `${NAME[s]} CUSUM ${cus >= 0 ? "+" : ""}${cus.toFixed(1)}${flag} · bias ${l.bias >= 0 ? "+" : ""}${l.bias.toFixed(2)}%p · ${Object.entries(l.hedge_w).map(([k, v]) => `${k} ${v}`).join("/")} (${l.nights}밤)`;
          }).join("  |  ") || "상태 없음"}
          <i> — |CUSUM|≥4 = 모형이 한 방향으로 계속 뒤처짐(η 상향 검토 신호)</i>
        </span>} />
        <Row label="야간 대사 — 커버리지 분리 (일치/불일치/결측)" value={(() => {
          const c = (m?.nf_reconcile_by_coverage ?? null) as Record<string, { n: number; match: number; mismatch: number; missing: number }> | null;
          if (!c || !Object.keys(c).length) return "집계 전";
          const nm: Record<string, string> = { normal: "정상 밤", partial: "커버리지 부분(연휴)", none: "미 휴장", unknown: "미분류" };
          return <span className="text-[17px] md:text-[14px] md:text-[11px]">{Object.entries(c).map(([k, v]) => `${nm[k] ?? k} ${v.match}/${v.mismatch}/${v.missing} (n=${v.n})`).join(" · ")}</span>;
        })()} />
        <Row label="기능별 개시일" value={<span className="text-[17px] md:text-[14px] md:text-[11px]">야간선물 {eff.night_fut ?? "—"} · 예상체결 {eff.auction_est ?? "—"} · R2잔차 {eff.r2_residual ?? "—"} · 저녁야간선물 {eff.g1a_nf_evening ?? "—"}</span>} />
        <Row label="nf 리더보드 (pack_v1.1c 섀도)" value={(() => {
          // 발주자 8/15 정확도연동 §4 — "정확도에 따라 비중이 실제로 오르는가"를 눈으로 확인
          const lb = (m?.nf_leaderboard ?? null) as { shadow_nights?: number; review_at_nights?: number; by_symbol?: Record<string, { date: string; w_nf: number | null; loss_nf: number | null; te_v11c: number | null; te_champ: number | null }[]> } | null;
          if (!lb || !lb.by_symbol || !Object.keys(lb.by_symbol).length) return <span className="text-[17px] md:text-[14px] md:text-[11px]">섀도 개시 전 — 첫 라벨 밤부터 (심사 12거래밤)</span>;
          return <span className="text-[17px] md:text-[14px] md:text-[11px]">섀도 {lb.shadow_nights ?? 0}/{lb.review_at_nights ?? 12}밤 · {Object.entries(lb.by_symbol).map(([s, arr]) => {
            const last = arr[arr.length - 1];
            const first = arr[0];
            return `${NAME[s] ?? s} w_nf ${first?.w_nf ?? "—"}→${last?.w_nf ?? "—"} (loss ${last?.loss_nf ?? "—"} · TE v1.1c ${last?.te_v11c ?? "—"}% vs 챔피언 ${last?.te_champ ?? "—"}%)`;
          }).join(" / ")}</span>;
        })()} />
        <Row label="Lean 채점 (θ 인하 심사 증거·밤 단위)" value={(() => {
          const t = (m?.t2plus_compare ?? null) as { lean_score?: { n: number; hits: number; rate: number | null }; base_bets?: number; shadow_bets?: number; mosaic_bets?: number; nights_tracked?: number } | null;
          if (!t) return "집계 전";
          return <span className="text-[17px] md:text-[14px] md:text-[11px]">Lean {t.lean_score?.n ?? 0}밤 적중 {t.lean_score?.hits ?? 0} ({t.lean_score?.rate != null ? Math.round(t.lean_score.rate * 100) + "%" : "—"}) · 베팅가능밤 T2 {t.base_bets}/{t.nights_tracked} vs T2+ {t.shadow_bets} vs 모자이크 {t.mosaic_bets} <i>(동일 밤 2종목 = 표본 1)</i></span>;
        })()} />
        <Row label="보류 밤 집계 (D1·밤 단위)" value={abstain
          ? <span className="text-[17px] md:text-[14px] md:text-[11px]">{String(abstain.nights)}밤 · 실제 갭 평균 {pp(abstain.avg_abs_gap_pct as number)} / 최대 {pp(abstain.max_abs_gap_pct as number)} · 가상 놓친 |수익| 합 {pp(abstain.missed_virtual_sum_pct as number)}</span>
          : "집계 전"} />
        <Row label="D1 방향 축 (완화 증거 vs 재료 개선 증거)" value={(() => {
          // 방향 적중+차단 = θ·규칙 완화 심사의 증거 / 방향 오판 = 방향 재료(nf 등) 개선의 증거
          const ax = (abstain?.dir_axis ?? null) as Record<string, number> | null;
          if (!ax) return "집계 전 (다음 계기판 갱신부터)";
          return <span className="text-[17px] md:text-[14px] md:text-[11px]">오판 {ax["오판"] ?? 0} · 적중-문턱 {ax["적중_문턱"] ?? 0} · 적중-규칙 {ax["적중_규칙"] ?? 0} · 무방향 {ax["무방향"] ?? 0}</span>;
        })()} />
      </Card>

      <Disclaimer />
    </PageShell>
  );
}
