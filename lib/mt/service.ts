// MT 서비스 — 일일 사이클 (스펙 SPEC_MT_v04.md §3·§4.1).
//   15:40~16:20 KST  당일 MT 산출·저장 (일봉 종가 확정 후 — 룩어헤드 차단)
//   09:05~10:30 KST  라벨 소급 (방향 5일·게이트·내성)
// 1단계는 표시 전용: 본판정(G1A GapScore·G1B FairGap) 무접촉, 문자 발송 없음.

import { MT_CONFIG } from "./config";
import { fetchBreadthNow, fetchCauseTextByDate, fetchFlowParts, fetchMtBars, fetchSoxByDate } from "./data";
import { computeMtSeries, labelDirection } from "./engine";
import { loadMtDay, loadMtRecent, mtTablesReady, upsertMtDay } from "./store";
import type { Bar, MtDay, MtSymbol } from "./types";

const SYMBOLS: MtSymbol[] = ["005930", "000660", "KOSPI200"];
const W = { calcStart: "15:40", calcEnd: "16:20", labelStart: "09:05", labelEnd: "10:30" };

function kst(): { date: string; hhmm: string; weekday: number } {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16), weekday: d.getUTCDay() };
}

/** 3종목 + 재료를 한 번에 준비 — 소급 스크립트도 같은 함수를 쓴다 */
export async function loadMtUniverse(count = 400): Promise<{
  bars: Record<MtSymbol, Bar[]>;
  soxByDate: Map<string, number>;
  causeTextByDate: Map<string, string>;
}> {
  const [ss, hx, k200] = await Promise.all([
    fetchMtBars("005930", count), fetchMtBars("000660", count), fetchMtBars("KOSPI200", count),
  ]);
  const dates = [...new Set([...ss, ...hx, ...k200].map((b) => b.date))];
  const since = dates.sort()[0] ?? "2023-01-01";
  const [soxByDate, causeTextByDate] = await Promise.all([
    fetchSoxByDate(dates, since), fetchCauseTextByDate(),
  ]);
  return { bars: { "005930": ss, "000660": hx, KOSPI200: k200 }, soxByDate, causeTextByDate };
}

const closeMap = (bars: Bar[]) => new Map(bars.map((b) => [b.date, b.close]));

export async function computeToday(mode: "live" = "live"): Promise<{ notes: string[]; days: MtDay[] }> {
  const u = await loadMtUniverse(400);
  const breadth = await fetchBreadthNow();
  const notes: string[] = [];
  const days: MtDay[] = [];
  for (const symbol of SYMBOLS) {
    const bars = u.bars[symbol];
    if (bars.length < 80) { notes.push(`${symbol} 일봉 부족(${bars.length})`); continue; }
    const flow = symbol === "KOSPI200" ? null : await fetchFlowParts(symbol, 1);
    // 활성 부품 가중 (§4.2) — 섀도는 여기 들어오지 않는다. 미설정이면 전부 1.
    const { loadMtState } = await import("./store");
    const weights = ((await loadMtState(symbol)) as { weights?: Record<string, number> } | null)?.weights ?? undefined;
    // 후보 유지창(§1.4 해석)은 최근 며칠의 후보 이력을 본다 → 라이브도 최근 구간을 계산해 같은 함수를 통과시킨다.
    // (하루만 계산하면 소급과 값이 달라진다 — 엔진 이중화 금지 원칙)
    const series = computeMtSeries(symbol, bars, Math.max(80, bars.length - 30), {
      c1: { soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate },
      indexCloseByDate: symbol === "KOSPI200" ? undefined : closeMap(u.bars.KOSPI200),
      leaderCloseByDate: symbol === "KOSPI200" ? [closeMap(u.bars["005930"]), closeMap(u.bars["000660"])] : undefined,
      breadth, flow, weights, mode,
    });
    const day = series[series.length - 1];
    days.push(day);
    await upsertMtDay(day);
    notes.push(`${symbol} ${day.date} MT ${day.tone.mt} (${day.phase.top} ${Math.round(day.phase.P[day.phase.top] * 100)}%)`);
  }
  return { notes, days };
}

