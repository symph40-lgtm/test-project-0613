// 일봉 갭 예측 (G1A·G1B) 대시보드 — 발주자 통합 지시 2026-08-12 반영판.
// A1: T2 맨 위 / A2: 베팅 보류 표기 / A3: 예상잔여갭±불확실성·사이징 헤드라인 / A4: TE 기준 병기 /
// A5: 운영 순서 1줄 / B: 행동 지시선(닫힌 목록·꼬리표) / C: 채점 2단 분리·보류 기회비용 / D: 보류 집계.
// 60일 log-only: 모든 판정 가상 — 실행 금지.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";
import { BIG_AFTER_BADGE, conflictV2, dualBasis, nfFlowLines, nfSessionEveningHead, nfSessionMorning, openExpText, r1Footnote, toAfterBasis, r2Footnote, t2Footnote, verdictSentence, type TwoLines } from "@/lib/g1/copy";
import { mtCardLines, MT_DISCLAIMER } from "@/lib/mt/report";
import type { MtDay } from "@/lib/mt/types";
import { NightFutSection, ThreePanelChart, type NightCurve, type PanelPoint } from "./nightfut";

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
    <div className="mt-2 rounded-[10px] bg-pearl/60 px-3 py-2 text-[15px] md:text-[12px] leading-relaxed">
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
    <div className="border-b border-hairline/40 py-1.5 text-[15px] md:text-[12px]">
      <p className="text-ink-80">{l.head}</p>
      <p className="text-ink-48">{l.panel}</p>
      <p className="text-ink-48">{l.tail}</p>
      {l.flags.length ? <p className="mt-0.5 text-[14px] md:text-[11px] font-semibold text-amber-700">{l.flags.join(" · ")}</p> : null}
      {/* 전환 선언 트랙 동결 (2026-08-16 발주자 판정 4 — 재채점 1회 미달·오탐률 86%): 화면 노출 없음, 로그만. 톤·패널·박스는 유지 */}
      <p className="text-[14px] md:text-[11px] text-ink-48"><i>톤 트랙 검증 미달 꼬리표: 방향 적중 54% (기준선 대비 초과 ±2%p 이내) — 참고만, 판정 무개입</i></p>
    </div>
  );
}

