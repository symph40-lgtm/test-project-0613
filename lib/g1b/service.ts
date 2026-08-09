// G1B 라이브 서비스 — 창구별 자동 진행 (WORKORDER week4 §1~4). 전 기간 log-only.
//   06:00~07:15 야간 수집 → 07:15 절단 → 07:20 R1 발행(가상 지시)
//   08:00~08:45 아침 수집 → 08:45 절단 → 08:55 R2 발행(잔차 판정)
//   09:35~10:30 라벨 확정 → 일간 학습 갱신 → 게이트 계기판 집계
// A1-6: 게이트 D+0 = 3일 드라이런 통과일. 드라이런 판정도 계기판이 자동 산출.

import { createAdminClient } from "@/lib/supabase/admin";
import { FOMC_DECISION_DATES, CPI_RELEASE_DATES, ES_RELEASE_DATES } from "@/lib/predict-daily/eventCalendar";
import type { G1BSymbol } from "./config";
import { G1B_CONFIG as C, G1B_SYMBOLS } from "./config";
import { collectMorning, collectNight, krDaily, type Obs } from "./data";
import { combine, dailyUpdate, expertsR1, initState, sigmaNight, type Experts, type LearnState } from "./engine";
import { buildR1, buildR2 } from "./report";

type Row = {
  date: string; symbol: G1BSymbol;
  night: Record<string, Obs> | null; morning: Record<string, Obs> | null;
  r1: Record<string, unknown> | null; r2: Record<string, unknown> | null;
  ablation: Record<string, unknown> | null; labels: Record<string, unknown> | null;
  learn: Record<string, unknown> | null;
};

const kst = () => {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16), wd: d.getUTCDay() };
};

async function loadRow(date: string, symbol: G1BSymbol): Promise<Row> {
  const admin = createAdminClient();
  const { data } = await admin.from("g1b_days").select("*").eq("date", date).eq("symbol", symbol).maybeSingle();
  return (data as Row | null) ?? { date, symbol, night: null, morning: null, r1: null, r2: null, ablation: null, labels: null, learn: null };
}
async function saveRow(r: Row): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("g1b_days").upsert({ ...r, updated_at: new Date().toISOString() }, { onConflict: "date,symbol" });
  if (error) throw new Error(`g1b_days upsert: ${error.message}`);
}
async function loadState(symbol: G1BSymbol): Promise<LearnState> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("g1b_state").select("state").eq("symbol", symbol).maybeSingle();
  // 영속성 훈련(발주자 요건) 핵심: DB '오류'와 '행 없음'을 구분한다.
  // 오류 시 initState 폴백은 조용한 리셋 = 60일 오염이므로 즉시 정지가 옳다.
  if (error) throw new Error(`g1b_state 로드 실패 — 조용한 리셋 방지 위해 정지: ${error.message}`);
  return (data?.state as LearnState | undefined) ?? initState(symbol);
}
async function saveState(symbol: G1BSymbol, st: LearnState): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("g1b_state").upsert({ symbol, state: st, updated_at: new Date().toISOString() });
  if (error) throw new Error(`g1b_state upsert: ${error.message}`);
}

function regimeToday(date: string): string {
  const evs = new Set([...FOMC_DECISION_DATES, ...CPI_RELEASE_DATES, ...ES_RELEASE_DATES]);
  // 간밤 미 세션 날짜 근사: KRX일 − 1 (다중 세션 밤은 라이브에선 직전 영업일 판정으로 충분)
  const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1);
  const us = d.toISOString().slice(0, 10);
  return evs.has(us) || evs.has(date) ? "event" : "normal";
}

