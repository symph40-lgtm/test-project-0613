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
import { challengerExperts, challengerUpdate, combine, combineW, dailyUpdate, etaChallengerUpdate, expertsR1, initChallenger, initEtaChallenger, initState, sigmaNight, type Experts, type LearnState } from "./engine";
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
  const admin = createAdminClient();
  const probe = await admin.from("g1b_days").select("date").limit(1);
  if (probe.error) return { ok: false, window: "none", notes: ["마이그레이션 035 미적용"] };

  const W = C.windows;
  // [발주 A — 결측 정정 8/20 밤 22시 (발주자 실측 22:20)] 야간 10분봉 전 구간 수집:
  // 종전 수집 창이 G1A T2 창(18:00~19:40)에 한정돼 19:35 이후 봉이 0개였다 — 발주 A "익일 09:00까지 전 구간" 미이행 정정.
  // */10 종일 크론이 호출하는 이 엔드포인트가 19:45~06:00 구간을 이어받는다 (저장처는 G1A와 동일 — 당일 곡선·vol 축적 공용).
  // 06:10까지: 06:00 틱이 세션 마감값(KIS CM은 마감 후에도 마감값 반환)을 마지막 봉으로 남긴다 — 주말엔 night_fut 저장 경로가 없어 이 봉이 유일한 마감 (8/22)
  if ((hhmm >= "19:45" || hhmm < "06:10") && wd !== 0 && !(wd === 6 && hhmm >= "18:00")) {
    await recordNightBars(hhmm, date, notes);
  }
  // [발주 D §5 — 매시 확장 8/20 밤] 시간별 drift 재판정 트랙 20:30~06:00, 시간당 1회(슬롯 = 시각 앞 2자리).
  // 관측·학습 전용(채점 정본 = 19:35 판정 불변) · 성분은 등록 축소판(ⓐ·ⓕ·누적 부호) 유지 — 성분 확장은 재등록 사항.
  // 크론이 오는 시각만 채워진다 — 매시 격자 등록은 발주자 설정(cron-job.org). 세션 없는 밤(일요일·토요일 저녁)은 제외.
  if ((hhmm >= "20:30" || hhmm < "06:00") && wd !== 0 && !(wd === 6 && hhmm >= "20:30")) {
    await recordHourlyDriftTrack(hhmm, date, notes);
  }
  // 주말 차단은 야간 창 뒤에 — 토요일 03:00(금요일 밤 세션 = 월요일 라벨)은 허용, 일·토 23:40은 세션 없음(nf 결측 기록)
  const isWeekend = wd === 0 || wd === 6;
  const nightWin = (hhmm >= "23:30" && hhmm <= "23:59") || (hhmm >= "02:50" && hhmm <= "03:20");
  if (isWeekend && !(nightWin && wd === 6 && hhmm < "04:00")) return { ok: true, window: "weekend", notes };
  // [발주자 8/20] 야간 감시 창 — 23:30~23:59(체크포인트 23:40) · 02:50~03:20(03:00). 판정 무개입, 기록·알림 전용.
  // 라벨 = 다음 거래일 (자정 전이면 내일, 자정 후면 오늘) — R1 행과 같은 행에 night.watch로 적재.
  if ((hhmm >= "23:30" && hhmm <= "23:59") || (hhmm >= "02:50" && hhmm <= "03:20")) {
    const slot = hhmm >= "23:30" ? "2340" : "0300";
    const labelDate = hhmm >= "23:30" ? (() => { const d = new Date(date + "T00:00:00Z"); do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); })() : date;
    const { takeCheckpoint, reverseCheck } = await import("./nightwatch");
    const cp = await takeCheckpoint(hhmm);
    for (const symbol of G1B_SYMBOLS) {
      const row = await loadRow(labelDate, symbol);
      const night = (row.night ?? {}) as Record<string, unknown>;
      const watch = (night.watch ?? { cp: {}, alert: null }) as { cp: Record<string, unknown>; alert: Record<string, unknown> | null };
      if (watch.cp[slot]) continue; // 슬롯당 1회
      watch.cp[slot] = cp;
      // §2 역행 경보 — 전일 저녁 T2 판정 방향 대조 (가상 포지션 = T2_BUY/T2_SELL_HOLDINGS, 방향 판정은 전부 대조)
      const sessionNight = hhmm >= "23:30" ? date : (() => { const d = new Date(date + "T00:00:00Z"); do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); })();
      const g1a = await admin.from("g1a_days").select("t2").eq("date", sessionNight).eq("symbol", symbol).maybeSingle();
      const t2 = g1a.data?.t2 as { verdict?: { direction?: string }; grade?: { lean_dir?: string | null; grade?: string } } | null;
      const dir = t2?.verdict?.direction && t2.verdict.direction !== "NEUTRAL" ? t2.verdict.direction : (t2?.grade?.grade === "High" || t2?.grade?.grade === "Low" ? t2.grade.lean_dir ?? null : null);
      const rc = reverseCheck(dir ?? null, cp.nf_pct);
      if (rc.fired && !watch.alert) {
        watch.alert = { t: hhmm, why: rc.why, nf_pct: cp.nf_pct, t2_dir: dir };
        const { sendG1Notify } = await import("@/lib/alerts/g1notify");
        const nm = symbol === "005930" ? "삼전" : "하닉";
        const hr = await sendG1Notify("[G1 야간 역행] 저녁 판단 뒤집히는 중 (가상)", `[G1 야간 역행·${hhmm}] ${nm} ${rc.why} (가상 — 따라 하지 않기)`);
        notes.push(`${symbol} 야간 역행 경보 발송(${hr.via}) ${hr.sent}건`);
      }
      // [발주 D §5 8/20] 시간별 drift 재판정 트랙은 매시 통합 함수(recordHourlyDriftTrack)가 담당 — 8/20 밤 매시 확장으로 이전.
      night.watch = watch;
      row.night = night as Record<string, Obs>;
      await saveRow(row);
      notes.push(`${symbol} 야간 CP ${slot} nf ${cp.nf_pct ?? "—"} nq ${cp.nq_fut_pct ?? "—"} soxx ${cp.soxx_pct ?? "—"}`);
    }
    return { ok: true, window: `night-${slot}`, notes };
  }
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
    // [발주자 시각 규율 8/19 §2] 06:00 세션 마감가로 교체 — R1 절단 07:15 이내 최신값 원칙.
    // 실측(8/15·8/19): KIS div=CM은 세션 마감 후에도 '직전 세션 마감값'을 반환한다 (8/10 "빈 응답"은 주간 코드 F 시절).
    // 06:00~07:14 첫 틱에 1회 읽어 night_fut을 마감가로 교체, 04:50 값은 night_fut_0450에 보존 (근접도 비교 재료).
    if (hhmm >= W.nightStart && hhmm < C.cutoff.r1 && row.night && !(row.night as Record<string, unknown>).night_fut_close_done) {
      const { fetchNightFutSnapshot } = await import("./data");
      const nfc = await fetchNightFutSnapshot();
      const prev = row.night.night_fut;
      (row.night as Record<string, unknown>).night_fut_close_done = true;
      if (nfc.v != null) {
        if (prev?.v != null && !(prev as unknown as { t?: string }).t?.startsWith("06")) (row.night as Record<string, unknown>).night_fut_0450 = { ...prev, t: (row.night.night_fut_probe as unknown as { t?: string } | undefined)?.t ?? "04:50" };
        row.night = { ...row.night, night_fut: { ...nfc, src: `KIS 야간선물 ${hhmm} 마감(CM)`, t: hhmm } as unknown as Obs } as Record<string, Obs>;
        notes.push(`${symbol} 야간선물 마감가 ${(nfc.v * 100).toFixed(2)}% (04:50 ${prev?.v != null ? (prev.v * 100).toFixed(2) : "—"}%)`);
      }
      await saveRow(row);
    }
    // 수집 재시도 (발주자 KIS 리스크 §2): 절단 전이면 핵심 결측(r_spx·r_soxx) 시 재수집 —
    // 크론 5분 간격 자체가 재시도 주기. 성공값은 유지, 결측만 갱신 (fetch_ts 최신).
    const coreMissing = (n: Record<string, Obs> | null) => !n || n.r_spx?.v == null || n.r_soxx?.v == null;
    if (hhmm >= W.nightStart && hhmm < C.cutoff.r1 && coreMissing(row.night)) {
      const fresh = await collectNight(symbol);
      row.night = row.night ? { ...fresh, ...Object.fromEntries(Object.entries(row.night).filter(([, o]) => o.v != null)) } : fresh;
      // [발주자 8/18 §3] 연휴 밤 커버리지 플래그 — 마감 후 미국 세션 수 (직전 KRX 거래일은 fchart 6봉의 마지막 확정일)
      try {
        const kr0 = await krDaily(symbol);
        const prevKrx = kr0.dates.length ? kr0.dates[0].replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : null;
        if (prevKrx && prevKrx < date) {
          const { G1A_CONFIG } = await import("@/lib/g1a/config");
          const { nightCoverage } = await import("./data");
          (row.night as Record<string, unknown>).nf_coverage = nightCoverage(date, prevKrx, G1A_CONFIG.abstain.usHolidays);
        }
      } catch { /* 커버리지 결측 허용 */ }
      await saveRow(row);
      notes.push(`${symbol} 야간 수집${row.night.r_spx?.v == null ? " (핵심 결측 — 재시도 예정)" : ""}`);
    } else if (hhmm >= W.r1Publish && hhmm < W.morningStart && !row.r1) {
      if (!row.night) { row.night = await collectNight(symbol); for (const k of Object.keys(row.night)) row.night[k].late_arrival = true; notes.push(`${symbol} 야간 수집 지연 — late_arrival 전량`); }
      const ex0 = expertsR1(symbol, row.night, st);
      // [승격 준비 8/20 밤 — playbook A] promo_v11c 마커 시 챔피언 결합 = nf 편입 전문가 집합 (가중은 이관돼 있음).
      // 이벤트 밤은 nf 제외 — 심사 표본(normal만)과 동일 조건 유지 (발주자가 달리 정하면 이 줄만 변경).
      const ex = st.promo_v11c ? (regime === "event" ? { ...challengerExperts(ex0), nf: null } : challengerExperts(ex0)) : ex0;
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
      const refT2 = (g1aRef.data?.t2 ?? null) as { verdict?: { direction?: string; gap_score?: number }; entry_px_virtual?: number | null; action?: { code?: string }; nf?: { level?: { pct?: number; cut_t?: string; nf_level?: number } } } | null;
      // 가상 포지션 유무 = T2 행동 코드 기준 (발주자 확인 8/19 §1): 매수(T2_BUY)·보유분 매도(T2_SELL_HOLDINGS)만 포지션.
      // 갭하락 경계(T2_DOWN_ALERT)·Lean·Flat·등급만(T2_GRADE_NOBET)은 무포지션 — 숏 오계상 차단.
      const hasPos = ["T2_BUY", "T2_SELL_HOLDINGS"].includes(String(refT2?.action?.code ?? ""));
      // [발주자 검수 8/18 §2·§3] 저녁 19:35 절단 야간선물 = G1A 저장값을 그대로 인용 (재조회 금지 — 판정=화면=로그)
      const nfCut = refT2?.nf?.level?.pct ?? null;
      // [발주자 시각 규율 8/19 §1] 저녁판 대조용 — 저녁 번역(잔여갭 경로 시가 예상, 정규 종가 대비) 저장값 인용
      const refV = (g1aRef.data?.t2 as { verdict?: { expected_residual_gap?: number | null; r_nxt_pre_entry?: number | null }; conflict_v2?: { openExp_resid?: number | null } } | null)?.verdict;
      const refCv = (g1aRef.data?.t2 as { conflict_v2?: { openExp_resid?: number | null } } | null)?.conflict_v2;
      const residOpenExp = refCv?.openExp_resid ?? (refV?.expected_residual_gap != null && refV?.r_nxt_pre_entry != null
        ? Math.round(((1 + refV.r_nxt_pre_entry / 100) * (1 + refV.expected_residual_gap / 100) - 1) * 10000) / 100 : null);
      // [발주자 8/20 §3] 밤의 궤적 — 저녁 NXT 마감(애프터 최종가, 정규 종가 대비) → 23:40 → 03:00 → 06:00 야간선물 마감
      let nxtClosePct: number | null = null;
      try {
        const { fetchNxtAfterMarket } = await import("@/lib/predict/kisMinute");
        const sess = (g1aRef.data?.date as string | undefined) ?? null;
        if (sess && kr.prevClose) {
          const bars = await fetchNxtAfterMarket(symbol, sess.replace(/-/g, ""), "200000");
          const last = bars?.length ? [...bars].sort((a, b) => a.time.localeCompare(b.time)).pop() : null;
          if (last && last.close > 0) nxtClosePct = Math.round((last.close / kr.prevClose - 1) * 10000) / 100;
        }
      } catch { /* 결측 허용 */ }
      const watch = (row.night as Record<string, unknown>).watch as { cp?: Record<string, import("./nightwatch").Checkpoint> } | undefined;
      const nfClose = row.night.night_fut && !row.night.night_fut.late_arrival ? row.night.night_fut.v : null;
      const { nightPathLine } = await import("./nightwatch");
      const pathLine = nightPathLine({ nxtClosePct, cp2340: watch?.cp?.["2340"] ?? null, cp0300: watch?.cp?.["0300"] ?? null, nfClosePct: nfClose != null ? nfClose * 100 : null, beta: st.kalman.beta_mkt });
      (row.night as Record<string, unknown>).nxt_close_pct = nxtClosePct;
      (row.night as Record<string, unknown>).path_line = pathLine;
      const act = r1Action(
        refT2?.verdict ? { direction: refT2.verdict.direction ?? "NEUTRAL", entry_px: refT2.entry_px_virtual ?? null, has_position: hasPos } : null,
        expOpen, sigma, fair != null ? Math.round(fair * 100) / 100 : null, await phaseTag("r1"),
      );
      // [발주자 8/15 §4] 야간 급변 플래그 — 야간 세션 내재갭 |±2%| 이상 밤 (절단 통과분만)
      const nfPct0 = row.night.night_fut?.late_arrival ? null : row.night.night_fut?.v;
      const nightFlash = nfPct0 != null && Math.abs(nfPct0 * 100) >= 2;
      // [발주자 8/15 정확도연동 §1 + 판정 §1] pack_v1.1c 챌린저 병행 (섀도·본판정 무접촉) — nf 5번째 전문가.
      // 이벤트 밤은 챔피언 유지 (판정 §1 승인안): 챌린저 결합은 normal 밤에만 갈라진다.
      // 공식 개시(nights 증가)는 첫 라벨 밤부터 — 그 전 R1은 참고 기록.
      const chSt = st.challenger_v11c ?? initChallenger(symbol, st.hedge_w);
      const chC = regime === "event" ? { fair, wUsed } : combineW(chSt.hedge_w, st.bias, challengerExperts(ex));
      // [발주자 8/20 밤 §4] 적응 η 챌린저 (기승인·등재 8/20 밤 — 하닉 CUSUM 8.0 상한 도달):
      // 전문가 집합·bias·σ 전부 챔피언과 동일, 다른 것은 η 하나 (CUSUM 연동) — 측정 축 통제.
      const etaSt = st.challenger_eta ?? initEtaChallenger(st.hedge_w);
      const chEta = combineW(etaSt.hedge_w, st.bias, ex);
      row.r1 = {
        fair_gap_pct: fair != null ? Math.round(fair * 100) / 100 : null,
        sigma_pct: sigma, q80_pct: q80, regime, w_used: wUsed,
        expected_open: expOpen, prev_close: kr.prevClose,
        experts: ex, virtual: true, night_flash: nightFlash,
        champion_pack: st.promo_v11c ? `pack_v1.1c(승격 ${st.promo_v11c.at.slice(5)})` : "pack_v1.0",
        challenger_v11c: { fair_gap_pct: chC.fair != null ? Math.round(chC.fair * 100) / 100 : null, w_used: chC.wUsed, nights: chSt.nights, virtual: true, event_champion_kept: regime === "event" },
        challenger_eta: { fair_gap_pct: chEta.fair != null ? Math.round(chEta.fair * 100) / 100 : null, w_used: chEta.wUsed, nights: etaSt.nights, virtual: true },
        action: act, g1a_ref: refT2 ? { date: g1aRef.data?.date, dir: refT2.verdict?.direction, entry: refT2.entry_px_virtual, rule_score: refT2.verdict?.gap_score ?? null, nf_cut1935_pct: nfCut, nf_cut_t: refT2.nf?.level?.cut_t ?? null , resid_open_exp: residOpenExp } : null,
        report: (nightFlash ? `⚠ 야간 급변: 야간선물 ${(nfPct0! * 100).toFixed(2)}% (|±2%| 이상 밤)\n` : "") + pathLine + "\n" +
          act.line + "\n" + buildR1(symbol, date, fair, sigma, q80, expOpen, wUsed, row.night, regime, { sessionNight: g1aRef.data?.date ?? null, cutT: refT2?.nf?.level?.cut_t ?? null, cutPct: nfCut }),
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
      // [발주 C 8/20] R2 잔차 이중 산출 — v1.1c 이론가(야간선물 06:00 마감 반영) 기준 병행. 공식 판정은 챔피언 불변.
      // 야간선물 가중 수동 상향 금지 — v1.1c 내 자동 증감(일일 채점)만 (원칙 명기).
      const fair1V = (row.r1.challenger_v11c as { fair_gap_pct?: number | null } | undefined)?.fair_gap_pct ?? null;
      const fair2V = fair1V != null ? fair1V + 0.1 * (asx ?? 0) * 100 + 0.1 * (nk ?? 0) * 100 + 0.3 * ((gx2 ?? 0) - (row.night?.gx?.v ?? 0)) * 100 : null;
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
      // [발주자 8/15 정확도연동 §3] 야간 마감(06:00) 내재갭×β_mkt vs 동시호가 예상체결 정합성 (섀도 기록).
      // 동방향 → 잔차 신호 정상 / 역방향 → 사이징 1단계 강등(가상). 미세(양쪽 |0.3%| 미만)는 판정 보류 — 구현 재량.
      const nfV2 = row.night?.night_fut?.late_arrival ? null : row.night?.night_fut?.v;
      const nfGap2 = nfV2 != null ? Math.round(nfV2 * 100 * st.kalman.beta_mkt * 100) / 100 : null;
      const aucGap2 = est && prevClose ? Math.round(((est / prevClose - 1) * 100) * 100) / 100 : null;
      // v1.1c 잔차 병행 (발주 C §1·§2): 갈린 날 플래그 — R2 이론가 교체 승격 심사 증거
      let resV: number | null = null, resSigV: number | null = null, sigV = "산출 불가";
      if (est && prevClose && fair2V != null) {
        resV = Math.round(((est / prevClose - 1) * 100 - fair2V) * 100) / 100;
        resSigV = Math.round((resV / sigma) * 100) / 100;
        sigV = Math.abs(resSigV) < C.thresholds.r2NoSignal ? "무신호" : Math.abs(resSigV) >= C.thresholds.r2Fire ? (resSigV < 0 ? "과소반영 — 시가 매수 후보(가상)" : "과잉반영 — 페이드 후보(가상·금지조건 미검)") : "관망";
      }
      const r2Diverged = resSigma != null && resSigV != null &&
        ((Math.abs(resSigma) >= C.thresholds.r2Fire) !== (Math.abs(resSigV) >= C.thresholds.r2Fire) || (Math.sign(resSigma) !== Math.sign(resSigV) && Math.abs(resSigma) >= C.thresholds.r2Fire));
      const nfCons = nfGap2 == null || aucGap2 == null ? "결측 — 검사 불가"
        : Math.abs(nfGap2) < 0.3 || Math.abs(aucGap2) < 0.3 ? "판정 보류(미세)"
        : Math.sign(nfGap2) === Math.sign(aucGap2) ? "동방향 — 잔차 신호 정상"
        : "역방향 — 사이징 1단계 강등(가상)";
      // [승격 준비 8/20 밤 — playbook B] promo_r2_v11c 마커 시 공식 이론가 = v1.1c, 구 이론가는 병행으로 강등 (이원 저장 유지)
      const promoR2 = Boolean(st.promo_r2_v11c);
      const fair2O = promoR2 && fair2V != null ? fair2V : fair2;
      const residualO = promoR2 && fair2V != null ? resV : residual;
      const resSigmaO = promoR2 && fair2V != null ? resSigV : resSigma;
      const signalO = promoR2 && fair2V != null ? sigV : signal;
      const expOpen2 = fair2O != null && prevClose ? Math.round(prevClose * (1 + fair2O / 100)) : null;
      const act2 = r2Action(resSigmaO, expOpen2, est == null, await pt2("r2"));
      const paraTheo = promoR2
        ? (fair2 != null && prevClose ? Math.round(prevClose * (1 + fair2 / 100)) : null)
        : (fair2V != null && prevClose ? Math.round(prevClose * (1 + fair2V / 100)) : null);
      row.r2 = { fair_gap_r2_pct: fair2O != null ? Math.round(fair2O * 100) / 100 : null, auction_est_px: est, residual_pct: residualO, residual_sigma: resSigmaO, signal: signalO, action: act2, virtual: true,
        champion_pack_r2: promoR2 ? `v1.1c 이론가(교체 ${st.promo_r2_v11c!.at.slice(5)})` : "챔피언 이론가",
        nf_consistency: { nf_gap_x_beta: nfGap2, auction_gap_pct: aucGap2, verdict: nfCons },
        r2_residual_champ: { fair_gap_r2_pct: fair2 != null ? Math.round(fair2 * 100) / 100 : null, residual_pct: residual, residual_sigma: resSigma, signal },
        r2_residual_v11c: { fair_gap_r2_pct: fair2V != null ? Math.round(fair2V * 100) / 100 : null, residual_pct: resV, residual_sigma: resSigV, signal: sigV, virtual: true },
        r2_diverged: r2Diverged,   // 익일 채점 대상 (발주 C §2)
        manual_weight_ban: "야간선물 가중 수동 상향 금지 — v1.1c 자동 증감만 (발주 C §4)",
        // [발주자 8/20 밤 — R2 표기] 3숫자 규격(실제값·이론값·차) + 병행 이론가 병기 (v1.1c는 첫 데이터 밤부터)
        report: act2.line + "\n" + buildR2(symbol, date, fair2O, est, residualO, resSigmaO, signalO, expOpen2,
          { theoPx: paraTheo, resSigma: promoR2 ? resSigma : resSigV }) +
          `\n야간 정합: ${nfCons}${nfGap2 != null && aucGap2 != null ? ` (야간환산 ${nfGap2 > 0 ? "+" : ""}${nfGap2}% vs 동시호가 ${aucGap2 > 0 ? "+" : ""}${aucGap2}%)` : ""}`,
        sent_at: new Date().toISOString() };
      await saveRow(row);
      outbox.subject = "[G1B R2] 잔차 판정 (가상·log-only)";
      outbox.texts.push(row.r2.report as string);
      notes.push(`${symbol} R2 발행 (${signalO})`);
    }
    // [발주자 판정 8/15 §2ⓒ] 라이브 vs KRX 정본(T+1) 일일 대사 상설 — 라벨 창에서 1회, 성공까지 재시도.
    // 허용 오차 0.30%p: 라이브 스냅샷은 04:50(마감 06:00 전 70분) — 시점차 정상 변동을 오탐하지 않는 폭.
    // 초과 불일치 = 소스 오염 신호 → 경보 (판정 §5: 정본 대사 없는 라이브 소스는 미검증 취급).
    if (hhmm >= W.labelStart && hhmm <= "11:00" && row.night && !(row.night as Record<string, unknown>).nf_reconcile) {
      const liveV = row.night.night_fut?.v;
      const liveCorrected = (row.night.night_fut as unknown as { corrected?: boolean } | undefined)?.corrected === true;
      try {
        const { fetchKrxNightU1 } = await import("@/lib/market/krxNight");
        const krx = process.env.KRX_ID && process.env.KRX_PW ? await fetchKrxNightU1(date) : undefined;
        if (krx === undefined) {
          (row.night as Record<string, unknown>).nf_reconcile = { verdict: "대사 불가 — KRX_ID/KRX_PW 미설정", ts: new Date().toISOString() };
          await saveRow(row);
          notes.push(`${symbol} 야간 대사 불가 — Vercel에 KRX_ID/KRX_PW 필요`);
        } else if (krx === null) {
          // 정본 미확보(로그인 실패·해당 라벨 야간 세션 없음 등) — 다음 틱 재시도 (기록하지 않음)
          notes.push(`${symbol} 야간 대사 재시도 예정 (정본 미확보)`);
        } else {
          const livePct = liveV != null ? Math.round(liveV * 10000) / 100 : null;
          const diff = livePct != null ? Math.round((livePct - krx.u1_pct) * 100) / 100 : null;
          // 판정 3단 (8/19 첫 실전 실측 후 보완): 04:50→06:00 70분 시점차는 급변 밤에 0.3%p를 넘을 수 있다
          // (8/19: 라이브 -3.97 vs 정본 -4.29, 차 0.32 — 하락 밤 마지막 70분 추가 하락, 소스 정상).
          // 오염(8/13~14 div=F)은 차 1.3~1.7%p·부호/크기 괴리였으므로 **1.0%p** 이상 또는 부호 불일치를 '오염 의심'으로 분리.
          // 0.30~1.0%p는 '시점차 범위 — 정상'으로 기록만 (경보 없음). 문턱은 표본 축적 후 재조정 (발주자 결정).
          const signMismatch = livePct != null && Math.abs(livePct) >= 0.3 && Math.abs(krx.u1_pct) >= 0.3 && Math.sign(livePct) !== Math.sign(krx.u1_pct);
          const verdict = livePct == null ? "라이브 결측 — 정본만 기록"
            : Math.abs(diff!) <= 0.30 ? "일치(±0.30%p)"
            : Math.abs(diff!) < 1.0 && !signMismatch ? "시점차 범위(0.3~1.0%p) — 정상"
            : "불일치 — 소스 점검 필요";
          const cov = (row.night as Record<string, unknown>).nf_coverage as { kind?: string; us_sessions?: number } | undefined;
          (row.night as Record<string, unknown>).nf_reconcile = {
            live_pct: livePct, krx_u1_pct: krx.u1_pct, diff_pp: diff, contract: krx.contract,
            live_corrected: liveCorrected, verdict, ts: new Date().toISOString(),
            coverage: cov?.kind ?? "unknown", us_sessions: cov?.us_sessions ?? null,   // 커버리지 부분 밤은 u1 채점 분리 집계 (8/18)
          };
          notes.push(`${symbol} 야간 대사 ${verdict}${diff != null ? ` (라이브 ${livePct} vs 정본 ${krx.u1_pct})` : ""}`);
          if (verdict.startsWith("불일치")) {
            const { sendG1Notify } = await import("@/lib/alerts/g1notify");
            await sendG1Notify("[G1B 대사] 야간선물 정본 불일치", `[G1B 대사] ${date.slice(5)} 야간선물 라이브 ${livePct}% vs KRX 정본 ${krx.u1_pct}% (차 ${diff}%p) — 소스 점검 필요`);
          }
          await saveRow(row);
        }
      } catch { notes.push(`${symbol} 야간 대사 예외 — 다음 틱 재시도`); }
    }
    if (hhmm >= W.labelStart && hhmm <= W.labelEnd && row.r1 && !row.labels) {
      const kr = await krDaily(symbol);
      if (kr.todayOpen && kr.prevClose) {
        const actual = Math.round(((kr.todayOpen / kr.prevClose - 1) * 100) * 100) / 100;
        const f1 = row.r1.fair_gap_pct as number | null;
        const f2 = row.r2?.fair_gap_r2_pct as number | null | undefined;
        // [발주자 검수 8/18 §3] 4자 대조 — 룰(G1A GapScore) vs 야간선물(19:35 절단) vs 번역(R1 FairGap) vs 실측. 신호 대결 표본으로 명시.
        const gref = (row.r1.g1a_ref ?? null) as { rule_score?: number | null; nf_cut1935_pct?: number | null } | null;
        const sgnOf = (x: number | null | undefined, band: number) => (x == null ? null : Math.abs(x) < band ? 0 : Math.sign(x));
        const fourWay = {
          rule_score: gref?.rule_score ?? null, nf_cut1935_pct: gref?.nf_cut1935_pct ?? null, fair_r1_pct: f1, actual_gap_pct: actual,
          // 방향 일치: 룰 |score|≥0.5 · 야간선물 |%|≥0.3 · 번역 |%|≥0.3 · 실측 |%|≥0.3 (플랫 밴드)
          hit: {
            rule: sgnOf(gref?.rule_score, 0.5) && sgnOf(actual, 0.3) ? sgnOf(gref?.rule_score, 0.5) === sgnOf(actual, 0.3) : null,
            nf: sgnOf(gref?.nf_cut1935_pct, 0.3) && sgnOf(actual, 0.3) ? sgnOf(gref?.nf_cut1935_pct, 0.3) === sgnOf(actual, 0.3) : null,
            fair: sgnOf(f1, 0.3) && sgnOf(actual, 0.3) ? sgnOf(f1, 0.3) === sgnOf(actual, 0.3) : null,
          },
          note: "신호 대결 표본 (발주자 8/18) — 룰·야간선물·번역 세 신호의 방향 vs 실측 갭",
          // [발주자 시각 규율 8/19 §1] 2판 분리: 저녁판(19:35 동일 절단) = 룰·야간선물·저녁 번역(NXT 경로 시가 예상) /
          // 아침판(07:15 절단) = 챔피언 R1·챌린저 v1.1c. 각 판의 절단 시각 명기.
          evening: {
            cut: "19:35", resid_open_exp: (gref as { resid_open_exp?: number | null } | null)?.resid_open_exp ?? null,
            hit_resid: (() => { const x = (gref as { resid_open_exp?: number | null } | null)?.resid_open_exp; return sgnOf(x, 0.3) && sgnOf(actual, 0.3) ? sgnOf(x, 0.3) === sgnOf(actual, 0.3) : null; })(),
          },
          morning: {
            cut: "07:15", v11c_pct: (row.r1.challenger_v11c as { fair_gap_pct?: number | null } | undefined)?.fair_gap_pct ?? null,
            hit_v11c: (() => { const x = (row.r1.challenger_v11c as { fair_gap_pct?: number | null } | undefined)?.fair_gap_pct; return sgnOf(x, 0.3) && sgnOf(actual, 0.3) ? sgnOf(x, 0.3) === sgnOf(actual, 0.3) : null; })(),
          },
        };
        // [발주자 8/20 §4] 시장 간 정확도 리그전 — 애프터 최종가 vs 야간선물 마감 β환산, 누가 시가에 가까웠나
        const { leagueScore } = await import("./nightwatch");
        const nxtC = (row.night as Record<string, unknown> | null)?.nxt_close_pct as number | null | undefined;
        const nfC = row.night?.night_fut && !row.night.night_fut.late_arrival ? row.night.night_fut.v : null;
        const nfCB = nfC != null ? Math.round(nfC * 100 * st.kalman.beta_mkt * 100) / 100 : null;
        const league = leagueScore({ nxtClosePct: nxtC ?? null, nfCloseBeta: nfCB, actualGap: actual });
        // [발주자 8/20 밤 §5] 리그전 "잔여갭 식 대비" 행 — 애프터 유지(nxt 그대로) vs 차감 식(잔여갭 경로 시가 예상) 오차 병기.
        // 잔여갭 식 재검토 안건의 증거 축적 — 채점 회계 무접촉, 병기만.
        const residExp = (row.r1.g1a_ref as { resid_open_exp?: number | null } | null)?.resid_open_exp ?? null;
        const leagueX = { ...league, resid_open_exp: residExp, err_resid: residExp != null ? Math.round(Math.abs(residExp - actual) * 100) / 100 : null };
        // [발주 ■7 8/20] 이원 채점 병행 저장 — 공식(종가比) 불변 + 애프터比(T2 19:40 기준가 기준) 기록
        const entryPxRef = (row.r1.g1a_ref as { entry?: number | null } | null)?.entry ?? null;
        const afterGap = entryPxRef && kr.prevClose ? Math.round(((kr.todayOpen / entryPxRef - 1) * 100) * 100) / 100 : null;
        row.labels = {
          after_basis: { actual_gap_after_pct: afterGap, entry_px_ref: entryPxRef, note: "애프터比 채점 병행 (공식 채점은 종가 자 유지 — D+60 자 전환 발주자 결정)" },
          big_after_night: afterGap != null && Math.abs(actual - afterGap) >= 3,
          league: { ...leagueX, nxt_close_pct: nxtC ?? null, nf_close_beta: nfCB, note: "애프터 최종가 vs 야간선물 마감 — 잔여갭 야간선물 성분 편입 심사 직접 증거 (발주자 8/20 §4) + 잔여갭식 대비(§5 8/20 밤)" },
          actual_open: kr.todayOpen, actual_gap_pct: actual,
          te_r1_pct: f1 != null ? Math.round(Math.abs(actual - f1) * 100) / 100 : null,
          te_r2_pct: f2 != null ? Math.round(Math.abs(actual - (f2 as number)) * 100) / 100 : null,
          four_way: fourWay,
        };
        const ex = (row.r1.experts ?? {}) as Experts;
        const regime = (row.r1.regime as string) ?? "normal";
        const st2 = dailyUpdate(symbol, st, ex, row.r1.fair_gap_pct as number | null, actual, regime, row.night ?? {});
        // [발주자 8/15 정확도연동 §1 + 판정 §1] 챌린저 pack_v1.1c 일일 채점 — 챔피언과 동일 규칙, nf 포함.
        // 이벤트 밤은 챔피언 유지이므로 갱신·밤수 카운트 모두 건너뛴다 (섀도 12거래밤 = 실제 갈라진 밤만).
        const regKey = regime === "bigmove" ? "event" : regime;
        const sigCh = Math.sqrt(st.sigma_ewma[regKey] ?? st.sigma_ewma.normal);
        const chEx = challengerExperts(ex);
        const chPrev = st.challenger_v11c ?? initChallenger(symbol, st.hedge_w);
        st2.challenger_v11c = regKey === "event" ? chPrev : challengerUpdate(chPrev, chEx, actual, sigCh);
        const chFair = (row.r1.challenger_v11c as { fair_gap_pct?: number | null } | undefined)?.fair_gap_pct ?? null;
        (row.labels as Record<string, unknown>).te_v11c_pct = chFair != null ? Math.round(Math.abs(actual - chFair) * 100) / 100 : null;
        // [발주자 8/20 밤 §4] 적응 η 챌린저 채점·갱신 — 매 라벨 밤 (챔피언과 동일 주기), η_eff는 갱신 전 챔피언 CUSUM 기준
        const etaPrev = st.challenger_eta ?? initEtaChallenger(st.hedge_w);
        st2.challenger_eta = etaChallengerUpdate(etaPrev, ex, actual, sigCh, st.cusum);
        const etaFair = (row.r1.challenger_eta as { fair_gap_pct?: number | null } | undefined)?.fair_gap_pct ?? null;
        (row.labels as Record<string, unknown>).te_eta_pct = etaFair != null ? Math.round(Math.abs(actual - etaFair) * 100) / 100 : null;
        // [발주자 '적용 가속' §2 8/20 밤] R2 이론가 익일 채점 이원 (|이론가 갭 − 실측 갭|) — 교체 조기 상신의 증거
        const f2c = (row.r2 as { r2_residual_champ?: { fair_gap_r2_pct?: number | null } } | null)?.r2_residual_champ?.fair_gap_r2_pct ?? null;
        const f2v = (row.r2 as { r2_residual_v11c?: { fair_gap_r2_pct?: number | null } } | null)?.r2_residual_v11c?.fair_gap_r2_pct ?? null;
        (row.labels as Record<string, unknown>).te_r2_champ_pct = f2c != null ? Math.round(Math.abs(actual - f2c) * 100) / 100 : null;
        (row.labels as Record<string, unknown>).te_r2_v11c_pct = f2v != null ? Math.round(Math.abs(actual - f2v) * 100) / 100 : null;
        row.learn = { hedge_w: st2.hedge_w, sigma_ewma: st2.sigma_ewma, bias: st2.bias, cusum: st2.cusum, pit_last: st2.pit_hist.at(-1), kalman_b1: st2.kalman.b1, clamp_hits: st2.kalman.clamp_hits,
          challenger_v11c: { w_nf: st2.challenger_v11c.hedge_w.nf ?? null, nights: st2.challenger_v11c.nights, event_skipped: regKey === "event",
            loss_nf: regKey !== "event" && chEx.nf != null ? Math.round((Math.abs(actual - (chEx.nf as number)) / Math.max(sigCh, 0.3)) * 1000) / 1000 : null },
          challenger_eta: { nights: st2.challenger_eta.nights, eta_boost: Math.round((1 + Math.max(0, (Math.abs(st.cusum) - 4) / 4)) * 100) / 100 } };
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

// [발주 A — 결측 정정 8/20 밤] 야간 10분봉 수집 (19:45~06:00) — 저장: g1a_days[세션 밤].t2.nf.bars (G1A 동일 원천).
// 19:35 절단 동결 불변: level/dc_nf는 절대 재계산하지 않고 bars만 append (절단 이후 봉 = 관측·표시·vol 축적 전용).
// 10분 슬롯당 1회 (t 앞 4자리 dedupe — G1A 수집과 동일 규칙이라 창 겹침도 안전).
async function recordNightBars(hhmm: string, date: string, notes: string[]): Promise<void> {
  const admin = createAdminClient();
  const sessionNight = hhmm >= "18:00" ? date : (() => { const d = new Date(date + "T00:00:00Z"); do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); })();
  let snap: { pct: number; vol: number | null; soxx: number | null; nq: number | null } | null = null;
  for (const symbol of G1B_SYMBOLS) {
    try {
      const t2 = (await admin.from("g1a_days").select("t2").eq("date", sessionNight).eq("symbol", symbol).maybeSingle()).data?.t2 as Record<string, unknown> | null;
      if (!t2) continue;                          // 세션 밤 행 없음(휴장 등) — 수집 없음
      const nf0 = (t2.nf ?? { bars: [] }) as { bars: { t: string; pct: number; vol?: number }[] } & Record<string, unknown>;
      if (nf0.bars.some((b) => b.t.slice(0, 4) === hhmm.slice(0, 4))) continue;
      if (!snap) {
        const { fetchKisNightFutures, hasKisKeys } = await import("@/lib/market/kis");
        if (!hasKisKeys()) return;
        const q = await fetchKisNightFutures("CM");
        const pct = (q as { changePercent?: number | null })?.changePercent;
        if (typeof pct !== "number") return;      // 세션 없음·결측 — 다음 틱 재시도
        const vol = (q as { volume?: number | null })?.volume;
        // [발주자 8/20 밤 23시] SOXX·나스닥100(NQ=F)도 같은 봉에 병기 — SOXX는 미 정규장(22:30~05:00)만 값이 있음(그 외 null)
        const { dayChange, nqSince16kst } = await import("./nightwatch");
        const [soxx, nq] = await Promise.all([dayChange("SOXX"), nqSince16kst()]);
        snap = { pct, vol: typeof vol === "number" ? vol : null, soxx, nq };
      }
      nf0.bars = [...nf0.bars, { t: hhmm, pct: snap.pct, ...(snap.vol != null ? { vol: snap.vol } : {}), ...(snap.soxx != null ? { soxx: snap.soxx } : {}), ...(snap.nq != null ? { nq: snap.nq } : {}) }];
      t2.nf = nf0;
      await admin.from("g1a_days").update({ t2 }).eq("date", sessionNight).eq("symbol", symbol);
      notes.push(`${symbol} 야간봉 ${hhmm} ${snap.pct >= 0 ? "+" : ""}${snap.pct}%`);
    } catch { /* 결측 허용 */ }
  }
}

// [발주 D §5 — 매시 확장 8/20 밤] 시간별 drift 재판정 트랙 (관측·학습 전용, 채점 정본 = 19:35 판정 불변).
// 저장: g1a_days[세션 밤].t2.shadow_v2.hourly — 시간당 1회 (슬롯 = HH). 기준점 섀도(shadow_v2) 미생성 밤은
// 트랙 없음 (기준점 없이 drift만은 무의미 — 명기). 성분은 등록 축소판(ⓐ 바스켓 가속·ⓕ 매크로Δ·야간선물
// 누적 부호, reduced: true) 유지 — ⓑⓒⓓⓔ 추가는 사전 등록 변경 = 재등록 사항이라 여기서 확장하지 않는다.
async function recordHourlyDriftTrack(hhmm: string, date: string, notes: string[]): Promise<void> {
  const admin = createAdminClient();
  // 세션 밤 = 저녁(20:30~)이면 오늘, 새벽(~06:00)이면 직전 영업일 (CP 블록과 동일 규약)
  const sessionNight = hhmm >= "18:00" ? date : (() => { const d = new Date(date + "T00:00:00Z"); do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); })();
  const slot = hhmm.slice(0, 2);
  let cp: import("./nightwatch").Checkpoint | null = null;
  for (const symbol of G1B_SYMBOLS) {
    try {
      const t2 = (await admin.from("g1a_days").select("t2").eq("date", sessionNight).eq("symbol", symbol).maybeSingle()).data?.t2 as Record<string, unknown> | null;
      const sv2 = t2?.shadow_v2 as Record<string, unknown> | undefined;
      if (!sv2) continue;
      const hourly = (sv2.hourly ?? []) as { t?: string }[];
      if (hourly.some((h) => h.t?.slice(0, 2) === slot)) continue; // 시간당 1회 — 연휴 다음날 새벽 중복 호출도 이 슬롯 규칙이 차단
      if (!cp) { const { takeCheckpoint } = await import("./nightwatch"); cp = await takeCheckpoint(hhmm); }
      const { judgeDrift, V2 } = await import("@/lib/g1a/t2plusV2");
      const { fetchBasketAccel30m, fetchMacroEveningDelta } = await import("@/lib/g1a/data");
      const [accel, macro] = await Promise.all([fetchBasketAccel30m(symbol as "005930" | "000660"), fetchMacroEveningDelta()]);
      const dj = judgeDrift({ basketAccel30m: accel, dcNf: null, nfCumSign: cp.nf_pct != null && Math.abs(cp.nf_pct) >= 0.1 ? Math.sign(cp.nf_pct) : 0, dcPm: null, basketSign: 0, p1Slope: null, eventTonight: null, macro });
      // [발주자 8/21 새벽] 매시 재판정을 예상갭 값으로 — base(19:35 절단, 고정 수용) + 시간별 drift 조정 (등록 공식·상한 동일)
      const base = sv2.base_stock_pct as number | undefined, beta = sv2.beta as number | undefined, sigma = sv2.sigma_used as number | undefined;
      let adj: number | null = null, exp: number | null = null;
      if (base != null && beta != null && sigma != null) {
        const raw = dj.dir === "중립" ? 0 : (dj.dir === "상방" ? 1 : -1) * dj.conf * V2.CONF_FULL_ADJ_PCT * beta;
        const cap = V2.DRIFT_CAP_SIGMA * sigma;
        adj = Math.round(Math.max(-cap, Math.min(cap, raw)) * 100) / 100;
        exp = Math.round((base + adj) * 100) / 100;
      }
      sv2.hourly = [...hourly, { t: hhmm, dir: dj.dir, conf: dj.conf, nf_pct: cp.nf_pct, adj_pct: adj, expected_gap_pct: exp, reduced: true }];
      // [v2.1 등재 8/22] 병행 매시 트랙 — 축소 성분 ⓐ' 다창·ⓕ·누적 부호 + ⓔ' 2등급 (shadow_v21.hourly)
      try {
        const sv21 = t2?.shadow_v21 as Record<string, unknown> | undefined;
        if (sv21 && !((sv21.hourly ?? []) as { t?: string }[]).some((h) => h.t?.slice(0, 2) === slot)) {
          const { judgeDriftV21 } = await import("@/lib/g1a/t2plusV21");
          const { fetchBasketWindows, fetchEventsTiered } = await import("@/lib/g1a/data");
          const [bw, ev] = await Promise.all([fetchBasketWindows(symbol as "005930" | "000660"), fetchEventsTiered()]);
          const dj21 = judgeDriftV21({ basket: bw, dcNf: null, nfCumSign: cp.nf_pct != null && Math.abs(cp.nf_pct) >= 0.1 ? Math.sign(cp.nf_pct) : 0, dcPm: null, basketSign: 0, p1: { r30: null, rSess: null }, events: ev, macro });
          const b21 = sv21.base_stock_pct as number | undefined, be21 = sv21.beta as number | undefined, sg21 = sv21.sigma_used as number | undefined;
          let a21: number | null = null, e21: number | null = null;
          if (b21 != null && be21 != null && sg21 != null) {
            const raw = dj21.dir === "중립" ? 0 : (dj21.dir === "상방" ? 1 : -1) * dj21.conf * V2.CONF_FULL_ADJ_PCT * be21;
            const cap = V2.DRIFT_CAP_SIGMA * sg21;
            a21 = Math.round(Math.max(-cap, Math.min(cap, raw)) * 100) / 100; e21 = Math.round((b21 + a21) * 100) / 100;
          }
          sv21.hourly = [...((sv21.hourly ?? []) as unknown[]), { t: hhmm, dir: dj21.dir, conf: dj21.conf, nf_pct: cp.nf_pct, adj_pct: a21, expected_gap_pct: e21, reduced: true }];
        }
      } catch { /* v2.1 트랙 결측 허용 */ }
      await admin.from("g1a_days").update({ t2 }).eq("date", sessionNight).eq("symbol", symbol);
      notes.push(`${symbol} v2 매시 트랙 ${slot}시 ${dj.dir} conf ${dj.conf} nf ${cp.nf_pct ?? "—"}`);
    } catch { /* 트랙 결측 허용 */ }
  }
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
  // [발주자 판정 8/15 §2] night_fut 계열 effective_start 재기산: 소스 오염 구간(8/12~8/14, div=F)은
  // 소급 정정(corrected=true)돼 데이터로는 유효하나 '라이브 소스 가동 시계'엔 불산입 —
  // 정화 개시일(첫 CM 라이브 밤) 2026-08-18로 하한 고정. g1a_nf_evening 동일.
  const NF_RESET = "2026-08-18";
  const floorReset = (d: string | null) => (d != null && d < NF_RESET ? NF_RESET : d);
  const effectiveStart = {
    night_fut: floorReset(firstDate((r) => (r.night?.night_fut as Obs | undefined)?.v != null)),
    auction_est: firstDate((r) => (r.morning?.auction_est_px as Obs | undefined)?.v != null),
    r2_residual: firstDate((r) => (r.r2 as { residual_sigma?: number | null } | null)?.residual_sigma != null),
    ah_excess: firstDate((r) => (r.night?.ah_excess as Obs | undefined)?.v != null),
    gdr: firstDate((r) => (r.night?.r_gdr as Obs | undefined)?.v != null),
  };
  const per = days.map((d) => {
    const rs = byDate.get(d)!;
    const r1ok = rs.filter((r) => r.r1).length, r2ok = rs.filter((r) => r.r2).length;
    // late 분해 (발주자 8/13 저녁 검수 §1): '절단 위반'(late인데 판정 사용 — 엔진이 late를 제외하므로
    // 구조상 0이어야 하며 게이트 기준) vs '격리 기록'(진단 프로브 등 — 무해, 격리 장치 작동 증거)
    const lateEntries = rs.flatMap((r) => Object.entries({ ...(r.night ?? {}), ...(r.morning ?? {}) }).filter(([, o]) => (o as Obs).late_arrival));
    const late = lateEntries.filter(([k]) => !k.startsWith("auction_probe")).length; // 격리(비프로브)
    const lateProbe = lateEntries.length - late;
    void lateProbe;
    const tes = rs.map((r) => r.labels?.te_r1_pct as number | null).filter((x): x is number => x != null);
    return { date: d, r1ok, r2ok, late_arrival: late, late_probe: lateProbe, te_r1: tes };
  });
  const allTe = per.flatMap((p) => p.te_r1).sort((a, b) => a - b);
  // 중앙값 규약 (발주자 Q2 답변, 2026-08-12 문서화): **상위 중앙값(upper median)** —
  // 짝수 표본에서 보간(평균) 없이 sorted[floor(n/2)]의 실존 관측값을 쓴다.
  // 근거: ①실제 발생한 오차값만 보고(합성값 금지) ②짝수일 때 큰 쪽을 취해 성능을 후하게 보이지 않게(보수).
  // 예: [0.62, 1.00, 1.08, 2.75] → 보간 1.04가 아니라 1.08. D+15 게이트 판정도 이 규약.
  const med = allTe.length ? allTe[Math.floor(allTe.length / 2)] : null;
  // TE 레짐 분리 (발주자 8/14 §8): 평상/이벤트 밤 분리 중앙값 — 동일 상위 중앙값 규약
  const upperMed = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const teReg: Record<string, number[]> = { normal: [], event: [] };
  for (const r of rows) {
    const te = (r.labels as { te_r1_pct?: number | null } | null)?.te_r1_pct;
    const reg = String((r.r1 as { regime?: string } | null)?.regime ?? "normal");
    if (te != null) (teReg[reg === "event" ? "event" : "normal"] ??= []).push(Number(te));
  }
  const teByRegime = { normal: upperMed(teReg.normal), event: upperMed(teReg.event), n: { normal: teReg.normal.length, event: teReg.event.length } };
  // [발주자 8/20 밤 §7] TE 종목별 중앙값 분리 — 동일 상위 중앙값 규약 (전 레짐 합산; 레짐 분리는 위 행이 담당)
  const teSym: Record<string, number[]> = {};
  for (const r of rows) {
    const te = (r.labels as { te_r1_pct?: number | null } | null)?.te_r1_pct;
    if (te != null) (teSym[r.symbol] ??= []).push(Number(te));
  }
  const teBySymbol = Object.fromEntries(Object.entries(teSym).map(([s, xs]) => [s, { median: upperMed([...xs]), n: xs.length }]));
  // [발주자 '적용 가속' §1 8/20 밤 — 사전 등록 조기 판정] v1.1c 8거래밤 중간 심사 자동 표시 (종목별, 첫 8밤 고정):
  // ⓐ 승률 ≥7/8 ⓑ 개선 중앙값(champ−v11c, 상위 중앙값) > 0 (오프라인 −0.5%p대 개선과 방향 정합) ⓒ 악화 밤 = 커버리지 공백뿐
  const covOf = (r: Row) => (((r.night as Record<string, unknown> | null)?.nf_coverage as { kind?: string } | undefined)?.kind ?? "normal");
  const v11cEarly: Record<string, unknown> = {};
  const r2Early: Record<string, unknown> = {};
  for (const sym of ["005930", "000660"]) {
    const nights = rows.filter((r) => r.symbol === sym && (r.labels as { te_v11c_pct?: number | null } | null)?.te_v11c_pct != null && (r.labels as { te_r1_pct?: number | null } | null)?.te_r1_pct != null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ date: r.date, champ: Number((r.labels as { te_r1_pct?: number }).te_r1_pct), v11c: Number((r.labels as { te_v11c_pct?: number }).te_v11c_pct), cov: covOf(r) }));
    const s8 = nights.slice(0, 8);
    if (nights.length < 8) v11cEarly[sym] = { n: nights.length, verdict: `심사 전 (${nights.length}/8밤)` };
    else {
      const wins8 = s8.filter((x) => x.v11c < x.champ).length;
      const med8 = upperMed(s8.map((x) => x.champ - x.v11c));
      const worse8 = s8.filter((x) => x.v11c >= x.champ);
      const cond = { a: wins8 >= 7, b: med8 != null && med8 > 0, c: worse8.every((x) => x.cov === "partial" || x.cov === "none") };
      v11cEarly[sym] = { n: nights.length, wins8, med_improve_pp: med8 != null ? Math.round(med8 * 100) / 100 : null,
        worse8: worse8.map((x) => ({ date: x.date, cov: x.cov })), cond,
        verdict: cond.a && cond.b && cond.c ? "3조건 충족 — 조기 승격 상신 (발주자 판정 대기)" : "미충족 — 12밤 원안" };
    }
    // [§2] R2 이론가 익일 채점 — 8회 기록 시점 우세 판정 (조작 정의 사전 등록: 승 ≥6/8 그리고 개선 중앙값 > 0)
    const recs = rows.filter((r) => r.symbol === sym && (r.labels as { te_r2_v11c_pct?: number | null } | null)?.te_r2_v11c_pct != null && (r.labels as { te_r2_champ_pct?: number | null } | null)?.te_r2_champ_pct != null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ date: r.date, champ: Number((r.labels as { te_r2_champ_pct?: number }).te_r2_champ_pct), v11c: Number((r.labels as { te_r2_v11c_pct?: number }).te_r2_v11c_pct) }));
    const t8 = recs.slice(0, 8);
    if (recs.length < 8) r2Early[sym] = { n: recs.length, verdict: `기록 ${recs.length}/8회 (첫 기록 8/21~)` };
    else {
      const winsR = t8.filter((x) => x.v11c < x.champ).length;
      const medR = upperMed(t8.map((x) => x.champ - x.v11c));
      r2Early[sym] = { n: recs.length, wins8: winsR, med_improve_pp: medR != null ? Math.round(medR * 100) / 100 : null,
        verdict: winsR >= 6 && medR != null && medR > 0 ? "우세 명확 — 이론가 교체 조기 상신 (발주자 판정 대기)" : "우세 불명확 — 12밤 원안" };
    }
  }
  const complete = per.filter((p) => p.r1ok === 2 && p.r2ok === 2).length;
  // D1 (발주자 8/12): G1A 보류 밤 집계 — θ 캘리브레이션의 공식 증거 + E2 T2+ 섀도 비교 + E1 개시일
  const ga = await admin.from("g1a_days").select("date,symbol,t2,labels").order("date", { ascending: true }).limit(120);
  type GaRow = { date: string; symbol: string; t2: Record<string, unknown> | null; labels: Record<string, unknown> | null };
  const gaRows = (ga.data ?? []) as GaRow[];
  // [발주자 회수 ② 8/22] 3자 병행 채점 집계 — T2 / v2 / v2.1: 발화율·발화 적중률·침묵 실패율·near-miss (late 밤 제외)
  const triAgg = (() => {
    type S = { fired: boolean; hit: boolean | null; silent_fail: boolean; near_miss: boolean; late?: boolean };
    const acc: Record<string, { n: number; fired: number; hit: number; hitN: number; silent: number; quiet: number; near: number }> = {};
    for (const r of gaRows) {
      const tri = (r.labels as { tri?: { t2?: S | null; v2?: S | null; v21?: S | null } } | null)?.tri;
      if (!tri) continue;
      for (const k of ["t2", "v2", "v21"] as const) {
        const s = tri[k]; if (!s || s.late) continue;
        const a = (acc[k] ??= { n: 0, fired: 0, hit: 0, hitN: 0, silent: 0, quiet: 0, near: 0 });
        a.n++; if (s.fired) a.fired++; else a.quiet++;
        if (s.hit != null) { a.hitN++; if (s.hit) a.hit++; }
        if (s.silent_fail) a.silent++; if (s.near_miss) a.near++;
      }
    }
    const pct = (x: number, n: number) => (n ? Math.round((x / n) * 100) : null);
    return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { n: a.n, fire_rate: pct(a.fired, a.n), hit_rate: pct(a.hit, a.hitN), silent_fail_rate: pct(a.silent, a.quiet), near_miss: a.near }]));
  })();
  const abst = gaRows.filter((r) => (r.t2?.verdict as { direction?: string } | undefined)?.direction === "NEUTRAL" && r.labels);
  const gaps = abst.map((r) => Math.abs(Number(r.labels?.L1 ?? NaN))).filter((x) => isFinite(x));
  const missed = abst.map((r) => Number(r.labels?.L1p ?? NaN)).filter((x) => isFinite(x));
  // D1 사유별 분해 (발주자 8/13 §3): 정당 보류(이벤트) vs 아까운 보류(점수/DC-PM) 구분 — θ 심사용
  const reasonOf = (t2: Record<string, unknown> | null): string => {
    const a = String((t2?.verdict as { abstain_reason?: string } | undefined)?.abstain_reason ?? "");
    if (a.startsWith("보류")) return a.startsWith("보류1") ? "이벤트" : "기타 보류규칙";
    const l = String((t2?.action as { line?: string } | undefined)?.line ?? "");
    if (l.includes("DC-PM")) return "DC-PM 미달";
    return "점수/θ 미달";
  };
  // 표본 회계 통일 (발주자 8/15 저녁 §2, E-섀도 규약 준용): 동일 밤 2종목 = 독립 표본 1 —
  // 밤(날짜) 단위 카운트, 같은 밤 종목 간 분류가 갈리면 각 1/행수 가중.
  const nightW = (date: string, rows2: { date: string }[]) => 1 / Math.max(1, rows2.filter((x) => x.date === date).length);
  const byReason: Record<string, number> = {};
  for (const r of abst) {
    const k = reasonOf(r.t2);
    byReason[k] = Math.round(((byReason[k] ?? 0) + nightW(r.date, abst)) * 10) / 10;
  }
  // D1 방향 축 (발주자 8/15 저녁 §1): {방향 적중+문턱/규칙 차단} = θ·규칙 완화 심사 증거 /
  // {방향 오판} = 방향 재료(nf 등) 개선 증거. 8/13 = 오판 확정(발주자), 8/14 = 적중_규칙(라벨 8/18 대기).
  const { dirAxisOf } = await import("@/lib/g1/copy");
  const dirAxis: Record<string, number> = {};
  for (const r of abst) {
    const v = r.t2?.verdict as { gap_score?: number; abstain_reason?: string | null } | undefined;
    const k = dirAxisOf({ score: v?.gap_score ?? null, abstain: v?.abstain_reason ?? null, L1: r.labels?.L1 != null ? Number(r.labels.L1) : null });
    dirAxis[k] = Math.round(((dirAxis[k] ?? 0) + nightW(r.date, abst)) * 10) / 10;
  }
  const g1aAbstain = {
    by_reason: byReason,
    dir_axis: dirAxis,
    nights: new Set(abst.map((r) => r.date)).size, // 밤 단위 (§2)
    rows: abst.length,
    avg_abs_gap_pct: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 100) / 100 : null,
    max_abs_gap_pct: gaps.length ? Math.round(Math.max(...gaps) * 100) / 100 : null,
    missed_virtual_sum_pct: missed.length ? Math.round(missed.reduce((a, b) => a + Math.abs(b), 0) * 100) / 100 : null, // 가상 진입가→시가 |수익| 합
  };
  // Lean 채점 (발주자 8/12 §2): 베팅 없는 밤의 기울기 방향 vs 실측 갭 부호 — θ 인하 심사 1급 증거
  const leanRows = gaRows.filter((r) => {
    const g = (r.t2 as { grade?: { grade?: string; lean_dir?: string } } | null)?.grade;
    return g?.grade === "Lean" && g.lean_dir && r.labels?.L1 != null;
  });
  // 갭상승/갭하락 분리 집계 (발주자 8/13 §4) — 표본 회계는 밤 단위 (발주자 8/15 저녁 §2)
  const leanNight = (rows2: typeof leanRows) => {
    const n = new Set(rows2.map((r) => r.date)).size;
    let hits = 0;
    for (const r of rows2) {
      const g = (r.t2 as { grade?: { lean_dir?: string } }).grade!;
      if ((g.lean_dir === "UP") === (Number(r.labels!.L1) > 0)) hits += nightW(r.date, rows2);
    }
    return { n, hits: Math.round(hits * 10) / 10, rate: n ? Math.round((hits / n) * 100) / 100 : null };
  };
  const leanSplit = (dir: "UP" | "DOWN") =>
    leanNight(leanRows.filter((r) => (r.t2 as { grade?: { lean_dir?: string } }).grade!.lean_dir === dir));
  const leanAll = leanNight(leanRows);
  // 등급-행동 분리 (발주자 8/18): 등급 High/Low 구간인데 트리거 조건에 막혀 베팅 없던 밤 — Lean과 분리해 Low/High로 계수
  // (8/18 삼전 -4.35 = ▼갭하락 Low·베팅 없음(DC-PM 미달)이 첫 표본). 갭상승/갭하락 분리 집계.
  const gradeNoBetRows = gaRows.filter((r) => {
    const g = (r.t2 as { grade?: { grade?: string; lean_dir?: string } } | null)?.grade;
    const dir = (r.t2?.verdict as { direction?: string } | undefined)?.direction;
    return (g?.grade === "High" || g?.grade === "Low") && dir === "NEUTRAL" && g.lean_dir && r.labels?.L1 != null;
  });
  const gradeNoBetSplit = (dir: "UP" | "DOWN") =>
    leanNight(gradeNoBetRows.filter((r) => (r.t2 as { grade?: { lean_dir?: string } }).grade!.lean_dir === dir));
  const dirOf = (o: unknown) => String((o as { last?: { dir?: string } } | undefined)?.last?.dir ?? "");
  const t2plus = {
    // E2·모자이크 비교표: 베팅 가능 밤 비율이 승격 심사 명시 지표 (발주자 8/12 §5)
    nights_tracked: gaRows.length,
    base_bets: gaRows.filter((r) => ["UP", "DOWN"].includes(String((r.t2?.verdict as { direction?: string })?.direction))).length,
    shadow_bets: gaRows.filter((r) => ["UP", "DOWN"].includes(dirOf(r.t2?.shadow))).length,
    mosaic_bets: gaRows.filter((r) => ["UP", "DOWN"].includes(dirOf((r.t2 as { mosaic?: unknown } | null)?.mosaic))).length,
    lean_score: { ...leanAll, 갭상승: leanSplit("UP"), 갭하락: leanSplit("DOWN") }, // 밤 단위 표본 (§2)
    grade_nobet_score: { ...leanNight(gradeNoBetRows), 갭상승: gradeNoBetSplit("UP"), 갭하락: gradeNoBetSplit("DOWN") }, // High/Low 등급·베팅 없음 밤 (8/18 분리)
    e_shadow_nights: gaRows.filter((r) => (r.t2 as { e_shadow?: unknown } | null)?.e_shadow).length,
  };
  // [헌법 발효 2026-08-20 §5] E-체계 채점 정식 행 — ①E-Lean 기울기 적중률 ②E-Low 발동 밤 가상 손익. D+60 성과 심사 재료.
  // 전사(前史): 발효 전 e_shadow(retrospective 포함)는 분리 집계 — 본판정 이력(e_record·verdict.e_grade)과 섞지 않음.
  const eRows = gaRows.filter((r) => (r.t2?.verdict as { event_night?: string | null } | undefined)?.event_night && r.labels?.L1 != null);
  const eLean = eRows.filter((r) => (r.t2?.verdict as { e_grade?: string }).e_grade === "E-Lean");
  const eLeanHit = eLean.filter((r) => { const sc = Number((r.t2?.verdict as { gap_score?: number }).gap_score ?? 0); const L1 = Number(r.labels!.L1); return Math.abs(L1) >= 0.3 && Math.sign(sc) === Math.sign(L1); }).length;
  const eLow = eRows.filter((r) => (r.t2?.verdict as { e_grade?: string }).e_grade === "E-Low");
  const eLowPnl = eLow.map((r) => Number(r.labels?.L1p ?? NaN) * ((r.t2?.verdict as { direction?: string }).direction === "UP" ? 1 : -1)).filter((x) => isFinite(x));
  const preHist = gaRows.filter((r) => (r.t2 as { e_shadow?: { retrospective?: boolean } } | null)?.e_shadow);
  const eSystem = {
    effective_from: "2026-08-20", lean_nights: eLean.length, lean_hits: eLeanHit, lean_rate: eLean.length ? Math.round((eLeanHit / eLean.length) * 100) / 100 : null,
    low_nights: eLow.length, low_pnl_sum_pct: eLowPnl.length ? Math.round(eLowPnl.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    prehistory_shadow_nights: preHist.length, note: "발효 전 E-섀도(8/12 CPI E-Lean 적중 등)는 전사 — retrospective 표식 유지, 본 행 미산입",
  };
  const nfEveStart = floorReset(gaRows.find((r) => (r.t2 as { nf_evening?: unknown } | null)?.nf_evening)?.date ?? null);
  const p1Start = gaRows.find((r) => ((r.t2 as { pieces?: Record<string, unknown> } | null)?.pieces)?.p1_eu_semi_avg != null)?.date ?? null;
  // [발주자 8/15 정확도연동 §4] nf 전문가 리더보드 — 일일 loss·발언권(w_nf) 추이 + 챌린저 vs 챔피언 TE.
  // "정확도에 따라 비중이 실제로 오르는가"를 눈으로 확인하는 판.
  const nfBoard: Record<string, { date: string; w_nf: number | null; loss_nf: number | null; te_v11c: number | null; te_champ: number | null }[]> = {};
  let chNights = 0;
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const ch = (r.learn as { challenger_v11c?: { w_nf?: number | null; nights?: number; loss_nf?: number | null } } | null)?.challenger_v11c;
    const lab = r.labels as { te_v11c_pct?: number | null; te_r1_pct?: number | null } | null;
    if (!ch && lab?.te_v11c_pct == null) continue;
    chNights = Math.max(chNights, ch?.nights ?? 0);
    (nfBoard[r.symbol] ??= []).push({ date: r.date, w_nf: ch?.w_nf ?? null, loss_nf: ch?.loss_nf ?? null, te_v11c: lab?.te_v11c_pct ?? null, te_champ: lab?.te_r1_pct ?? null });
  }
  for (const s of Object.keys(nfBoard)) nfBoard[s] = nfBoard[s].slice(-10);
  const nfLeaderboard = { shadow_nights: chNights, review_at_nights: 12, by_symbol: nfBoard };
  // [발주 ■1 8/20] 야간선물 단독 vs 챔피언 R1 누적 오차 대조표 — v1.1c 승격 심사 핵심 증거 행.
  // 라벨별 · 커버리지 공백 밤 분리 · 야간선물 소스 시각 태깅(04:50 스냅샷 표본 vs 06:00 마감 표본 — 8/20~).
  const nfVsChamp: { date: string; symbol: string; nf_solo_err: number | null; champ_err: number | null; nf_src_t: string; coverage: string; corrected: boolean }[] = [];
  const betaBy: Record<string, number> = { "005930": 1.316, "000660": 1.517 };
  {
    const stAll = await admin.from("g1b_state").select("symbol,state");
    for (const x of stAll.data ?? []) {
      const b = (x.state as { kalman?: { beta_mkt?: number } })?.kalman?.beta_mkt;
      if (typeof b === "number" && b > 0) betaBy[x.symbol as string] = b;
    }
  }
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const lab = r.labels as { actual_gap_pct?: number; te_r1_pct?: number | null } | null;
    if (lab?.actual_gap_pct == null) continue;
    const nfo = r.night?.night_fut as (Obs & { t?: string; corrected?: boolean }) | undefined;
    const beta = betaBy[r.symbol] ?? 1.4;
    const nfSolo = nfo?.v != null && !nfo.late_arrival ? Math.round(Math.abs(nfo.v * 100 * beta - lab.actual_gap_pct) * 100) / 100 : null;
    const cov = (r.night as Record<string, unknown> | null)?.nf_coverage as { kind?: string } | undefined;
    nfVsChamp.push({ date: r.date, symbol: r.symbol, nf_solo_err: nfSolo, champ_err: lab.te_r1_pct ?? null,
      nf_src_t: nfo?.t ?? (nfo ? "04:50" : "—"), coverage: cov?.kind ?? "unknown", corrected: nfo?.corrected === true });
  }
  const metrics = {
    days_tracked: per.length, uptime_pct: per.length ? Math.round((complete / per.length) * 100) : 0,
    g1a_abstain: g1aAbstain, t2plus_compare: t2plus,
    te_r1_median_pct: med, te_r1_by_regime: teByRegime, te_r1_by_symbol: teBySymbol, offline_pred_x15: med != null ? (med <= 1.32 * 1.5 ? "정합(1.5배 이내)" : "초과") : null,
    v11c_early_review: v11cEarly, r2_theory_early_review: r2Early,   // 조기 판정 자동 심사 (적용 가속 §1·§2 8/20 밤)
    tri_compare: triAgg,   // 3자 병행 채점 (발주자 8/22) — v2.1 핵심 지표 = 침묵 실패율 감소
    cutoff_violations: per.reduce((a, p) => a + p.late_arrival, 0), quarantined_probe: per.reduce((a, p) => a + (p.late_probe ?? 0), 0), late_arrival_total: per.reduce((a, p) => a + p.late_arrival, 0),
    effective_start: { ...effectiveStart, g1a_nf_evening: nfEveStart, p1_eu_semi: p1Start },
    nf_leaderboard: nfLeaderboard, e_system: eSystem, nf_vs_champ: nfVsChamp,
    // [발주자 8/18 §3] u1 대사 커버리지 분리 집계 — 커버리지 부분(연휴 밤·미국 세션 ≥2)은 정상 밤과 섞지 않는다
    nf_reconcile_by_coverage: (() => {
      const acc: Record<string, { n: number; match: number; mismatch: number; missing: number }> = {};
      for (const r of rows) {
        const rc = (r.night as Record<string, unknown> | null)?.nf_reconcile as { verdict?: string; coverage?: string } | undefined;
        if (!rc) continue;
        const k = rc.coverage ?? "unknown";
        acc[k] ??= { n: 0, match: 0, mismatch: 0, missing: 0 };
        acc[k].n++;
        if (rc.verdict?.startsWith("일치")) acc[k].match++;
        else if (rc.verdict?.startsWith("불일치")) acc[k].mismatch++;
        else acc[k].missing++;
      }
      return acc;
    })(),
    dryrun: per.slice(0, C.dryRunDays).every((p) => p.r1ok === 2 && p.r2ok === 2) && per.length >= C.dryRunDays ? "통과 후보 — 3영업일 연속 완주" : "진행 중",
    daily: per.slice(0, 10),
  };
  // [발주자 B6 8/20 밤] 이벤트 밤 전(거래일) 자동 통보 — E-체계 첫 실전 놓침 방지.
  // 대상: FOMC 결정일·CPI·고용(2026+ ES 사전 일정 없음 → 첫 금요일 규칙 보강)·수동 등록 실적(ops_settings.g1_event_manual).
  // 다음 거래일 기준(월요일 이벤트는 금요일에 통보). 중복 억제: ops_settings.g1_event_notice_last. 장애 무해(통보 실패해도 계기판 진행).
  try {
    const nextBiz = (() => { const d = new Date(date + "T00:00:00Z"); do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); })();
    const { FOMC_DECISION_DATES: FD, CPI_RELEASE_DATES: CD, ES_RELEASE_DATES: ED } = await import("@/lib/predict-daily/eventCalendar");
    const kinds: string[] = [];
    if (FD.includes(nextBiz)) kinds.push("FOMC 결정(발표 익일 새벽 KST)");
    if (CD.includes(nextBiz)) kinds.push("CPI(21:30 KST)");
    if (ED.includes(nextBiz)) kinds.push("고용보고서(21:30 KST)");
    const nb = new Date(nextBiz + "T00:00:00Z");
    if (!kinds.some((k) => k.startsWith("고용")) && nb.getUTCDay() === 5 && nb.getUTCDate() <= 7 && nextBiz > "2025-12-16") kinds.push("고용보고서(첫 금요일 규칙)");
    const manual = (await admin.from("ops_settings").select("value").eq("key", "g1_event_manual").maybeSingle()).data?.value as { date: string; name: string }[] | null;
    for (const mv of manual ?? []) if (mv.date === nextBiz) kinds.push(mv.name);
    if (kinds.length) {
      const last = (await admin.from("ops_settings").select("value").eq("key", "g1_event_notice_last").maybeSingle()).data?.value as { date?: string } | null;
      if (last?.date !== nextBiz) {
        const { sendG1Notify } = await import("@/lib/alerts/g1notify");
        const hr = await sendG1Notify("[G1 이벤트 전일 통보]",
          `[G1 이벤트 D-1] ${nextBiz.slice(5)} 밤 = ${kinds.join(" · ")} — [E] 본판정 대상 밤. ` +
          `컨센서스(IM) 수동 입력 리마인드: /ops에서 ops_settings.g1_event_consensus 입력 (미입력 시 E-Low 요건 IM '미조달' 처리).`);
        await admin.from("ops_settings").upsert({ key: "g1_event_notice_last", value: { date: nextBiz, kinds }, updated_at: new Date().toISOString() });
        notes.push(`이벤트 전일 통보(${hr.via}) — ${nextBiz} ${kinds.join("·")}`);
      }
    }
  } catch { /* 통보 실패 무해 */ }
  const { error } = await admin.from("g1b_gate").upsert({ date, metrics });
  if (error) notes.push(`계기판 저장 실패: ${error.message}`);
}