// 모바일 반응형 (발주자 8/19 §2): 좁은 화면은 라벨/값 세로 적층 + 값 줄바꿈 허용(break-words), md: 이상은 가로 배치
function Row({ label, value, stack }: { label: string; value: React.ReactNode; stack?: boolean }) {
  // stack (발주자 지적 8/21 저녁): 라벨이 긴 행은 가로 배치 시 값이 세로로 쥐어짜짐 → 라벨 위·값 아래 전폭
  if (stack) {
    return (
      <div className="flex flex-col gap-0.5 border-b border-hairline/40 py-1.5 text-[16px] md:text-[13px] last:border-b-0">
        <span className="text-ink-48">{label}</span>
        <span className="min-w-0 break-words text-ink-80">{value}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 border-b border-hairline/40 py-1.5 text-[16px] md:flex-row md:items-baseline md:justify-between md:gap-3 md:text-[13px] last:border-b-0">
      <span className="text-ink-48 md:shrink-0">{label}</span>
      <span className="min-w-0 break-words text-ink-80 md:text-right">{value}</span>
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
        {badge ? <span className="rounded-full bg-pearl px-2 py-0.5 text-[14px] md:text-[11px] font-semibold text-ink-48">{badge}</span> : null}
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
  r2: { residual_sigma?: number | null; residual_pct?: number | null; auction_est_px?: number | null; signal?: string; action?: Act; report?: string } | null;
  labels: { actual_gap_pct?: number; te_r1_pct?: number | null; after_basis?: { actual_gap_after_pct?: number | null } | null } | null;
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
  const learnOf: Record<string, { cusum: number; bias: number; hedge_w: Record<string, number>; nights: number; etaNights: number | null }> = {};
  for (const s of bState.data ?? []) {
    const st = s.state as { sigma_ewma?: Record<string, number>; cusum?: number; bias?: number; hedge_w?: Record<string, number>; nights?: number; challenger_eta?: { nights?: number } };
    if (st?.sigma_ewma?.normal) sigmaOf[s.symbol] = Math.sqrt(st.sigma_ewma.normal);
    learnOf[s.symbol] = { cusum: st?.cusum ?? 0, bias: st?.bias ?? 0, hedge_w: st?.hedge_w ?? {}, nights: st?.nights ?? 0, etaNights: st?.challenger_eta?.nights ?? null };
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
      <div className="mb-2 rounded-[14px] border border-red-200 bg-red-50 p-3 text-[15px] md:text-[12px] text-red-700">
        <b>전 판정 가상(log-only)</b> — 60일 검증 완료·게이트 통과 전까지 실행 금지.
      </div>
      {/* A5: 운영 순서 고정 안내 */}
      <p className="mb-4 rounded-[10px] bg-pearl/60 px-3 py-2 text-[15px] md:text-[12px] text-ink-48">
        운영 순서: <b>T2(저녁 결정) → R1(아침 재판·오판 시 프리장 청산) → R2(시가 확인)</b>
      </p>

      {/* MT 시장 톤 (KOSPI200) — 1단계 표시 전용. 종목 톤은 각 카드 안에 상시 줄로 들어간다. */}
      {mtLatest.has("KOSPI200") ? (
        <Card title={`시장 톤·에너지 — ${mtLatest.get("KOSPI200")!.date}`} badge="MT 1단계">
          <MtLine day={mtLatest.get("KOSPI200")} />
          <p className="mt-2 text-[14px] md:text-[11px] text-ink-48">{MT_DISCLAIMER}</p>
        </Card>
      ) : null}

      {/* 발주 A 8/20: 야간선물 전용 섹션 — T2 카드 위 */}
      {(() => {
        // 오늘 밤(진행중) 우선, 없으면 최근 세션: bars = G1A t2.nf.bars / cp·마감 = G1B 다음 라벨 행 night
        // [발주자 지적 8/21 02:27] 자정 넘김 버그 수정 — 종전 `aLatest === 오늘날짜` 판정은 새벽(00~06시)에
        // 무조건 거짓이라 완료 세션(8/19밤)으로 밀렸다. 진행 중 밤 = 저녁(18:00~)이면 오늘, 새벽(~06:00)이면 직전 영업일.
        const nowK = new Date(Date.now() + 9 * 3600e3);
        const todayK = nowK.toISOString().slice(0, 10);
        const hhK = nowK.toISOString().slice(11, 16);
        const prevBiz = (d: string) => { const x = new Date(d + "T00:00:00Z"); do { x.setUTCDate(x.getUTCDate() - 1); } while ([0, 6].includes(x.getUTCDay())); return x.toISOString().slice(0, 10); };
        const cand = hhK >= "18:00" ? todayK : hhK < "06:00" ? prevBiz(todayK) : null;
        const candBars = cand ? ((aRows.find((r) => r.date === cand)?.t2 as { nf?: { bars?: { t: string; pct: number }[] } } | null)?.nf?.bars ?? []) : [];
        const live = cand != null && candBars.length > 0;
        // [발주자 지적 8/22 아침] 폴백 = "10분봉이 있는 최신 세션" — 종전(06:00 마감값이 저장된 행)은 주말(금요일 밤은 토요일 마감 저장 경로 없음)에 한 세션 전으로 밀렸다
        const latestWithBars = aRows.find((r) => (((r.t2 as { nf?: { bars?: unknown[] } } | null)?.nf?.bars ?? []).length > 0))?.date ?? null;
        const sessionNight = live ? cand! : latestWithBars ?? (rows.find((r) => (r.night as Record<string, unknown> | null)?.night_fut)?.r1 as { g1a_ref?: { date?: string } } | null)?.g1a_ref?.date ?? aLatest ?? todayK;
        const bRow = rows.find((r) => ((r.r1 as { g1a_ref?: { date?: string } } | null)?.g1a_ref?.date ?? "") === sessionNight);
        const bars = live ? candBars : ((aRows.find((r) => r.date === sessionNight)?.t2 as { nf?: { bars?: { t: string; pct: number }[] } } | null)?.nf?.bars ?? []);
        const watch = (bRow?.night as Record<string, unknown> | null)?.watch as { cp?: Record<string, { t: string; nf_pct: number | null }> } | undefined;
        const nfo = bRow?.night?.night_fut as { v: number | null; t?: string; late_arrival?: boolean } | undefined;
        const cov = (bRow?.night as Record<string, unknown> | null)?.nf_coverage as { kind?: string } | undefined;
        const curve: NightCurve = {
          sessionNight, live,
          bars, cp2340: watch?.cp?.["2340"] ?? null, cp0300: watch?.cp?.["0300"] ?? null,
          // 마감 폴백: night_fut 미저장 세션(금요일 밤 등)은 06:00 이후 첫 봉을 마감으로 (06:10 수집 창 확장 8/22)
          closePct: !live ? (nfo?.v != null ? nfo.v * 100 : (bars.find((b) => b.t >= "06:00" && b.t < "12:00")?.pct ?? null)) : null,
          closeT: nfo?.v != null ? ((nfo as { t?: string } | undefined)?.t ?? "06:00") : (bars.find((b) => b.t >= "06:00" && b.t < "12:00")?.t ?? "06:00"),
          coverage: cov?.kind ?? null,
        };
        // [발주자 검수 8/20 밤 §1] T2 판정값 마커 — 세션 밤의 저녁 번역(잔여갭식 시가 예상) ÷ β → 지수축 병기
        const t2Marks = (["005930", "000660"] as const).map((s) => {
          const ar = aRows.find((x) => x.symbol === s && x.date === sessionNight);
          const oe = (ar?.t2 as { conflict_v2?: { openExp_resid?: number | null } } | null)?.conflict_v2?.openExp_resid ?? null;
          const b = betaOf[s] ?? 1.4;
          return { name: s === "005930" ? "삼" : "하", idxPct: oe != null && b > 0 ? Math.round((oe / b) * 100) / 100 : null };
        });
        // [발주자 8/20 밤 23시 2차] T2+ v2 예상갭 ◇ 마커 — 최종 예상갭(종목 %) ÷ β, 판정 시각(sv2.t) 위치
        const v2Marks = (["005930", "000660"] as const).map((s) => {
          const ar = aRows.find((x) => x.symbol === s && x.date === sessionNight);
          const sv2 = (ar?.t2 as { shadow_v2?: { t?: string; expected_gap_pct?: number | null } } | null)?.shadow_v2;
          const b = betaOf[s] ?? 1.4;
          return { name: s === "005930" ? "삼" : "하", t: sv2?.t ?? "19:45", idxPct: sv2?.expected_gap_pct != null && b > 0 ? Math.round((sv2.expected_gap_pct / b) * 100) / 100 : null };
        });
        // [발주자 지적 8/20 밤 23시] T2 매시 재판정(v2 시간별 트랙)을 같은 곡선에 — 시간당 1회 방향 마커 (위 삼전·아래 하닉)
        const hOf = (s: string) => ((aRows.find((x) => x.symbol === s && x.date === sessionNight)?.t2 as { shadow_v2?: { hourly?: { t: string; dir?: string; nf_pct?: number | null }[] } } | null)?.shadow_v2?.hourly ?? []);
        const hSs = hOf("005930"), hHx = hOf("000660");
        const minOfH = (t: string) => { const [h, m] = t.split(":").map(Number); return (h < 12 ? h + 24 : h) * 60 + m; };
        const v2Hourly = [...new Set([...hSs, ...hHx].map((h) => h.t.slice(0, 2)))]
          .map((hh) => {
            const a = hSs.find((h) => h.t.slice(0, 2) === hh) as { t: string; dir?: string; nf_pct?: number | null; expected_gap_pct?: number | null } | undefined;
            const b = hHx.find((h) => h.t.slice(0, 2) === hh) as { t: string; dir?: string; nf_pct?: number | null; expected_gap_pct?: number | null } | undefined;
            const t = (a ?? b)!.t;
            // [발주자 8/21 새벽] 매시 예상갭 값(종목 %) ÷ β → 지수축 — ◆삼전·◇하닉, 색=드리프트 방향
            return {
              t, dirSs: a?.dir ?? null, dirHx: b?.dir ?? null, nf_pct: a?.nf_pct ?? b?.nf_pct ?? null,
              expSsIdx: a?.expected_gap_pct != null ? Math.round((a.expected_gap_pct / (betaOf["005930"] ?? 1.4)) * 100) / 100 : null,
              expHxIdx: b?.expected_gap_pct != null ? Math.round((b.expected_gap_pct / (betaOf["000660"] ?? 1.4)) * 100) / 100 : null,
            };
          })
          .sort((p, q) => minOfH(p.t) - minOfH(q.t));
        // [v2.1 등재 8/22] v2.1 예상갭 마커 (청록 ◇)
        const v21Marks = (["005930", "000660"] as const).map((s) => {
          const ar = aRows.find((x) => x.symbol === s && x.date === sessionNight);
          const sv = (ar?.t2 as { shadow_v21?: { t?: string; expected_gap_pct?: number | null } } | null)?.shadow_v21;
          const b = betaOf[s] ?? 1.4;
          return { name: s === "005930" ? "삼" : "하", t: sv?.t ?? "19:45", idxPct: sv?.expected_gap_pct != null && b > 0 ? Math.round((sv.expected_gap_pct / b) * 100) / 100 : null };
        });
        return <NightFutSection curve={curve} betaSs={betaOf["005930"]} betaHx={betaOf["000660"]} t2Marks={t2Marks} v2Marks={v2Marks} v21Marks={v21Marks} v2Hourly={v2Hourly} />;
      })()}

      {/* A1: G1A T2 — 맨 위 */}
      {aToday.map((r) => {
        const v = r.t2?.verdict;
        const sig = sigmaOf[r.symbol];
        return (
          <Card key={r.symbol} title={`${NAME[r.symbol] ?? r.symbol} — ${md(r.date)} 저녁 결정${r.t2?.trigger_time ? ` · ${r.t2.trigger_time.slice(0, 5)} 발행` : ""} (채점: ${md(nextKrxDay(r.date))} 아침)`} badge="G1A T2">
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
                  {v.abstain_reason ? <span className="font-normal text-[15px] md:text-[12px] text-ink-48"> ({v.abstain_reason})</span> : null}
                </>);
              })() : "저녁 감시 대기"}
            </p>
            {(() => {
              const sc = (r.t2 as { event_scenario?: { beat?: string; miss?: string } })?.event_scenario;
              return sc ? <p className="mb-1 rounded-[8px] bg-pearl/60 px-2 py-1 text-[14px] md:text-[11px] text-ink-48">이벤트 시나리오 — {sc.beat} / {sc.miss}</p> : null;
            })()}
            {v ? (() => {
              // 기준점 통일 병기 (발주자 확정 8/19 밤: 정규 종가 15:30) + 교차 검증 + 상충 플래그 v2 — 저장값 우선, 없으면 현장 환산
              const t2x = r.t2 as { conflict_v2?: ReturnType<typeof conflictV2>; nf?: { level?: { nf_level?: number } } } | null;
              const nfl = t2x?.nf?.level?.nf_level ?? null;
              const rNxt = (v as { r_nxt_pre_entry?: number | null }).r_nxt_pre_entry ?? null;
              const cv = t2x?.conflict_v2 ?? conflictV2({ gapScore: v.gap_score ?? null, residGap: v.expected_residual_gap ?? null, nxtPx: r.t2?.entry_px_virtual ?? null, rNxt, nfLevel: nfl });
              const divergent = cv.divergence_pp != null && cv.divergence_pp >= 2;
              return (<>
                <Row label={`예상잔여갭 · 크기 추정(G1A: β_pm×바스켓−NXT 기반영)${cv.conflict ? ` ⚠상충(${cv.pairs.join("·")})` : ""}${v.direction === "NEUTRAL" ? " (가상 참고)" : ""}`}
                  value={<>{/* ■7 규격: 애프터比(T2 19:40 기준가) 단일화 + (종가比) 병기 */}
                    {dualBasis({ afterPct: v.expected_residual_gap ?? null, closePct: cv.openExp_resid })}
                    {cv.regClose ? <span className="text-ink-48"> · 기준 {cv.regClose.toLocaleString()}(종가)</span> : null}
                    {sig ? <span className="text-ink-48"> ± {sig.toFixed(2)}%{divergent ? " (이견 밤 — 실오차 더 클 수 있음)" : " (G1B σ 준용)"}</span> : null}</>} />
                {/* [발주자 지적 8/22 아침] 환산 사슬을 드러낸다: 19:35 절단 지수값 × β = 종가比 → 애프터比 (애프터가 종가보다 얼마나 떨어진 채 시작했는지가 둘의 차이) */}
                <Row label="교차 검증 — 야간선물 β환산 (19:35 절단 × β = 종가比 → 애프터比 환산)" value={<>{cv.openExp_nf != null ? <>
                    {(() => { const lv = t2x?.nf?.level as { pct?: number; beta_mkt?: number } | undefined; return lv?.pct != null ? <span className="text-ink-48">지수 {pp(lv.pct)} × β{(lv.beta_mkt ?? 0).toFixed(2)} = </span> : null; })()}
                    {dualBasis({ afterPct: toAfterBasis(cv.openExp_nf, r.t2?.entry_px_virtual ?? null, cv.regClose), closePct: cv.openExp_nf })}
                    {cv.divergence_pp != null ? <span className="text-ink-48"> · 괴리 {cv.divergence_pp}%p{divergent ? " — 시장 간 이견, 불확실성 높은 밤" : ""}</span> : null}</> : "야간선물 19:35 절단값 대기"}</>} />
                {/* [발주자 지시 8/22 아침] 상충이면 상충하는 값을 같은 자(종가比 시가 예상)로 나란히 비교 */}
                {cv.conflict ? <Row stack label="⚠ 상충 비교 — 같은 자(정규 종가 대비 내일 시가 예상)로 나란히"
                  value={<span className="text-[15px] md:text-[12px]">
                    룰 <b>{cv.ruleSign > 0 ? "상방" : cv.ruleSign < 0 ? "하방" : "무방향"}</b> (점수 {v.gap_score ?? "—"}) · NXT 경로 <b>{pp(cv.openExp_resid)}</b> · 야간선물 β환산 <b>{pp(cv.openExp_nf)}</b>
                    {" → 갈린 쌍: "}{cv.pairs.join(" / ")}{cv.divergence_pp != null ? ` (NXT–야간선물 괴리 ${cv.divergence_pp}%p)` : ""}
                  </span>} /> : null}
              </>);
            })() : null}
            {/* 기준가 라벨 명시 (발주자 8/18): 주식수 오독 방지 — "기준가(19:40 NXT 주가)" */}
            <Row label="GapScore · 방향 판단(G1A) / 기준가(19:40 NXT 주가)" value={<>{v?.gap_score ?? "—"} / {won(r.t2?.entry_px_virtual)}{r.t2?.entry_px_virtual ? "원" : ""}</>} />
            {/* 트리거 조건 줄 (사용자 지적 8/15: DC-PM이 화면에 없어 DC-NF와 비대칭) — 저장값 표시만, 판정 무접촉 */}
            {v ? (() => {
              const vv = v as { dc_pm?: number | null; r_basket?: number | null; three_way_agree?: boolean | null; economics_pass?: boolean | null };
              // [발주자 질문 8/21] DC-PM은 부호 없는 비율 — 어느 방향의 일관성인지는 바스켓 부호가 정한다 → 방향어 병기
              // [발주자 8/21 추가] 양쪽 부호 모두 표기 — 동방향(= DC-PM) 먼저, 반대 방향 = 100% − DC-PM (보합 묶음 제외 비율)
              const dc = (() => {
                if (vv.dc_pm == null) return "—";
                const same = Math.round(vv.dc_pm * 100), opp = 100 - same;
                const up = vv.r_basket != null && vv.r_basket > 0, flat = vv.r_basket == null || Math.abs(vv.r_basket) < 0.05;
                const pair = flat ? `${same}%` : up ? `상방 ${same}% · 하방 ${opp}%` : `하방 ${same}% · 상방 ${opp}%`;
                return `${pair}${vv.dc_pm >= 0.6 ? " ✓" : " ✗"}`;
              })();
              // 용어 (발주자 8/18): 바스켓은 |수익률| 절대값 조건 — "|-1.28%| ≥ 0.5% 통과" 형식으로 표기
              const rb = vv.r_basket;
              const basketTxt = rb == null ? "—" : `|${pp(rb)}| ${Math.abs(rb) >= 0.5 ? "≥ 0.5% 통과" : "< 0.5% 미달"}`;
              {/* [발주자 8/20 밤 §8] "종목 바스켓" 명시 — 종목별 구성(공통 아님) 오독 방지 */}
              return <Row stack label="트리거 조건 — 점수와 별개의 AND 게이트 (DC-PM ≥60% · 종목 바스켓 |수익률| ≥0.5% · 3자 일치 · 경제성) — 하나라도 ✗면 등급은 점수대로, 베팅만 보류"
                value={<span className="text-[15px] md:text-[12px]">DC-PM {dc} · 종목 바스켓(해당 종목 미 반도체 프리장 평균) {basketTxt} · 3자 {vv.three_way_agree == null ? "—" : vv.three_way_agree ? "일치 ✓" : "불일치 ✗"} · 경제성 {vv.economics_pass == null ? "—" : vv.economics_pass ? "통과 ✓" : "미달 ✗"}</span>} />;
            })() : null}
            {(() => {
              // §C 야간선물 흐름 줄 (8/18 DC-NF 첫 수집부터) — 미래 예측 서술 금지, 현재 상태·일관성만
              const nf = (r.t2 as { nf?: { bars?: { t: string; pct: number }[]; level?: { pct: number } | null; dc_nf?: number | null } } | null)?.nf;
              // 표기 규격 (발주자 8/19 저녁 §3): "오늘 밤 세션(진행중)" 라벨 고정 + 세션 밤짜·시각 병기 — 전날 밤 값과 혼동 차단.
              // [8/21 02:27 자정 버그 동반 수정] 새벽(~06:00)엔 직전 영업일 밤 세션이 아직 진행 중 — 종료로 표기하지 않는다.
              const nowT = new Date(Date.now() + 9 * 3600e3);
              const todayKst = nowT.toISOString().slice(0, 10);
              const dawnLive = nowT.toISOString().slice(11, 16) < "06:00" && (() => { const x = new Date(todayKst + "T00:00:00Z"); do { x.setUTCDate(x.getUTCDate() - 1); } while ([0, 6].includes(x.getUTCDay())); return x.toISOString().slice(0, 10); })() === r.date;
              const closed = r.date < todayKst && !dawnLive;
              if (nf?.bars?.length) {
                const lines = nfFlowLines({ bars: nf.bars, level: nf.level, dc_nf: nf.dc_nf }, betaOf["005930"], betaOf["000660"]);
                const lastT = nf.bars[nf.bars.length - 1].t;
                const cum = nf.level?.pct ?? nf.bars[nf.bars.length - 1].pct;
                const head = nfSessionEveningHead({ sessionNight: r.date, lastT, cumPct: cum, closed });
                return (
                  <div className="border-b border-hairline/40 py-1.5 text-[15px] md:text-[12px]">
                    <p className="text-ink-48 text-[14px] md:text-[11px] font-semibold">{closed ? `${md(r.date)} 밤 세션 (종료 — 새벽값은 아침 카드)` : "오늘 밤 세션 (진행중)"}</p>
                    <p className="text-ink-80">{head} — {lines[0].replace(/^야간선물 흐름: /, "")}</p>
                    <p className="text-ink-48">{lines[1]} · {lines[2]}</p>
                  </div>
                );
              }
              const nfe = r.t2?.nf_evening as { t: string; pct: number; corrected?: boolean } | null | undefined;
              return <Row label={closed ? `야간선물(${md(r.date)}밤) 초반 (E1·기록만)` : "야간선물 (오늘 밤 세션·진행중) 초반"} value={nfe ? `${nfe.t} ${pp(nfe.pct)}${nfe.corrected ? " (정정)" : ""}` : "18:00~ 대기"} />;
            })()}
            <MtLine day={mtLatest.get(r.symbol)} />
            {(() => {
              // 발주 D 8/20: T2+ v2 챌린저 줄 — base(야간선물 19:35×β) + drift 방향×확신도 → 예상갭
              const v2 = (r.t2 as { shadow_v2?: { base_stock_pct?: number; drift?: { dir?: string; conf?: number; invalidated?: string | null; components?: { key: string; vote: number }[] }; adj_pct?: number; expected_gap_pct?: number; grade?: string; confidence_vol?: number | null } } | null)?.shadow_v2;
              // [발주자 검수 8/20 밤 §2] 미출력 경위 명시: 8/20 밤은 배포(19:47)가 T2 확정(19:45:15)보다 늦어 미생성 —
              // 버그 아닌 배포 시점 문제. 캐치업 경로 추가로 재발 방지, 첫 실기록 = 8/21 19:45.
              if (!v2) return <Row label="T2+ v2 (야간선물 기준점+drift·챌린저)"
                value={r.date === "2026-08-20" ? "8/20 밤 미생성 — 배포 19:47 > T2 확정 19:45 (첫 실기록 8/21 19:45, 캐치업 경로 보강)" : "19:35 판정 대기 (8/20 등재)"} />;
              const dr = v2.drift;
              const votes = (dr?.components ?? []).filter((c) => c.vote !== 0).map((c) => `${c.key}${c.vote > 0 ? "↑" : "↓"}`).join(" ");
              return <Row label={`T2+ v2 (챌린저) — ${v2.grade ?? "—"}`}
                value={<span className="text-[14px] md:text-[11px]">base {pp(v2.base_stock_pct)} + drift {dr?.invalidated ? `무효화(${dr.invalidated})` : `${dr?.dir ?? "중립"}·확신 ${Math.round((dr?.conf ?? 0) * 100)}%`} → 예상갭 {pp(v2.expected_gap_pct)}{votes ? ` (${votes})` : ""}{v2.confidence_vol == null ? " · 거래량 배율 축적 중(강등 미적용)" : ""}</span>} />;
            })()}
            {(() => {
              // [v2.1 등재 8/22] 병행 챌린저 줄 — v2 바로 아래, 성분 개정판 (ⓐ' 다창+갭·ⓓ' 다창·ⓔ' 2등급)
              const v21 = (r.t2 as { shadow_v21?: { base_stock_pct?: number; drift?: { dir?: string; conf?: number; invalidated?: string | null; components?: { key: string; vote: number }[] }; expected_gap_pct?: number; grade?: string; inputs?: { events?: { tier2?: string[] } } } } | null)?.shadow_v21;
              if (!v21) return <Row label="T2+ v2.1 (성분 개정 챌린저 — 8/22 등재)" value={r.date <= "2026-08-22" ? "첫 판정 8/24(월) 19:45" : "19:35 판정 대기"} />;
              const dr = v21.drift;
              const votes = (dr?.components ?? []).filter((c) => c.vote !== 0).map((c) => `${c.key}${c.vote > 0 ? "↑" : "↓"}`).join(" ");
              return <Row label={`T2+ v2.1 (챌린저·성분 개정) — ${v21.grade ?? "—"}`}
                value={<span className="text-[14px] md:text-[11px]">base {pp(v21.base_stock_pct)} + drift {dr?.invalidated ? `무효화(${dr.invalidated})` : `${dr?.dir ?? "중립"}·확신 ${Math.round((dr?.conf ?? 0) * 100)}%`} → 예상갭 {pp(v21.expected_gap_pct)}{votes ? ` (${votes})` : ""}{v21.inputs?.events?.tier2?.length ? ` · 2급 ${v21.inputs.events.tier2.join("·")}` : ""}</span>} />;
            })()}
            {(() => {
              // [발주자 검수 8/20 밤 §2] 화면 정리: v2가 챌린저 정본 줄 — 구 T2+ 섀도(v1)·모자이크는 접힘으로 강등 (기록·집계는 분리 보존)
              const p = (r.t2 as { pieces?: Record<string, number | null> })?.pieces;
              const mo = (r.t2 as { mosaic?: { last?: { dir?: string; score?: number } } })?.mosaic;
              const es = (r.t2 as { e_shadow?: { grade?: string }; e_record?: { grade?: string | null; size?: string; e_low_checks?: { theta5: boolean; im_lt_1_5x: boolean | null; positioning_ok: boolean | null } | null } })?.e_record
                ? { grade: `${(r.t2 as { e_record?: { grade?: string | null } }).e_record!.grade ?? "—"} (본판정·가상) — E-Low 요건: θ5 ${(r.t2 as { e_record?: { e_low_checks?: { theta5: boolean } | null } }).e_record!.e_low_checks?.theta5 ? "✓" : "✗"}·IM ${(r.t2 as { e_record?: { e_low_checks?: { im_lt_1_5x: boolean | null } | null } }).e_record!.e_low_checks?.im_lt_1_5x == null ? "미조달" : "✓"}·포지셔닝 ${(r.t2 as { e_record?: { e_low_checks?: { positioning_ok: boolean | null } | null } }).e_record!.e_low_checks?.positioning_ok == null ? "미조달" : "✓"}` }
                : (r.t2 as { e_shadow?: { grade?: string } })?.e_shadow;
              return (<>
                <Row label="정보 조각 P1 유럽반도체" value={p?.p1_eu_semi_avg != null ? `${pp(p.p1_eu_semi_avg)} (ASML ${pp(p.p1_asml)}·IFX ${pp(p.p1_ifx)}·STM ${pp(p.p1_stm)})` : "수집 대기"} />
                {es ? <Row label={(r.t2 as { e_record?: unknown })?.e_record ? "E-등급 (4등급제 발효 8/20·본판정)" : "E-등급 섀도 (발효 전·전사)"} value={es.grade ?? "—"} /> : null}
                <details className="border-b border-hairline/40 py-1.5 text-[15px] md:text-[12px] text-ink-48">
                  <summary>구판 섀도 기록 (v1·모자이크 — v2로 대체, 분리 보존)</summary>
                  <p className="mt-1">T2+ 섀도 v1 (E2): {r.t2?.shadow?.last ? `${r.t2.shadow.last.dir} (score ${r.t2.shadow.last.score})` : "—"}</p>
                  <p>T2-모자이크: {mo?.last ? `${mo.last.dir} (score ${mo.last.score})` : "—"}</p>
                </details>
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
              <details className="mt-2 text-[15px] md:text-[12px] text-ink-48"><summary>리포트 전문</summary>
                <pre className="mt-1 whitespace-pre-wrap rounded-[10px] bg-pearl/50 p-2 text-[14px] md:text-[11px] leading-relaxed text-ink-80">{r.t2.report_r1}</pre>
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
        <Card key={r.symbol} title={`${NAME[r.symbol] ?? r.symbol} — ${md(r.date)} 아침${(r.labels as { big_after_night?: boolean } | null)?.big_after_night ? " ⚡애프터 대변동 밤" : ""}${(r.r1 as { g1a_ref?: { date?: string } | null } | null)?.g1a_ref?.date ? ` (← ${md((r.r1 as { g1a_ref?: { date?: string } }).g1a_ref!.date!)} 저녁 T2의 밤)` : ""}`} badge="G1B R1·R2">
          <ActionLine line={r.r1?.action?.line} />
          <Row label="R1 공정 갭 (07:20)" value={r.r1 ? <>{pp(r.r1.fair_gap_pct)} ± {r.r1.sigma_pct?.toFixed(2)}% · 예상시가 {won(r.r1.expected_open)}</> : "발행 전"} />
          {/* 미편입 전문가 신분 명기 (발주자 표기 지시 8/15 §2) — 리스트 부재 ≠ 누락 */}
          <Row label="가중 (Hedge)" value={<>
            {(r.r1 as { champion_pack?: string } | null)?.champion_pack?.includes("v1.1c") ? <b className="text-emerald-700">[{(r.r1 as { champion_pack?: string }).champion_pack}] </b> : null}
            {r.r1?.w_used ? Object.entries(r.r1.w_used).map(([k, v]) => `${k} ${v}`).join(" · ") : "—"}
            {nfObs?.v != null ? <span className="text-[14px] md:text-[11px] text-ink-48"> · 야간선물 새벽 {(nfObs as unknown as { t?: string }).t ?? ((r.night as Record<string, unknown> | null)?.night_fut_probe as { t?: string } | undefined)?.t ?? "04:50"} 관측 {pp(nfObs.v * 100)} (검증 중 — 챌린저 v1.1c 병행)</span> : null}
          </>} />
          {r.r1 ? <Footnote f={r1Footnote({ code: r1a?.code ?? "", line: r1a?.line, residualSigma: r1a?.residual_sigma ?? null, sigmaPct: r.r1.sigma_pct ?? null, fairGapPct: r.r1.fair_gap_pct ?? null, phase: r1a?.phase ?? "가상" })} /> : null}
          <ActionLine line={r.r2?.action?.line} />
          {/* [발주자 지시 8/20 밤 — R2 표기] 판정 줄 3숫자 규격: 실제값(동시호가)·이론값·차(원·%·σ) */}
          <Row label={`R2 (08:55) — ${(r.r2 as { champion_pack_r2?: string } | null)?.champion_pack_r2?.includes("교체") ? (r.r2 as { champion_pack_r2?: string }).champion_pack_r2 + "(공식)" : "챔피언(공식)"}`} value={r.r2 ? (() => {
            const est2 = r.r2!.auction_est_px ?? null;
            if (est2 && expOpen2 && r.r2!.residual_sigma != null) {
              const dw = est2 - expOpen2;
              return <span className="text-[15px] md:text-[12px]">동시호가 예상가 {won(est2)} vs 이론가 {won(expOpen2)} (차 {dw >= 0 ? "+" : "−"}{Math.abs(dw).toLocaleString()}·{pp(r.r2!.residual_pct)}·{r.r2!.residual_sigma}σ) → {r.r2!.signal}</span>;
            }
            return <>{r.r2!.signal}{r.r2!.residual_sigma != null ? ` (${r.r2!.residual_sigma}σ)` : ""}</>;
          })() : "발행 전"} />
          {(() => {
            // 발주 C 8/20: v1.1c 이론가 기준 잔차 병행 + 갈린 날 플래그 / ■7: 예상가·목표가 이원 병기 + 수렴 여지
            const rv = (r.r2 as { r2_residual_v11c?: { fair_gap_r2_pct?: number | null; residual_sigma?: number | null; signal?: string }; r2_diverged?: boolean; auction_est_px?: number | null; fair_gap_r2_pct?: number | null } | null);
            if (!rv?.r2_residual_v11c) return null;
            const vv = rv.r2_residual_v11c;
            const est = rv.auction_est_px ?? null;
            const entry = (r.r1 as { g1a_ref?: { entry?: number | null } } | null)?.g1a_ref?.entry ?? null;
            const f2 = rv.fair_gap_r2_pct ?? null;
            const estGapClose = est && prevClose ? Math.round(((est / prevClose - 1) * 100) * 100) / 100 : null;
            const estGapAfter = est && entry ? Math.round(((est / entry - 1) * 100) * 100) / 100 : null;
            const conv = f2 != null && estGapClose != null ? Math.round((f2 - estGapClose) * 100) / 100 : null;
            return (<>
              <Row label={`R2 병행 — v1.1c 이론가(야간선물 06:00 반영)${rv.r2_diverged ? " ⚠판정 갈림 (익일 채점)" : ""}`}
                value={(() => {
                  // [발주자 지시 8/20 밤] v1.1c 이중 잔차도 같은 3숫자 규격 — 두 이론가 중 어느 쪽이 시장과 가까운지 한눈에
                  const theoV = vv.fair_gap_r2_pct != null && prevClose ? Math.round(prevClose * (1 + vv.fair_gap_r2_pct / 100)) : null;
                  const dv = est != null && theoV != null ? est - theoV : null;
                  return <span className="text-[14px] md:text-[11px]">{vv.signal ?? "—"} — vs v1.1c 이론가 {theoV != null ? `${won(theoV)}원` : pp(vv.fair_gap_r2_pct)}{dv != null ? ` (차 ${dv >= 0 ? "+" : "−"}${Math.abs(dv).toLocaleString()}원·${vv.residual_sigma ?? "—"}σ)` : vv.residual_sigma != null ? ` (${vv.residual_sigma}σ)` : ""}</span>;
                })()} />
              {est ? <Row label="동시호가 예상가 (이원 병기·수렴 여지)"
                value={<span className="text-[14px] md:text-[11px]">{won(est)}원 = {estGapAfter != null ? `${pp(estGapAfter)} 애프터比` : "애프터比 —"} (종가比 {pp(estGapClose)}) · 이론가까지 {conv != null ? `${conv >= 0 ? "+" : ""}${conv}%p` : "—"}</span>} /> : null}
            </>);
          })()}
          {r.r2 ? <Footnote f={r2Footnote({ code: r2a?.code ?? "", residualSigma: r.r2.residual_sigma ?? null, expectedOpen: expOpen2, phase: r2a?.phase ?? "가상", est: r.r2.auction_est_px ?? null })} /> : null}
          <MtLine day={mtLatest.get(r.symbol)} />
          {/* 절단 시각 공통 스냅샷 (발주자 검수 8/18 §2): 저녁 19:35 절단값은 G1A 저장값 인용 — 재조회 없음, T2 카드와 동일 값 */}
          {(() => {
            const gr = (r.r1 as { g1a_ref?: { nf_cut1935_pct?: number | null; nf_cut_t?: string | null; rule_score?: number | null } | null } | null)?.g1a_ref;
            const cov = (r.night as Record<string, unknown> | null)?.nf_coverage as { kind?: string; us_sessions?: number } | undefined;
            const covTxt = cov ? (cov.kind === "partial" ? ` ⚠커버리지 부분(미 세션 ${cov.us_sessions})` : cov.kind === "none" ? " (미 휴장 밤)" : "") : "";
            // 표기 규격 (발주자 8/19 저녁 §1·§2): 세션 밤짜 + 시각 의무 병기, 화살표 연결, |Δ|≥1%p 자동 코멘트
            const sessionNight = (r.r1 as { g1a_ref?: { date?: string } | null } | null)?.g1a_ref?.date ?? null;
            const probeT = (nfObs as unknown as { t?: string } | undefined)?.t ?? ((r.night as Record<string, unknown> | null)?.night_fut_probe as { t?: string } | undefined)?.t ?? "04:50";
            return <Row label={`야간선물 — 같은 세션의 진행${covTxt}`}
              value={<>{nfSessionMorning({ sessionNight, cutT: gr?.nf_cut_t ?? "19:35", cutPct: gr?.nf_cut1935_pct ?? null, dawnT: probeT, dawnPct: nfObs?.v != null ? nfObs.v * 100 : null, dawnCorrected: nfObs?.corrected })}<span className="text-[14px] md:text-[11px] text-ink-48"> (저녁값 = T2 공유값{nfObs?.corrected ? " · 새벽값 KRX 정본 소급" : ""})</span></>} />;
          })()}
          {(() => {
            // 4자 대조 (발주자 검수 8/18 §3): 룰 vs 야간선물 vs 번역 vs 실측 — 신호 대결 표본
            const fw = (r.labels as { four_way?: { rule_score?: number | null; nf_cut1935_pct?: number | null; fair_r1_pct?: number | null; actual_gap_pct?: number; hit?: { rule?: boolean | null; nf?: boolean | null; fair?: boolean | null } } } | null)?.four_way;
            if (!fw) return null;
            const mk = (h: boolean | null | undefined) => (h == null ? "" : h ? " ✓" : " ✗");
            // 2판 분리 (발주자 시각 규율 8/19 §1): 저녁판 19:35 동일 절단 / 아침판 07:15 절단 — 절단 시각 명기
            const fwx = fw as typeof fw & { evening?: { resid_open_exp?: number | null; hit_resid?: boolean | null }; morning?: { v11c_pct?: number | null; hit_v11c?: boolean | null } };
            const ev = fwx.evening, mo = fwx.morning;
            return (<>
              <Row label="저녁판 대조 (19:35 동일 절단)" value={<span className="text-[15px] md:text-[12px]">룰 {fw.rule_score ?? "—"}{mk(fw.hit?.rule)} · 야간선물 {pp(fw.nf_cut1935_pct)}{mk(fw.hit?.nf)} · 저녁 번역(NXT 경로) {ev?.resid_open_exp != null ? <>{pp(ev.resid_open_exp)}{mk(ev.hit_resid)}</> : "—"} · <b>실측 {pp(fw.actual_gap_pct)}</b></span>} />
              <Row label="아침판 대조 (07:15 절단)" value={<span className="text-[15px] md:text-[12px]">챔피언 R1 {pp(fw.fair_r1_pct)}{mk(fw.hit?.fair)} · 챌린저 v1.1c {mo?.v11c_pct != null ? <>{pp(mo.v11c_pct)}{mk(mo.hit_v11c)}</> : "—"} · <b>실측 {pp(fw.actual_gap_pct)}</b></span>} />
            </>);
          })()}
          {/* [발주자 8/20 §3·§4] 밤의 궤적 한 줄 + 시장 간 리그전 (애프터 최종가 vs 야간선물 마감) */}
          {(() => {
            const pl = (r.night as Record<string, unknown> | null)?.path_line as string | undefined;
            const lg = (r.labels as { league?: { err_nxt?: number | null; err_nf?: number | null; winner?: string | null; nxt_close_pct?: number | null; nf_close_beta?: number | null; resid_open_exp?: number | null; err_resid?: number | null } } | null)?.league;
            // [발주자 8/20 밤 §5] 잔여갭 식 대비 행 — 구 라벨(err_resid 미저장)은 four_way.evening으로 현장 산출
            const residExp = lg?.resid_open_exp ?? ((r.labels as { four_way?: { evening?: { resid_open_exp?: number | null } } } | null)?.four_way?.evening?.resid_open_exp ?? null);
            const errResid = lg?.err_resid ?? (residExp != null && r.labels?.actual_gap_pct != null ? Math.round(Math.abs(residExp - r.labels.actual_gap_pct) * 100) / 100 : null);
            return (<>
              {pl ? <Row label="밤의 궤적 (애프터 판단이 밤새 검증됐는가)" value={<span className="text-[14px] md:text-[11px]">{pl.replace(/^밤의 궤적: /, "")}</span>} /> : null}
              {lg ? <Row label="시장 간 리그전 (시가 근접)" value={<span className="text-[14px] md:text-[11px]">애프터 최종 {pp(lg.nxt_close_pct)} (오차 {lg.err_nxt ?? "—"}) vs 야간선물 마감 β환산 {pp(lg.nf_close_beta)} (오차 {lg.err_nf ?? "—"}) → <b>{lg.winner === "nxt" ? "애프터 승" : lg.winner === "nf" ? "야간선물 승" : lg.winner === "tie" ? "무승부" : "—"}</b></span>} /> : null}
              {lg ? <Row label="잔여갭 식 대비 (애프터 유지 vs 차감 식 — 재검토 증거 축적)" value={<span className="text-[14px] md:text-[11px]">애프터 유지 {pp(lg.nxt_close_pct)} (오차 {lg.err_nxt ?? "—"}) vs 잔여갭식(차감) {pp(residExp)} (오차 {errResid ?? "—"})</span>} /> : null}
            </>);
          })()}
          {/* [발주자 재촉 8/20 밤] 헤드라인 = 애프터比 우선 (종가比 괄호) — 채점의 자(TE)는 종가 유지 */}
          <Row label="실측 갭 / R1 오차" value={r.labels ? <>{dualBasis({ afterPct: r.labels.after_basis?.actual_gap_after_pct ?? null, closePct: r.labels.actual_gap_pct ?? null })} / TE(종가 자) {pp(r.labels.te_r1_pct)}</> : "09:35 채점 대기"} />
          {r.r1?.report ? (
            <details className="mt-2 text-[15px] md:text-[12px] text-ink-48"><summary>리포트 전문</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded-[10px] bg-pearl/50 p-2 text-[14px] md:text-[11px] leading-relaxed text-ink-80">{r.r1.report}{r.r2?.report ? "\n\n" + r.r2.report : ""}</pre>
            </details>
          ) : null}
        </Card>
        );
      })}

      {/* §B: 성적표·기회비용 — 서술형 판결문 (판정 코드→템플릿, 방향축 태그 자동) */}
      <Card title="G1A 성적 — 판결문 (베팅 밤 · 보류 기회비용)" badge="서술형">
        {aRows.filter((r) => ["UP", "DOWN"].includes(String(r.t2?.verdict?.direction)) && r.labels).map((r) => (
          <p key={`${r.date}-${r.symbol}`} className="border-b border-hairline/40 py-1.5 text-[15px] md:text-[12px] leading-relaxed text-ink-80">
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
        <p className="mt-3 mb-1 text-[15px] md:text-[12px] font-semibold text-ink-48">보류 밤 기회비용 (가상 기준가(19:40 NXT 주가) → 시가)</p>
        {aRows.filter((r) => r.t2?.verdict?.direction === "NEUTRAL" && r.labels?.L1p != null).slice(0, 6).map((r) => (
          <p key={`ab-${r.date}-${r.symbol}`} className="border-b border-hairline/40 py-1.5 text-[15px] md:text-[12px] leading-relaxed text-ink-80">
            {r.date.slice(5)} {verdictSentence({
              name: NAME[r.symbol] ?? r.symbol, bet: false,
              score: r.t2?.verdict?.gap_score ?? null, abstain: r.t2?.verdict?.abstain_reason ?? null,
              L1: r.labels?.L1 ?? null, L1p: r.labels?.L1p ?? null,
            })}
          </p>
        ))}
      </Card>

      {/* 발주 B 8/20: 동시각 3판 비교표 — 라벨별 누적. 각 판의 절단 시각 명기. 오염 밤(8/15 이전 저녁값)은 비교 불가 */}
      <Card title="동시각 3판 비교 (라벨별 누적)" badge="절단 시각 통일">
        <p className="mb-1 text-[13px] md:text-[10px] text-ink-48">저녁판(19:35 동일 절단): 룰(GapScore 방향)·야간선물(19:35 β환산)·저녁 번역(NXT경로 시가 예상) vs 실측 / 아침판(07:15): 챔피언 R1·챌린저 v1.1c·야간선물(06:00 마감 β환산) vs 실측 / R2판(08:52): 챔피언 vs v1.1c 잔차 판정</p>
        {(() => {
          // 그래프 (발주 B — T2 값과 야간선물값을 같은 그래프에): 라벨별 누적, 세션 밤짜 = g1a_ref.date
          const build = (sym: string): PanelPoint[] => rows
            .filter((r) => r.symbol === sym && r.labels?.actual_gap_pct != null)
            .map((r) => {
              const sess = (r.r1 as { g1a_ref?: { date?: string } } | null)?.g1a_ref?.date ?? "";
              const a = aRows.find((x) => x.symbol === sym && x.date === sess);
              const t2x = a?.t2 as { verdict?: { gap_score?: number }; conflict_v2?: { openExp_resid?: number | null }; nf?: { level?: { pct?: number } }; nf_evening?: { pct?: number } } | null;
              const beta = betaOf[sym] ?? 1.4;
              const lvl = t2x?.nf?.level?.pct ?? t2x?.nf_evening?.pct ?? null;
              const nfo = r.night?.night_fut as { v: number | null; late_arrival?: boolean } | undefined;
              return {
                date: r.date, actual: r.labels!.actual_gap_pct ?? null,
                resid: t2x?.conflict_v2?.openExp_resid ?? null,
                nf1935b: lvl != null ? Math.round(lvl * beta * 100) / 100 : null,
                nfCloseB: nfo?.v != null && !nfo.late_arrival ? Math.round(nfo.v * 100 * beta * 100) / 100 : null,
                score: t2x?.verdict?.gap_score ?? null,
              };
            }).reverse();
          return (<>
            <ThreePanelChart name="삼성전자" pts={build("005930")} />
            <ThreePanelChart name="하이닉스" pts={build("000660")} />
          </>);
        })()}
        {rows.filter((r) => r.labels?.actual_gap_pct != null).slice(0, 8).map((r) => {
          const fw = (r.labels as { four_way?: { rule_score?: number | null; nf_cut1935_pct?: number | null; fair_r1_pct?: number | null; evening?: { resid_open_exp?: number | null }; morning?: { v11c_pct?: number | null } } } | null)?.four_way;
          const nfo = r.night?.night_fut as { v: number | null; corrected?: boolean } | undefined;
          const beta = betaOf[r.symbol] ?? 1.4;
          const nfCloseB = nfo?.v != null ? Math.round(nfo.v * 100 * beta * 100) / 100 : null;
          const act = r.labels!.actual_gap_pct!;
          const rv = (r.r2 as { r2_residual_v11c?: { signal?: string }; r2_diverged?: boolean; signal?: string } | null);
          const e = (x: number | null | undefined) => (x == null ? "—" : Math.abs(x - act).toFixed(2));
          return (
            <div key={`${r.date}-${r.symbol}`} className="border-b border-hairline/40 py-1.5 text-[14px] md:text-[11px]">
              <p className="font-semibold text-ink-80">{md(r.date)} {NAME[r.symbol] ?? r.symbol} — 실측 {dualBasis({ afterPct: (r.labels as { after_basis?: { actual_gap_after_pct?: number | null } } | null)?.after_basis?.actual_gap_after_pct ?? null, closePct: act })}</p>
              <p className="text-ink-48">저녁판: 룰 {fw?.rule_score ?? "—"} · 야간선물(19:35) {pp(fw?.nf_cut1935_pct)} (오차 {e(fw?.nf_cut1935_pct != null ? fw.nf_cut1935_pct * beta : null)}) · 번역(NXT경로) {pp(fw?.evening?.resid_open_exp)} (오차 {e(fw?.evening?.resid_open_exp)})</p>
              <p className="text-ink-48">아침판: 챔피언 {pp(fw?.fair_r1_pct)} (오차 {e(fw?.fair_r1_pct)}) · v1.1c {pp(fw?.morning?.v11c_pct)} (오차 {e(fw?.morning?.v11c_pct)}) · 야간선물(마감) {pp(nfCloseB)}{nfo?.corrected ? "(정정)" : ""} (오차 {e(nfCloseB)})</p>
              <p className="text-ink-48">R2판: 챔피언 {(r.r2 as { signal?: string } | null)?.signal ?? "—"} · v1.1c {rv?.r2_residual_v11c?.signal ?? "— (8/21 가동)"}{rv?.r2_diverged ? " ⚠갈림" : ""}</p>
            </div>
          );
        })}
      </Card>

      {/* C1: G1B 성적 (R1 오차) */}
      <Card title="G1B 성적 — R1 번역 오차" badge="TE_r1">
        {/* [발주자 재촉 8/20 밤] 실측 헤드라인 = 애프터比 우선 (종가比 괄호) — TE 채점은 종가 자 유지 */}
        {rows.filter((r) => r.labels).slice(0, 8).map((r) => (
          <Row key={`${r.date}-${r.symbol}`} label={`${r.date.slice(5)} ${NAME[r.symbol] ?? r.symbol}`}
            value={<>예측 {pp(r.r1?.fair_gap_pct)} → 실측 {dualBasis({ afterPct: r.labels?.after_basis?.actual_gap_after_pct ?? null, closePct: r.labels?.actual_gap_pct ?? null })} (TE·종가 자 {pp(r.labels?.te_r1_pct)})</>} />
        ))}
      </Card>

      {/* 계기판 (A4 기준 병기 + D1 보류 집계) */}
      <Card title="게이트 계기판 (D+15 판정 재료)" badge={String(m?.dryrun ?? "—")}>
        <Row label="가동률" value={`${m?.uptime_pct ?? "—"}%`} />
        <Row label="TE 레짐 분리 (평상 / 이벤트)" value={(() => { const t = (m?.te_r1_by_regime ?? null) as { normal?: number | null; event?: number | null; n?: { normal: number; event: number } } | null; return t ? `평상 ${t.normal ?? "—"}% (${t.n?.normal ?? 0}밤) · 이벤트 ${t.event ?? "—"}% (${t.n?.event ?? 0}밤)` : "집계 전"; })()} />
        <Row label="TE_r1 중앙값" value={<>{m?.te_r1_median_pct != null ? `${m.te_r1_median_pct}%` : "—"} <span className="text-[14px] md:text-[11px] text-ink-48">(기준: 오프라인 1.5배 이내 = 삼전 ≤1.58% · 하닉 ≤2.38%)</span></>} />
        {/* [발주자 8/20 밤 §7] 종목별 중앙값 분리 — 통합 중앙값이 하닉 대형 미스를 가리는 것 방지 */}
        <Row label="TE_r1 종목별 중앙값" value={(() => {
          const t = (m?.te_r1_by_symbol ?? null) as Record<string, { median: number | null; n: number }> | null;
          if (!t || !Object.keys(t).length) return "다음 계기판 갱신부터";
          return <span className="text-[14px] md:text-[11px]">{["005930", "000660"].filter((s) => t[s]).map((s) => `${NAME[s]} ${t[s].median ?? "—"}% (${t[s].n}밤)`).join(" · ")}</span>;
        })()} />
        <Row label="절단 위반 (late)" value={String(m?.late_arrival_total ?? "—")} />
        <Row label="학습 상태 (CUSUM·bias·Hedge 가중)" value={<span className="text-[14px] md:text-[11px]">
          {["005930", "000660"].filter((s) => learnOf[s]).map((s) => {
            const l = learnOf[s];
            const cus = l.cusum;
            const flag = Math.abs(cus) >= 4 ? " ⚠뒤처짐" : "";
            const etaBoost = Math.round((1 + Math.max(0, (Math.abs(cus) - 4) / 4)) * 100) / 100;
            return `${NAME[s]} CUSUM ${cus >= 0 ? "+" : ""}${cus.toFixed(1)}${flag} · bias ${l.bias >= 0 ? "+" : ""}${l.bias.toFixed(2)}%p · ${Object.entries(l.hedge_w).map(([k, v]) => `${k} ${v}`).join("/")} (${l.nights}밤) · 적응η 섀도 ${l.etaNights ?? 0}밤(현재 η×${etaBoost})`;
          }).join("  |  ") || "상태 없음"}
          <i> — |CUSUM|≥4 = 모형이 한 방향으로 계속 뒤처짐 → 적응 η 챌린저 등재 8/20 밤 (본판정 무접촉)</i>
        </span>} />
        <Row label="야간 대사 — 커버리지 분리 (일치/불일치/결측)" value={(() => {
          const c = (m?.nf_reconcile_by_coverage ?? null) as Record<string, { n: number; match: number; mismatch: number; missing: number }> | null;
          if (!c || !Object.keys(c).length) return "집계 전";
          const nm: Record<string, string> = { normal: "정상 밤", partial: "커버리지 부분(연휴)", none: "미 휴장", unknown: "미분류" };
          return <span className="text-[14px] md:text-[11px]">{Object.entries(c).map(([k, v]) => `${nm[k] ?? k} ${v.match}/${v.mismatch}/${v.missing} (n=${v.n})`).join(" · ")}</span>;
        })()} />
        <Row label="기능별 개시일" value={<span className="text-[14px] md:text-[11px]">야간선물 {eff.night_fut ?? "—"} · 예상체결 {eff.auction_est ?? "—"} · R2잔차 {eff.r2_residual ?? "—"} · 저녁야간선물 {eff.g1a_nf_evening ?? "—"}</span>} />
        <Row label="nf 리더보드 (pack_v1.1c 섀도)" value={(() => {
          // 발주자 8/15 정확도연동 §4 — "정확도에 따라 비중이 실제로 오르는가"를 눈으로 확인
          const lb = (m?.nf_leaderboard ?? null) as { shadow_nights?: number; review_at_nights?: number; by_symbol?: Record<string, { date: string; w_nf: number | null; loss_nf: number | null; te_v11c: number | null; te_champ: number | null }[]> } | null;
          if (!lb || !lb.by_symbol || !Object.keys(lb.by_symbol).length) return <span className="text-[14px] md:text-[11px]">섀도 개시 전 — 첫 라벨 밤부터 (심사 12거래밤)</span>;
          return <span className="text-[14px] md:text-[11px]">섀도 {lb.shadow_nights ?? 0}/{lb.review_at_nights ?? 12}밤 · {Object.entries(lb.by_symbol).map(([s, arr]) => {
            const last = arr[arr.length - 1];
            const first = arr[0];
            return `${NAME[s] ?? s} w_nf ${first?.w_nf ?? "—"}→${last?.w_nf ?? "—"} (loss ${last?.loss_nf ?? "—"} · TE v1.1c ${last?.te_v11c ?? "—"}% vs 챔피언 ${last?.te_champ ?? "—"}%)`;
          }).join(" / ")}</span>;
        })()} />
        {/* [발주자 8/22] 3자 병행 채점 — T2 vs v2 vs v2.1 (late 밤 제외). v2.1 핵심 심사 지표 = 침묵 실패율 */}
        <Row label="3자 병행 채점 — T2 / v2 / v2.1 (발화율 · 발화 적중 · 침묵 실패율 · near-miss)" value={(() => {
          const t = (m?.tri_compare ?? null) as Record<string, { n: number; fire_rate: number | null; hit_rate: number | null; silent_fail_rate: number | null; near_miss: number }> | null;
          if (!t || !Object.keys(t).length) return "첫 채점 밤부터 (8/24 아침)";
          const nm: Record<string, string> = { t2: "T2", v2: "v2", v21: "v2.1" };
          return <span className="text-[14px] md:text-[11px]">{["t2", "v2", "v21"].filter((k) => t[k]).map((k) => `${nm[k]} n${t[k].n}: 발화 ${t[k].fire_rate ?? "—"}% · 적중 ${t[k].hit_rate ?? "—"}% · 침묵실패 ${t[k].silent_fail_rate ?? "—"}% · near ${t[k].near_miss}`).join(" / ")}</span>;
        })()} />
        {/* [발주자 '적용 가속' §1·§2 8/20 밤] 조기 심사 자동 표시 — 상신은 발주자 판정 */}
        <Row label="v1.1c 조기 심사 (8밤 시점 — ⓐ승≥7/8 ⓑ개선>0 ⓒ악화=커버리지 공백뿐)" value={(() => {
          const e = (m?.v11c_early_review ?? null) as Record<string, { n: number; verdict: string; wins8?: number; med_improve_pp?: number | null }> | null;
          if (!e || !Object.keys(e).length) return "다음 계기판 갱신부터";
          return <span className="text-[14px] md:text-[11px]">{["005930", "000660"].filter((s) => e[s]).map((s) => `${NAME[s]} ${e[s].verdict}${e[s].wins8 != null ? ` (승 ${e[s].wins8}/8·개선중앙 ${e[s].med_improve_pp}%p)` : ""}`).join(" / ")}</span>;
        })()} />
        <Row label="R2 이론가 조기 심사 (8회 시점 — 승≥6/8·개선>0, 사전 등록)" value={(() => {
          const e = (m?.r2_theory_early_review ?? null) as Record<string, { n: number; verdict: string; wins8?: number; med_improve_pp?: number | null }> | null;
          if (!e || !Object.keys(e).length) return "다음 계기판 갱신부터";
          return <span className="text-[14px] md:text-[11px]">{["005930", "000660"].filter((s) => e[s]).map((s) => `${NAME[s]} ${e[s].verdict}${e[s].wins8 != null ? ` (승 ${e[s].wins8}/8·개선중앙 ${e[s].med_improve_pp}%p)` : ""}`).join(" / ")}</span>;
        })()} />
        <Row label="E-체계 채점 (헌법 발효 8/20 — D+60 심사 재료)" value={(() => {
          const e = (m?.e_system ?? null) as { lean_nights?: number; lean_hits?: number; lean_rate?: number | null; low_nights?: number; low_pnl_sum_pct?: number | null; prehistory_shadow_nights?: number } | null;
          if (!e) return "집계 전 (다음 계기판 갱신부터)";
          return <span className="text-[14px] md:text-[11px]">E-Lean 기울기 {e.lean_nights ?? 0}밤 적중 {e.lean_hits ?? 0} ({e.lean_rate != null ? Math.round(e.lean_rate * 100) + "%" : "—"}) · E-Low 발동 {e.low_nights ?? 0}밤 가상 손익 {e.low_pnl_sum_pct != null ? `${e.low_pnl_sum_pct >= 0 ? "+" : ""}${e.low_pnl_sum_pct}%` : "—"} · 전사(섀도) {e.prehistory_shadow_nights ?? 0}밤 별도</span>;
        })()} />
        <Row label="야간선물 단독 vs 챔피언 R1 (누적 오차 — v1.1c 승격 핵심 증거)" value={(() => {
          const t = (m?.nf_vs_champ ?? null) as { date: string; symbol: string; nf_solo_err: number | null; champ_err: number | null; nf_src_t: string; coverage: string; corrected: boolean }[] | null;
          if (!t?.length) return "집계 전 (다음 계기판 갱신부터)";
          const ok = t.filter((x) => x.nf_solo_err != null && x.champ_err != null);
          const nfWin = ok.filter((x) => x.nf_solo_err! < x.champ_err!).length;
          const med = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
          const partial = t.filter((x) => x.coverage === "partial" || x.coverage === "none").length;
          return <span className="text-[14px] md:text-[11px]">표본 {ok.length} (커버리지 공백 {partial} 별도) · 야간선물 우세 {nfWin}/{ok.length} · med 야간선물 {med(ok.map((x) => x.nf_solo_err!))?.toFixed(2) ?? "—"}% vs 챔피언 {med(ok.map((x) => x.champ_err!))?.toFixed(2) ?? "—"}% · 소스 {t.filter((x) => x.nf_src_t.startsWith("06")).length}밤=06:00마감/{t.filter((x) => !x.nf_src_t.startsWith("06")).length}밤=04:50(구)</span>;
        })()} />
        <Row label="Lean 채점 (θ 인하 심사 증거·밤 단위)" value={(() => {
          const t = (m?.t2plus_compare ?? null) as { lean_score?: { n: number; hits: number; rate: number | null }; base_bets?: number; shadow_bets?: number; mosaic_bets?: number; nights_tracked?: number } | null;
          if (!t) return "집계 전";
          return <span className="text-[14px] md:text-[11px]">Lean {t.lean_score?.n ?? 0}밤 적중 {t.lean_score?.hits ?? 0} ({t.lean_score?.rate != null ? Math.round(t.lean_score.rate * 100) + "%" : "—"}) · 베팅가능밤 T2 {t.base_bets}/{t.nights_tracked} vs T2+ {t.shadow_bets} vs 모자이크 {t.mosaic_bets} <i>(동일 밤 2종목 = 표본 1)</i></span>;
        })()} />
        <Row label="보류 밤 집계 (D1·밤 단위)" value={abstain
          ? <span className="text-[14px] md:text-[11px]">{String(abstain.nights)}밤 · 실제 갭 평균 {pp(abstain.avg_abs_gap_pct as number)} / 최대 {pp(abstain.max_abs_gap_pct as number)} · 가상 놓친 |수익| 합 {pp(abstain.missed_virtual_sum_pct as number)}</span>
          : "집계 전"} />
        <Row label="D1 방향 축 (완화 증거 vs 재료 개선 증거)" value={(() => {
          // 방향 적중+차단 = θ·규칙 완화 심사의 증거 / 방향 오판 = 방향 재료(nf 등) 개선의 증거
          const ax = (abstain?.dir_axis ?? null) as Record<string, number> | null;
          if (!ax) return "집계 전 (다음 계기판 갱신부터)";
          return <span className="text-[14px] md:text-[11px]">오판 {ax["오판"] ?? 0} · 적중-문턱 {ax["적중_문턱"] ?? 0} · 적중-규칙 {ax["적중_규칙"] ?? 0} · 무방향 {ax["무방향"] ?? 0}</span>;
        })()} />
      </Card>

      <Disclaimer />
    </PageShell>
  );
}