export async function runG1BService(): Promise<{ ok: boolean; window: string; notes: string[] }> {
  const { date, hhmm, wd } = kst();
  const notes: string[] = [];
  if (wd === 0 || wd === 6) return { ok: true, window: "weekend", notes };
  const admin = createAdminClient();
  const probe = await admin.from("g1b_days").select("date").limit(1);
  if (probe.error) return { ok: false, window: "none", notes: ["마이그레이션 035 미적용"] };

  const W = C.windows;
  for (const symbol of G1B_SYMBOLS) {
    const row = await loadRow(date, symbol);
    const st = await loadState(symbol);
    const regime = regimeToday(date);

    // 수집 재시도 (발주자 KIS 리스크 §2): 절단 전이면 핵심 결측(r_spx·r_soxx) 시 재수집 —
    // 크론 5분 간격 자체가 재시도 주기. 성공값은 유지, 결측만 갱신 (fetch_ts 최신).
    const coreMissing = (n: Record<string, Obs> | null) => !n || n.r_spx?.v == null || n.r_soxx?.v == null;
    if (hhmm >= W.nightStart && hhmm < C.cutoff.r1 && coreMissing(row.night)) {
      const fresh = await collectNight(symbol);
      row.night = row.night ? { ...fresh, ...Object.fromEntries(Object.entries(row.night).filter(([, o]) => o.v != null)) } : fresh;
      await saveRow(row);
      notes.push(`${symbol} 야간 수집${row.night.r_spx?.v == null ? " (핵심 결측 — 재시도 예정)" : ""}`);
    } else if (hhmm >= W.r1Publish && hhmm < W.morningStart && !row.r1) {
      if (!row.night) { row.night = await collectNight(symbol); for (const k of Object.keys(row.night)) row.night[k].late_arrival = true; notes.push(`${symbol} 야간 수집 지연 — late_arrival 전량`); }
      const ex = expertsR1(symbol, row.night, st);
      const { fair, wUsed } = combine(st, ex);
      const { sigma, q80 } = sigmaNight(symbol, st, regime);
      const kr = await krDaily(symbol);
      const expOpen = fair != null && kr.prevClose ? Math.round(kr.prevClose * (1 + fair / 100)) : null;
      // 층별 절제 + B1·B2 병행 (§3)
      row.ablation = {
        reg_only: ex.reg, combined: fair,
        B1: row.night.r_soxx && !row.night.r_soxx.late_arrival && row.night.r_soxx.v != null ? Math.round(row.night.r_soxx.v * (symbol === "005930" ? 0.49 : 0.76) * 10000) / 100 : null,
        B2: row.night.r_spx && !row.night.r_spx.late_arrival && row.night.r_spx.v != null ? Math.round(st.kalman.beta_mkt * st.kalman.b1 * row.night.r_spx.v * 10000) / 100 : null,
      };
      row.r1 = {
        fair_gap_pct: fair != null ? Math.round(fair * 100) / 100 : null,
        sigma_pct: sigma, q80_pct: q80, regime, w_used: wUsed,
        expected_open: expOpen, prev_close: kr.prevClose,
        experts: ex, virtual: true,
        report: buildR1(symbol, date, fair, sigma, q80, expOpen, wUsed, row.night, regime),
        sent_at: new Date().toISOString(),
      };
      await saveRow(row);
      notes.push(`${symbol} R1 발행 (FairGap ${row.r1.fair_gap_pct ?? "결측"}%)`);
    } else if (hhmm >= W.morningStart && hhmm < C.cutoff.r2 && !row.morning) {
      row.morning = await collectMorning(symbol);
      await saveRow(row);
      notes.push(`${symbol} 아침 수집`);
    } else if (hhmm >= W.r2Publish && hhmm < W.labelStart && row.r1 && !row.r2) {
      if (!row.morning) { row.morning = await collectMorning(symbol); for (const k of Object.keys(row.morning)) row.morning[k].late_arrival = true; }
      const asx = row.morning.r_asx?.late_arrival ? null : row.morning.r_asx?.v;
      const nk = row.morning.r_nk_fut?.late_arrival ? null : row.morning.r_nk_fut?.v;
      const gx2 = row.morning.gx2?.late_arrival ? null : row.morning.gx2?.v;
      const fair1 = row.r1.fair_gap_pct as number | null;
      const fair2 = fair1 != null ? fair1 + 0.1 * (asx ?? 0) * 100 + 0.1 * (nk ?? 0) * 100 + 0.3 * ((gx2 ?? 0) - (row.night?.gx?.v ?? 0)) * 100 : null;
      const est = row.morning.auction_est_px?.v ?? null;
      const prevClose = row.r1.prev_close as number | null;
      const sigma = row.r1.sigma_pct as number;
      let residual: number | null = null, resSigma: number | null = null, signal = "관측 결측 — 잔차 판정 보류";
      if (est && prevClose && fair2 != null) {
        residual = Math.round(((est / prevClose - 1) * 100 - fair2) * 100) / 100;
        resSigma = Math.round((residual / sigma) * 100) / 100;
        signal = Math.abs(resSigma) < C.thresholds.r2NoSignal ? "무신호" : Math.abs(resSigma) >= C.thresholds.r2Fire ? (resSigma < 0 ? "과소반영 — 시가 매수 후보(가상)" : "과잉반영 — 페이드 후보(가상·금지조건 미검)") : "관망";
      }
      row.r2 = { fair_gap_r2_pct: fair2 != null ? Math.round(fair2 * 100) / 100 : null, auction_est_px: est, residual_pct: residual, residual_sigma: resSigma, signal, virtual: true, report: buildR2(symbol, date, fair2, est, residual, resSigma, signal), sent_at: new Date().toISOString() };
      await saveRow(row);
      notes.push(`${symbol} R2 발행 (${signal})`);
    } else if (hhmm >= W.labelStart && hhmm <= W.labelEnd && row.r1 && !row.labels) {
      const kr = await krDaily(symbol);
      if (kr.todayOpen && kr.prevClose) {
        const actual = Math.round(((kr.todayOpen / kr.prevClose - 1) * 100) * 100) / 100;
        const f1 = row.r1.fair_gap_pct as number | null;
        const f2 = row.r2?.fair_gap_r2_pct as number | null | undefined;
        row.labels = {
          actual_open: kr.todayOpen, actual_gap_pct: actual,
          te_r1_pct: f1 != null ? Math.round(Math.abs(actual - f1) * 100) / 100 : null,
          te_r2_pct: f2 != null ? Math.round(Math.abs(actual - (f2 as number)) * 100) / 100 : null,
        };
        const ex = (row.r1.experts ?? {}) as Experts;
        const regime = (row.r1.regime as string) ?? "normal";
        const st2 = dailyUpdate(symbol, st, ex, row.r1.fair_gap_pct as number | null, actual, regime, row.night ?? {});
        row.learn = { hedge_w: st2.hedge_w, sigma_ewma: st2.sigma_ewma, bias: st2.bias, cusum: st2.cusum, pit_last: st2.pit_hist.at(-1), kalman_b1: st2.kalman.b1, clamp_hits: st2.kalman.clamp_hits };
        await saveState(symbol, st2);
        // 일 1회 상태 스냅샷 + 해시 (발주자 요건 §3 — 롤백이 상태까지 복원 가능하게)
        const { createHash } = await import("crypto");
        const hash = createHash("sha256").update(JSON.stringify(st2)).digest("hex").slice(0, 16);
        await admin.from("g1b_state_snapshots").upsert({ date, symbol, state: st2, pack_ref: "pack_v1.0", state_hash: hash });
        await saveRow(row);
        notes.push(`${symbol} 라벨·학습 (실측 ${actual}% · TE_r1 ${row.labels.te_r1_pct}%)`);
      }
    }
  }
  // 게이트 계기판 (T4) — 라벨 창 이후 하루 1회 집계
  if (hhmm >= W.labelStart && hhmm <= "11:00") {
    await updateGateDashboard(date, notes);
  }
  return { ok: true, window: hhmm, notes };
}