/** §4.1 라벨 소급 — 방향(5거래일)·게이트(T2 일치/충돌)·내성(악재일 반응 크기) */
export async function runLabels(): Promise<string[]> {
  const notes: string[] = [];
  const rows = (await loadMtRecent(120)).filter((r) => !r.labels);
  if (!rows.length) return notes;
  const u = await loadMtUniverse(400);

  // 게이트 라벨 재료: G1A T2 방향 + 실현 갭
  const g1a = new Map<string, { dir: string | null; L1: number | null; hit: boolean | null }>();
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data } = await createAdminClient().from("g1a_days").select("date,symbol,t2,labels,outcome").order("date", { ascending: false }).limit(200);
    for (const r of (data ?? []) as { date: string; symbol: string; t2: { verdict?: { direction?: string; gap_score?: number } } | null; labels: { L1?: number | null } | null; outcome: { hit?: boolean | null } | null }[]) {
      const v = r.t2?.verdict;
      const dir = v?.direction && v.direction !== "NEUTRAL" ? v.direction
        : v?.gap_score != null ? (v.gap_score >= 0.5 ? "UP" : v.gap_score <= -0.5 ? "DOWN" : null) : null;
      g1a.set(`${r.date}|${r.symbol}`, { dir, L1: r.labels?.L1 ?? null, hit: r.outcome?.hit ?? null });
    }
  } catch { /* g1a 미가동 환경 — 게이트 라벨만 결측 */ }

  for (const row of rows) {
    const bars = u.bars[row.symbol as MtSymbol];
    const i = bars.findIndex((b) => b.date === row.date);
    if (i < 0 || i + MT_CONFIG.label.horizonDays >= bars.length) continue; // 5거래일 미경과
    const dir5d = labelDirection(bars, i, row.tone.mt);

    const g = g1a.get(`${row.date}|${row.symbol}`);
    const mtSign = dir5d.mt_sign;
    const gate = g && g.dir
      ? {
          t2_dir: g.dir,
          agree: mtSign === 0 ? null : (g.dir === "UP") === (mtSign > 0),
          hit: g.hit ?? (g.L1 == null ? null : (g.dir === "UP" ? g.L1 > 0 : g.L1 < 0)),
        }
      : null;

    const c1 = row.common?.C1;
    const gapAbs = g?.L1 != null ? Math.abs(g.L1) : null;
    const resilience = c1 && c1.materialDir < 0
      ? { event: "악재일", abs_gap: gapAbs, mt_sign: mtSign }
      : null;

    const fresh = await loadMtDay(row.date, row.symbol as MtSymbol);
    if (!fresh) continue;
    fresh.labels = { dir5d, gate, resilience };
    await upsertMtDay(fresh);
    notes.push(`${row.symbol} ${row.date} 라벨 (5일 ${dir5d.ret5d ?? "—"}% · ${dir5d.hit == null ? "무방향" : dir5d.hit ? "적중" : "빗나감"})`);
  }
  return notes;
}

/**
 * §4.2 월간 재캘리브레이션 — 매월 초 1회. IC 산출 → 가중 **제안**을 섀도에 적재하고,
 * 이미 15일을 채운 섀도가 있으면 활성 가중으로 승격한다. C1 오분류율·부품 쌍 상관도 함께 기록.
 * 제안 단계에서 활성 가중을 바꾸지 않는다 (섀도 병행이 헌법).
 */
export async function runMonthlyRecal(today: string): Promise<string[]> {
  const notes: string[] = [];
  const month = today.slice(0, 7);
  const { c1MisclassRate, partIC, pairCorrelations, promoteWeights, proposeWeights } = await import("./opt");
  const { loadMtState, saveMtState } = await import("./store");
  const u = await loadMtUniverse(400);
  const recent = await loadMtRecent(400);
  for (const symbol of SYMBOLS) {
    const st = ((await loadMtState(symbol)) ?? {}) as import("./opt").MtOptState;
    if (st.updated_for === month) continue;
    // v0.4.2 동결 (발주자 판정 2026-08-16 §4): IC는 **라이브 축적분만** — 백필·소급 행(meta.mode≠live)은 3년 표본이라 제외
    const days = recent.filter((d) => d.symbol === symbol && d.labels?.dir5d && d.meta?.mode === "live");
    if (days.length < 20) { notes.push(`${symbol} 재캘리브레이션 보류 — 라벨 밤 ${days.length} (20 미만)`); continue; }
    const ic = partIC(days);
    const { proposed, demoted, notes: pnotes } = proposeWeights(st.weights ?? {}, ic);
    const bars = u.bars[symbol];
    const misclass = c1MisclassRate(bars, Math.max(1, bars.length - 60), symbol, {
      soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate,
    });
    const alerts = pairCorrelations(days);
    let next: import("./opt").MtOptState = {
      ...st,
      weights: st.weights ?? {},
      shadow: { weights: proposed, since: today, days: 0 },
      ic_history: [...(st.ic_history ?? []).slice(-11), { month, ic }],
      pair_corr: [...(st.pair_corr ?? []).slice(-11), { month, alerts }],
      c1_misclass: { month, rates: misclass },
      updated_for: month,
    };
    const pr = promoteWeights({ ...st, shadow: st.shadow }, today);   // 직전 달 섀도의 승격 심사
    if (pr.promoted) next = { ...next, weights: pr.state.weights };
    await saveMtState(symbol, next as unknown as Record<string, unknown>);
    notes.push(`${symbol} 재캘리브레이션 — 강등 ${demoted.length}개 · 쌍 상관 경보 ${alerts.length}건 · ${pr.note}${pnotes.length ? ` · ${pnotes[0]}` : ""}`);
  }
  return notes;
}

export async function runMtService(): Promise<{ ok: boolean; window: string; notes: string[] }> {
  const { date, hhmm, weekday } = kst();
  if (!(await mtTablesReady())) return { ok: false, window: "none", notes: ["마이그레이션 037 미적용 — mt_days 없음"] };
  if (weekday === 0 || weekday === 6) return { ok: true, window: "weekend", notes: [] };
  if (hhmm >= W.labelStart && hhmm <= W.labelEnd) {
    const notes = await runLabels();
    if (Number(date.slice(8, 10)) <= 3) notes.push(...(await runMonthlyRecal(date)));  // 월초 1회
    return { ok: true, window: "labels", notes };
  }
  if (hhmm >= W.calcStart && hhmm <= W.calcEnd) return { ok: true, window: "calc", notes: (await computeToday()).notes };
  return { ok: true, window: "idle", notes: [] };
}
