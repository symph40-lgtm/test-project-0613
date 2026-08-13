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
  // 신호 알림 발송 (사용자 지시 2026-08-09: G1A·G1B 개발 문자는 발송 — 전역 정지의 발주자 승인 예외).
  // 회차당 두 종목 통합 1건 (LMS). 00~07시 금지 규칙과 무충돌 (R1 07:20·R2 08:55).
  const outbox: { subject: string; texts: string[] } = { subject: "", texts: [] };
  for (const symbol of G1B_SYMBOLS) {
    const row = await loadRow(date, symbol);
    let st: LearnState;
    try {
      st = await loadState(symbol);
    } catch (e) {
      // "정지는 시끄럽게" (발주자 원칙): 상태 오류 정지 시 발행 실패+사유를 동일 채널로.
      // 미발행은 계기판 가동률 결손으로 자동 집계됨 (r1/r2 부재 → uptime 하락).
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(`${symbol} 상태 오류 정지 — ${msg}`);
      // 알림 2계급 (발주자 판정): 이것은 '장애 알림' — 전역 정지 무관 상시 발송.
      // 단 판정·가격·방향 등 예측 내용 포함 금지 (사유 = 시스템 오류 문자열만).
      // 중복 억제: 동일 사유 모듈당 일 1회 — 연속 장애는 count 합산("지속 중"), 재발송 안 함.
      const prevHalt = (row.learn as { halt?: { reason: string; count: number } } | null)?.halt;
      const sameReason = prevHalt?.reason === msg.slice(0, 80);
      row.learn = { ...(row.learn ?? {}), halt: { reason: msg.slice(0, 80), count: (sameReason ? prevHalt!.count : 0) + 1, last_ts: new Date().toISOString() } };
      await saveRow(row);
      if (sameReason) continue; // 일 1회 원칙
      // 장애 알림 — 보류 기간엔 이메일 대체 (이메일 절충, 사용자 결정 8/10)
      const { sendG1Notify } = await import("@/lib/alerts/g1notify");
      const hr = await sendG1Notify("[G1B 정지] 시스템 장애", `[G1B 정지] ${date.slice(5)} ${symbol} R1/R2 발행 실패 — 상태 오류: ${msg.slice(0, 50)}`);
      notes.push(`장애 알림(${hr.via}) ${hr.sent}건`);
      continue;
    }
    const regime = regimeToday(date);

    // 야간선물 폐장 직전 스냅샷 (04:50~06:00) — 8/10 실측: 06시 배치는 폐장 후 빈 응답.
    // 8/11 첫 검증 실패 (night_fut 여전히 null·스냅샷 src 흔적 없음): 크론 권장창이 06:00~11:00라
    // 이 창을 호출하는 주체가 없는 것이 유력 — 크론 시작 04:45 확장은 발주자 설정(cron-job.org) 필요.
    // probe: 시도 자체를 기록해 '호출 없음'과 '호출됐지만 빈 응답'을 다음 검증에서 구분한다.
    if (hhmm >= "04:50" && hhmm < W.nightStart && (row.night?.night_fut?.v == null)) {
      const { fetchNightFutSnapshot } = await import("./data");
      const nf = await fetchNightFutSnapshot();
      row.night = { ...(row.night ?? {}), night_fut_probe: { t: hhmm, v: nf.v, src: nf.src } } as unknown as Record<string, Obs>;
      if (nf.v != null) {
        row.night = { ...(row.night ?? {}), night_fut: nf } as Record<string, Obs>;
        notes.push(`${symbol} 야간선물 스냅샷 ${(nf.v * 100).toFixed(2)}%`);
      }
      await saveRow(row);
    }
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
      // B: R1 행동 지시선 — 전일 저녁 G1A 판정(가상 포지션) 대조 (스펙 §5 조정 매트릭스)
      const { r1Action, phaseTag } = await import("@/lib/g1/action");
      const g1aRef = await admin.from("g1a_days").select("date,t2").eq("symbol", symbol)
        .lt("date", date).order("date", { ascending: false }).limit(1).maybeSingle();
      const refT2 = (g1aRef.data?.t2 ?? null) as { verdict?: { direction?: string }; entry_px_virtual?: number | null } | null;
      const act = r1Action(
        refT2?.verdict ? { direction: refT2.verdict.direction ?? "NEUTRAL", entry_px: refT2.entry_px_virtual ?? null } : null,
        expOpen, sigma, fair != null ? Math.round(fair * 100) / 100 : null, await phaseTag("r1"),
      );
      row.r1 = {
        fair_gap_pct: fair != null ? Math.round(fair * 100) / 100 : null,
        sigma_pct: sigma, q80_pct: q80, regime, w_used: wUsed,
        expected_open: expOpen, prev_close: kr.prevClose,
        experts: ex, virtual: true,
        action: act, g1a_ref: refT2 ? { date: g1aRef.data?.date, dir: refT2.verdict?.direction, entry: refT2.entry_px_virtual } : null,
        report: act.line + "\n" + buildR1(symbol, date, fair, sigma, q80, expOpen, wUsed, row.night, regime),
        sent_at: new Date().toISOString(),
      };
      await saveRow(row);
      outbox.subject = "[G1B R1] 야간 번역 (가상·log-only)";
      outbox.texts.push(row.r1.report as string);
      notes.push(`${symbol} R1 발행 (FairGap ${row.r1.fair_gap_pct ?? "결측"}%)`);
    } else if (hhmm >= W.morningStart && hhmm < C.cutoff.r2 && !row.morning) {
      row.morning = await collectMorning(symbol);
      await saveRow(row);
      notes.push(`${symbol} 아침 수집`);
    }
    // 예상체결 공표 시각 진단 (8/12 저녁 — 8/13 아침 1회성 실측): 08:31~09:04 각 슬롯의 원시값을
    // morning.auction_probe_* 에 기록만 한다. 절단(08:45) 이후 슬롯은 late_arrival — 판정 사용 금지.
    // 목적: "공표 개시가 절단보다 늦은가"를 확정 → 늦으면 스펙 충돌(R2 절단 vs 공표 시각)로 발주자 보고.
    if (hhmm >= "08:31" && hhmm <= "09:04" && row.morning && !row.morning[`auction_probe_${hhmm.replace(":", "")}` as string]) {
      const { fetchAuctionRaw } = await import("./data");
      const pr = await fetchAuctionRaw(symbol);
      row.morning = {
        ...row.morning,
        [`auction_probe_${hhmm.replace(":", "")}`]: { v: pr.v, fetch_ts: new Date().toISOString(), late_arrival: hhmm > C.cutoff.r2, src: `raw=${pr.raw}` },
      };
      await saveRow(row);
    }
    if (hhmm >= "08:50" && hhmm < C.cutoff.r2 && row.morning && row.morning.auction_est_px?.v == null && !row.r2) {
      // 예상체결 보충 (2026-08-11 결측 감사 — 최근 4거래일 4/4 결측 발견): 아침 수집이 08:00~08:29에
      // 완료되면 동시호가(08:30~) 전이라 예상체결이 null인데, !row.morning 게이트 탓에 영영 안 갱신됐다.
      // 동시호가 개시 후~절단(08:45) 사이에 이 필드만 보충한다. R2(08:55) 잔차 판정의 원천이라 중요.
      const { refetchAuction } = await import("./data");
      const a = await refetchAuction(symbol);
      if (a.v != null) {
        row.morning = { ...row.morning, auction_est_px: a };
        await saveRow(row);
        notes.push(`${symbol} 예상체결 보충 ${a.v}`);
      }
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
      const { r2Action, phaseTag: pt2 } = await import("@/lib/g1/action");
      const expOpen2 = fair2 != null && prevClose ? Math.round(prevClose * (1 + fair2 / 100)) : null;
      const act2 = r2Action(resSigma, expOpen2, est == null, await pt2("r2"));
      row.r2 = { fair_gap_r2_pct: fair2 != null ? Math.round(fair2 * 100) / 100 : null, auction_est_px: est, residual_pct: residual, residual_sigma: resSigma, signal, action: act2, virtual: true, report: act2.line + "\n" + buildR2(symbol, date, fair2, est, residual, resSigma, signal), sent_at: new Date().toISOString() };
      await saveRow(row);
      outbox.subject = "[G1B R2] 잔차 판정 (가상·log-only)";
      outbox.texts.push(row.r2.report as string);
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
  // 통합 발송 — 이메일 절충 (사용자 결정 2026-08-10): 문자 보류(~8/21) 기간엔 이메일 대체로
  // 침묵 규칙 유지, 해제 후 자동 문자 복귀. 발송 결과는 notes에 명시 (무음 실패 금지 — 8/10 교훈).
  if (outbox.texts.length) {
    const { sendG1Notify } = await import("@/lib/alerts/g1notify");
    const r = await sendG1Notify(outbox.subject, outbox.texts.join("\n\n"));
    notes.push(`발송(${r.via}) ${r.sent}건${r.errors.length ? ` · 오류 ${r.errors.join("; ")}` : ""} — ${outbox.subject}`);
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
  // 기능별 유효 개시일 (발주자 판정 8/11 §2 — 표본 회계 정직성):
  // 각 기능의 '첫 정상 가동일'을 기록 — 60일·게이트 판정의 해당 항목은 이 날짜부터 집계한다.
  // (예: R2 잔차 적중률 ≥65% 의 시계는 D+0이 아니라 effective_start.r2_residual부터)
  const firstDate = (pred: (r: Row) => boolean): string | null => {
    for (const d of [...byDate.keys()].sort()) if (byDate.get(d)!.some(pred)) return d;
    return null;
  };
  const effectiveStart = {
    night_fut: firstDate((r) => (r.night?.night_fut as Obs | undefined)?.v != null),
    auction_est: firstDate((r) => (r.morning?.auction_est_px as Obs | undefined)?.v != null),
    r2_residual: firstDate((r) => (r.r2 as { residual_sigma?: number | null } | null)?.residual_sigma != null),
    ah_excess: firstDate((r) => (r.night?.ah_excess as Obs | undefined)?.v != null),
    gdr: firstDate((r) => (r.night?.r_gdr as Obs | undefined)?.v != null),
  };
  const per = days.map((d) => {
    const rs = byDate.get(d)!;
    const r1ok = rs.filter((r) => r.r1).length, r2ok = rs.filter((r) => r.r2).length;
    const late = rs.reduce((a, r) => a + Object.values({ ...(r.night ?? {}), ...(r.morning ?? {}) }).filter((o) => (o as Obs).late_arrival).length, 0);
    const tes = rs.map((r) => r.labels?.te_r1_pct as number | null).filter((x): x is number => x != null);
    return { date: d, r1ok, r2ok, late_arrival: late, te_r1: tes };
  });
  const allTe = per.flatMap((p) => p.te_r1).sort((a, b) => a - b);
  // 중앙값 규약 (발주자 Q2 답변, 2026-08-12 문서화): **상위 중앙값(upper median)** —
  // 짝수 표본에서 보간(평균) 없이 sorted[floor(n/2)]의 실존 관측값을 쓴다.
  // 근거: ①실제 발생한 오차값만 보고(합성값 금지) ②짝수일 때 큰 쪽을 취해 성능을 후하게 보이지 않게(보수).
  // 예: [0.62, 1.00, 1.08, 2.75] → 보간 1.04가 아니라 1.08. D+15 게이트 판정도 이 규약.
  const med = allTe.length ? allTe[Math.floor(allTe.length / 2)] : null;
  const complete = per.filter((p) => p.r1ok === 2 && p.r2ok === 2).length;
  // D1 (발주자 8/12): G1A 보류 밤 집계 — θ 캘리브레이션의 공식 증거 + E2 T2+ 섀도 비교 + E1 개시일
  const ga = await admin.from("g1a_days").select("date,symbol,t2,labels").order("date", { ascending: true }).limit(120);
  type GaRow = { date: string; symbol: string; t2: Record<string, unknown> | null; labels: Record<string, unknown> | null };
  const gaRows = (ga.data ?? []) as GaRow[];
  const abst = gaRows.filter((r) => (r.t2?.verdict as { direction?: string } | undefined)?.direction === "NEUTRAL" && r.labels);
  const gaps = abst.map((r) => Math.abs(Number(r.labels?.L1 ?? NaN))).filter((x) => isFinite(x));
  const missed = abst.map((r) => Number(r.labels?.L1p ?? NaN)).filter((x) => isFinite(x));
  const g1aAbstain = {
    nights: abst.length,
    avg_abs_gap_pct: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 100) / 100 : null,
    max_abs_gap_pct: gaps.length ? Math.round(Math.max(...gaps) * 100) / 100 : null,
    missed_virtual_sum_pct: missed.length ? Math.round(missed.reduce((a, b) => a + Math.abs(b), 0) * 100) / 100 : null, // 가상 진입가→시가 |수익| 합
  };
  // Lean 채점 (발주자 8/12 §2): 베팅 없는 밤의 기울기 방향 vs 실측 갭 부호 — θ 인하 심사 1급 증거
  const leanRows = gaRows.filter((r) => {
    const g = (r.t2 as { grade?: { grade?: string; lean_dir?: string } } | null)?.grade;
    return g?.grade === "Lean" && g.lean_dir && r.labels?.L1 != null;
  });
  // 갭상승/갭하락 분리 집계 (발주자 8/13 §4 — 갭하락 판정 검증이 NXT ETF 재검토의 전제조건)
  const leanSplit = (dir: "UP" | "DOWN") => {
    const rows2 = leanRows.filter((r) => (r.t2 as { grade?: { lean_dir?: string } }).grade!.lean_dir === dir);
    const hits = rows2.filter((r) => (dir === "UP") === (Number(r.labels!.L1) > 0)).length;
    return { n: rows2.length, hits, rate: rows2.length ? Math.round((hits / rows2.length) * 100) / 100 : null };
  };
  const leanHits = leanRows.filter((r) => {
    const g = (r.t2 as { grade?: { lean_dir?: string } }).grade!;
    return (g.lean_dir === "UP") === (Number(r.labels!.L1) > 0);
  }).length;
  const dirOf = (o: unknown) => String((o as { last?: { dir?: string } } | undefined)?.last?.dir ?? "");
  const t2plus = {
    // E2·모자이크 비교표: 베팅 가능 밤 비율이 승격 심사 명시 지표 (발주자 8/12 §5)
    nights_tracked: gaRows.length,
    base_bets: gaRows.filter((r) => ["UP", "DOWN"].includes(String((r.t2?.verdict as { direction?: string })?.direction))).length,
    shadow_bets: gaRows.filter((r) => ["UP", "DOWN"].includes(dirOf(r.t2?.shadow))).length,
    mosaic_bets: gaRows.filter((r) => ["UP", "DOWN"].includes(dirOf((r.t2 as { mosaic?: unknown } | null)?.mosaic))).length,
    lean_score: { n: leanRows.length, hits: leanHits, rate: leanRows.length ? Math.round((leanHits / leanRows.length) * 100) / 100 : null,
                  갭상승: leanSplit("UP"), 갭하락: leanSplit("DOWN") },
    e_shadow_nights: gaRows.filter((r) => (r.t2 as { e_shadow?: unknown } | null)?.e_shadow).length,
  };
  const nfEveStart = gaRows.find((r) => (r.t2 as { nf_evening?: unknown } | null)?.nf_evening)?.date ?? null;
  const p1Start = gaRows.find((r) => ((r.t2 as { pieces?: Record<string, unknown> } | null)?.pieces)?.p1_eu_semi_avg != null)?.date ?? null;
  const metrics = {
    days_tracked: per.length, uptime_pct: per.length ? Math.round((complete / per.length) * 100) : 0,
    g1a_abstain: g1aAbstain, t2plus_compare: t2plus,
    te_r1_median_pct: med, offline_pred_x15: med != null ? (med <= 1.32 * 1.5 ? "정합(1.5배 이내)" : "초과") : null,
    late_arrival_total: per.reduce((a, p) => a + p.late_arrival, 0),
    effective_start: { ...effectiveStart, g1a_nf_evening: nfEveStart, p1_eu_semi: p1Start },
    dryrun: per.slice(0, C.dryRunDays).every((p) => p.r1ok === 2 && p.r2ok === 2) && per.length >= C.dryRunDays ? "통과 후보 — 3영업일 연속 완주" : "진행 중",
    daily: per.slice(0, 10),
  };
  const { error } = await admin.from("g1b_gate").upsert({ date, metrics });
  if (error) notes.push(`계기판 저장 실패: ${error.message}`);
}