async function updateGateDashboard(date: string, notes: string[]): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("g1b_days").select("*").order("date", { ascending: false }).limit(40);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return;
  const byDate = new Map<string, Row[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const days = [...byDate.keys()].sort().reverse();
  const per = days.map((d) => {
    const rs = byDate.get(d)!;
    const r1ok = rs.filter((r) => r.r1).length, r2ok = rs.filter((r) => r.r2).length;
    const late = rs.reduce((a, r) => a + Object.values({ ...(r.night ?? {}), ...(r.morning ?? {}) }).filter((o) => (o as Obs).late_arrival).length, 0);
    const tes = rs.map((r) => r.labels?.te_r1_pct as number | null).filter((x): x is number => x != null);
    return { date: d, r1ok, r2ok, late_arrival: late, te_r1: tes };
  });
  const allTe = per.flatMap((p) => p.te_r1).sort((a, b) => a - b);
  const med = allTe.length ? allTe[Math.floor(allTe.length / 2)] : null;
  const complete = per.filter((p) => p.r1ok === 2 && p.r2ok === 2).length;
  const metrics = {
    days_tracked: per.length, uptime_pct: per.length ? Math.round((complete / per.length) * 100) : 0,
    te_r1_median_pct: med, offline_pred_x15: med != null ? (med <= 1.32 * 1.5 ? "정합(1.5배 이내)" : "초과") : null,
    late_arrival_total: per.reduce((a, p) => a + p.late_arrival, 0),
    dryrun: per.slice(0, C.dryRunDays).every((p) => p.r1ok === 2 && p.r2ok === 2) && per.length >= C.dryRunDays ? "통과 후보 — 3영업일 연속 완주" : "진행 중",
    daily: per.slice(0, 10),
  };
  const { error } = await admin.from("g1b_gate").upsert({ date, metrics });
  if (error) notes.push(`계기판 저장 실패: ${error.message}`);
}
