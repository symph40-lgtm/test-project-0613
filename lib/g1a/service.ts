// G1A v0.3 서비스 — 일일 사이클 상태 머신 (스펙 §2). 크론이 어느 시각에 불러도 창구를 보고 알아서 동작.
//   15:05~15:25  T1 스냅샷 (기록 전용, §7)
//   16:30~19:40  T2 감시 루프 (10분 격자, 조기 트리거 §5.1 / 19:40 최종 §5.2)
//   트리거~19:55 반전 감시 (§5.5)
//   09:05~10:30  전일 라벨 채점 (L1'·L1·L2·L3, §3)
// log-only: 자본 없음·문자 없음(리포트 텍스트만 저장). 일정 체계는 SPEC_G1_OPT_loop가 지배.

import { fetchDaily } from "@/lib/predict-daily/data"; // 공용 참조 전례 (캘린더·flow와 동일)
import { fetchDayMinutes, fetchNxtPremarket } from "@/lib/predict/kisMinute";
import { G1A_CONFIG } from "./config";
import {
  fetchCircuitBreaker, fetchDayCharacter, fetchEventTonight, fetchEuropeTone,
  fetchFrnDecel, fetchFrnDecelPrev, fetchMacroZ, fetchNxtState, fetchPremarketBasket, fetchT1Globals, fetchTsmcResidual, fetchUsFutDelta,
} from "./data";
import { buildReversalReport, buildT2Report } from "./report";
import { evaluateT2, gapScoreT1, isExpiryDay, reversalCheck, thetaAt, type AbstainCtx } from "./score";
import { g1aTablesReady, loadDay, loadUnlabeled, upsertDay } from "./store";
import type { G1ARow, G1ASymbol, T2Features, T2State } from "./types";

const SYMBOLS: G1ASymbol[] = ["005930", "000660"]; // 표시·처리 순서 삼성전자 → 하이닉스 (발주자 표기 지시 8/15 §1)
const W = G1A_CONFIG.windows;

function kst(): { date: string; hhmm: string; hhmmss: string; weekday: number } {
  const d = new Date(Date.now() + 9 * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    hhmm: d.toISOString().slice(11, 16),
    hhmmss: d.toISOString().slice(11, 19),
    weekday: d.getUTCDay(),
  };
}

async function collectT2Features(symbol: G1ASymbol): Promise<T2Features> {
  const [basket, usfut, europe, tsmc, dayChar, frn, macro] = await Promise.all([
    fetchPremarketBasket(symbol), fetchUsFutDelta(), fetchEuropeTone(),
    fetchTsmcResidual(), fetchDayCharacter(symbol), fetchFrnDecel(symbol), fetchMacroZ(),
  ]);
  const nxt = await fetchNxtState(symbol, dayChar.regClose);
  return {
    F21_basket: basket.rBasket, F21_dcpm: basket.dcpm, F21_obs_min: basket.obsMin,
    F22_usfut: usfut, F20_europe: europe.pct, F20_obs_min: europe.obsMin,
    F11p_tsmc_resid: tsmc,
    F01_clv: dayChar.clv, F02_dc1: dayChar.dc1, F04_o1: dayChar.o1, F09_c1: null,
    F08_frn_decel: frn, F05_w1: null, F07_b1_z: null,
    F13_rate_z: macro.rateZ, F14_fx_z: macro.fxZ, F24_news: null,
    r_nxt: nxt.rNxt, nxt_last_px: nxt.lastPx, spread_pct: null, // 호가 API 부재 (config 참조)
  };
}

async function buildAbstainCtx(f: T2Features): Promise<AbstainCtx> {
  const { date, weekday } = kst();
  const [event, cb] = await Promise.all([fetchEventTonight(), fetchCircuitBreaker()]);
  return {
    dateKst: date, weekday, eventTonight: event, impliedMoveRatio: null, positioningExtreme: null, // IM·포지셔닝 미조달 → E-Low 구조적 불가 (불변 조항)
    circuitBreaker: cb, expiryToday: isExpiryDay(date),
  };
}

// ── T1 스냅샷 (§7 — 판정·리포트·자본 없음) ──
async function runT1(date: string): Promise<string[]> {
  const notes: string[] = [];
  const globals = await Promise.all([fetchT1Globals(), fetchMacroZ()]);
  const [t1g, macro] = globals;
  for (const symbol of SYMBOLS) {
    const row = (await loadDay(date, symbol)) ?? { date, symbol, t1_snapshot: null, t2: null, labels: null, outcome: null };
    if (row.t1_snapshot) continue;
    const dayChar = await fetchDayCharacter(symbol);
    // A1-8 (발주자 판정 8/11): T1 수급은 전일 확정 기준 별도 필드 — 당일 확정(F08 원 정의)은 T2 전용
    const frnPrev = await fetchFrnDecelPrev(symbol);
    // 가상 GapScore — v0.2 §5.1.2 T1 가중표 (기록 전용, 판정·자본 없음)
    const virtual = gapScoreT1({
      tsmcRaw: t1g.tsmcRaw, nqAsia: t1g.nqAsia,
      clv: dayChar.clv, dc1: dayChar.dc1, o1: dayChar.o1,
      frnDecel: frnPrev, rateZ: macro.rateZ, fxZ: macro.fxZ,
    });
    row.t1_snapshot = {
      taken_at: kst().hhmmss,
      gap_score_virtual: virtual,
      features: {
        F01_clv: dayChar.clv, F02_dc1: dayChar.dc1, F04_o1: dayChar.o1, F08_frn_decel_prev: frnPrev,
        F11_tsmc_raw: t1g.tsmcRaw, F10_nq_asia: t1g.nqAsia, F13_rate_z: macro.rateZ, F14_fx_z: macro.fxZ,
      },
    };
    await upsertDay(row);
    notes.push(`${symbol} T1 스냅샷 (가상 ${virtual})`);
  }
  return notes;
}

// 신호 문자 (사용자 지시 2026-08-09: G1A·G1B 개발 문자 발송).
// 정지 예외 철회 (발주자 지시 2026-08-08 "보내되 15일 보류 기간에는 보내지 말고"):
// sms_pause 활성 기간(~8/21)에는 보류 — 판정·기록은 계속, 해제 후 정상 발송.
async function sendSignal(subject: string, text: string, notes: string[]): Promise<void> {
  // 이메일 절충 (사용자 결정 2026-08-10): 보류 기간 이메일 대체·해제 후 문자 자동 복귀
  const { sendG1Notify } = await import("@/lib/alerts/g1notify");
  const r = await sendG1Notify(subject, text);
  notes.push(`발송(${r.via}) ${r.sent}건${r.errors.length ? ` · 오류 ${r.errors.join("; ")}` : ""} — ${subject}`);
}

// [발주자 8/15 정확도연동 §2] T2+ 섀도의 w_nf 일일 갱신형 미니 Hedge — 상태 테이블 없이 결정적 재생.
// 등록 상수(재등록 시점 고정): 초기 0.5 · η 0.10 · 상한 0.7 · 손실 = 방향 손실(적중 0/빗나감 1/무방향·플랫 0.5).
// 두 "전문가" = 본체 GapScore vs NF-Level — 최근 60 라벨 밤 중 신체계(nf.level) 데이터가 있는 밤만 채점.
// GapScore는 %단위가 아니라 방향 손실로 비교한다 (단위 이질 — 크기 손실은 G1B 챌린저 소관).
async function miniHedgeWnf(symbol: G1ASymbol): Promise<number> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const q = await createAdminClient().from("g1a_days").select("date,t2,labels").eq("symbol", symbol)
      .not("labels", "is", null).order("date", { ascending: true }).limit(60);
    let wn = 0.5, wb = 0.5;
    for (const r of (q.data ?? []) as { t2: Record<string, unknown> | null; labels: { L1?: number | null } | null }[]) {
      const L1 = r.labels?.L1;
      const nfl = (r.t2?.nf as { level?: { nf_level?: number } } | undefined)?.level?.nf_level;
      const gs = (r.t2?.verdict as { gap_score?: number } | undefined)?.gap_score;
      if (L1 == null || nfl == null || gs == null) continue;
      const dirLoss = (pred: number) => (Math.abs(L1) < 0.3 || pred === 0 ? 0.5 : Math.sign(pred) === Math.sign(L1) ? 0 : 1);
      wn *= Math.exp(-0.10 * dirLoss(nfl));
      wb *= Math.exp(-0.10 * dirLoss(gs));
    }
    return Math.min(0.7, Math.round((wn / (wn + wb)) * 1000) / 1000);
  } catch { return 0.5; }
}

// ── T2 사이클 (§5) ──
async function runT2(date: string, hhmm: string, hhmmss: string): Promise<string[]> {
  const notes: string[] = [];
  const rows = new Map<G1ASymbol, G1ARow>();
  for (const symbol of SYMBOLS) {
    rows.set(symbol, (await loadDay(date, symbol)) ?? { date, symbol, t1_snapshot: null, t2: null, labels: null, outcome: null });
  }
  // [발주자 검수 8/18 §2] 절단 시각 공통 스냅샷 — 야간선물·P1은 **크론 호출당 1회** 조회해 두 종목 행이 같은 값을 쓴다.
  // 카드별·종목별 개별 조회 금지: 판정에 쓰인 값 = 화면 값 = 로그 값. 19:35 절단 이후의 봉은 수집은 하되 level/dc_nf 산출에서 제외(동결).
  const CUT = "19:35";
  const snap: { t: string; nf_pct: number | null; pieces: Record<string, Record<string, number | null>> } = { t: hhmm, nf_pct: null, pieces: {} };
  if (hhmm >= "18:00" && hhmm <= "19:40") {
    try {
      const { fetchKisNightFutures, hasKisKeys } = await import("@/lib/market/kis");
      if (hasKisKeys()) {
        const nfq = await fetchKisNightFutures();   // CM 기본 (kis.ts) — 8/15 정화 이후 단일 시장구분
        const pct = (nfq as { changePercent?: number | null })?.changePercent;
        if (typeof pct === "number") snap.nf_pct = pct;
        const vol = (nfq as { volume?: number | null })?.volume;
        if (typeof vol === "number") (snap as Record<string, unknown>).nf_vol = vol;   // T2+ v2 confidence_vol 축적 (8/20~)
      }
    } catch { /* 결측 허용 */ }
  }
  if (hhmm >= W.t2Start && hhmm <= W.t2End) {
    try {
      const { fetchEveningPieces } = await import("./data");
      for (const symbol of SYMBOLS) snap.pieces[symbol] = await fetchEveningPieces(symbol);   // P3만 종목 의존, P1(유럽 반도체)은 공통
    } catch { /* 결측 허용 */ }
  }

  for (const symbol of SYMBOLS) {
    const row = rows.get(symbol)!;
    const t2: T2State = row.t2 ?? {
      trigger_type: null, trigger_time: null, entry_px_virtual: null, verdict: null,
      reversal_watch: { fired: false, time: null, action: null }, evals: [], report_r1: null,
    };
    // 10분 격자: 같은 슬롯 중복 평가 방지 (크론이 1~2분 간격이어도 무해)
    const slot = hhmm.slice(0, 4) + String(Math.floor(parseInt(hhmm.slice(3, 5), 10) / W.slotMinutes) * W.slotMinutes).padStart(2, "0");
    const already = t2.evals.some((e) => e.time.startsWith(slot.slice(0, 3)) && e.time.slice(3, 5) >= slot.slice(4));

    // [발주자 8/15 §1] DC-NF 체계 — 18:00~19:35 야간선물 10분봉 수집 (4점 스냅샷 지시의 상위 대체).
    // 트리거 이후에도 계속 수집한다 (§3 역행 경보의 원천). 본판정 미반영 — 기록 + T2+ 섀도 재료.
    //   NF-Level = 누적 변화율(KIS CM = 주간 종가 대비 내재갭) × β_mkt (원칙 §5: β_mkt 경유 환산만)
    //   DC-NF    = 10분봉 동방향 지속률 (누적 방향과 같은 부호의 봉 비율, 봉 3개부터 산출)
    if (hhmm >= "18:00" && hhmm <= "19:40") {
      const t2u = t2 as Record<string, unknown>;
      const nf0 = (t2u.nf ?? { bars: [] }) as { bars: { t: string; pct: number }[] } & Record<string, unknown>;
      if (!nf0.bars.some((b) => b.t.slice(0, 4) === hhmm.slice(0, 4))) {
        try {
          {
            const pct = snap.nf_pct;   // 공통 스냅샷 (호출당 1회 조회 — 두 종목 동일 값)
            if (typeof pct === "number") {
              nf0.bars = [...nf0.bars, { t: hhmm, pct, ...(typeof (snap as Record<string, unknown>).nf_vol === "number" ? { vol: (snap as Record<string, unknown>).nf_vol as number } : {}) }];
              // β_mkt: G1B 라이브 칼만 갱신치 우선 (R1 nf 전문가와 동일 β — 일관성), 결측 시 pack 초기값
              let beta: number = (await import("@/lib/g1b/config")).G1B_CONFIG.init.betaMkt[symbol as "000660" | "005930"];
              try {
                const { createAdminClient } = await import("@/lib/supabase/admin");
                const stq = await createAdminClient().from("g1b_state").select("state").eq("symbol", symbol).maybeSingle();
                const b = (stq.data?.state as { kalman?: { beta_mkt?: number } } | undefined)?.kalman?.beta_mkt;
                if (typeof b === "number" && b > 0) beta = b;
              } catch { /* 폴백 유지 */ }
              // 봉 수익률 = 누적의 차분 (첫 봉은 누적 자체 — 18:00 시가≈주간 종가 근사, 베이시스 오차 명기)
              // 19:35 절단: level/dc_nf는 **≤19:35 봉만**으로 산출·동결. 이후 봉은 수집(역행 경보 원천)만.
              const cutBars = nf0.bars.filter((b) => b.t <= CUT);
              const src = cutBars.length ? cutBars : nf0.bars;
              const deltas = src.map((b, i) => (i === 0 ? b.pct : b.pct - src[i - 1].pct)).filter((d) => d !== 0);
              const cum = src[src.length - 1].pct;
              const agree = deltas.filter((d) => Math.sign(d) === Math.sign(cum)).length;
              nf0.level = { pct: cum, nf_level: Math.round(cum * beta * 100) / 100, beta_mkt: Math.round(beta * 1000) / 1000, cut: CUT, cut_t: src[src.length - 1].t };
              nf0.dc_nf = cum !== 0 && deltas.length >= 3 ? Math.round((agree / deltas.length) * 100) / 100 : null;
              t2u.nf = nf0;
              if (!t2u.nf_evening) t2u.nf_evening = { t: hhmm, pct }; // 계기판 g1a_nf_evening 개시일 연속성
            }
          }
        } catch { /* 결측 허용 */ }
      }
    }

    // 최종 확정 유예 (2026-08-10 실측 버그 수정): 종전 `hhmm <= W.t2Final`은 크론이 정확히 19:40에
    // 와야만 최종 분기가 열렸다 — 실제 크론은 19:35 → 19:45라 8/10 저녁 두 종목 모두 T2-F 확정·발송 누락.
    // t2End(19:55)까지 유예 — isFinal 판정은 그대로 19:40 기준.
    if (!t2.trigger_type && hhmm <= W.t2End) {
      if (already && hhmm < W.t2Final) continue;
      const f = await collectT2Features(symbol);
      const ctx = await buildAbstainCtx(f);
      const isFinal = hhmm >= W.t2Final;
      const other = [...rows.values()].some((r) => r.symbol !== symbol && r.t2?.trigger_type && r.t2.verdict?.direction !== "NEUTRAL");
      const { verdict, blocked } = evaluateT2(symbol, f, ctx, hhmm, isFinal, other);
      t2.evals.push({ time: hhmm, gap_score: verdict.gap_score, blocked_by: blocked });
      // (구 4점 스냅샷 블록은 DC-NF 10분봉 체계로 흡수 — 발주자 8/15 §1, 수집은 위 공통 블록)
      // 저녁 정보 조각 P1~P5 (발주자 8/12 §3 — 확보분 기록, 본 판정 미사용)
      if (snap.pieces[symbol]) (t2 as Record<string, unknown>).pieces = { ...snap.pieces[symbol], snap_t: hhmm };   // 공통 스냅샷 (호출당 1회)
      // E2 (발주자 8/12) → 개정 (발주자 8/15 §2 + 정확도연동 §2): "T2+" 섀도 = {NF-Level 방향 재료
      // + 확인 조건(DC-PM ≥60% 또는 DC-NF ≥60%)} + w_nf 일일 갱신형 미니 Hedge (초기 0.5·상한 0.7).
      // 재등록: challengers/t2plus_nightfut.md (개정판 — 갱신형 기준). 모자이크는 동일 확인 조건 공유.
      // 연속성: tanh(NF-Level/0.6) ≈ tanh(pct·β/0.6) — β≈1.5에서 종전 tanh(pct/0.4)와 내부값 동일,
      // 바뀐 것은 진폭(1.0 고정 → w_nf 갱신형)과 확인 조건 추가다.
      const th = thetaAt(hhmm);
      {
        const t2u = t2 as Record<string, unknown>;
        const nfo = t2u.nf as { level?: { nf_level: number }; dc_nf?: number | null } | undefined;
        const pieces = t2u.pieces as Record<string, number | null> | undefined;
        // 섀도 등급 매핑 = 본판정과 동일 기준 (발주자 8/14 §3): 베팅 문턱 θ + Lean 문턱 0.5 + gradeLabel
        const { gradeLabel: gl } = await import("@/lib/g1/action");
        const isEvt = Boolean(verdict.event_night) || (verdict.abstain_reason ?? "").startsWith("보류1");
        const dcConfirm = (f.F21_dcpm ?? 0) >= G1A_CONFIG.trigger.minDcPm || (nfo?.dc_nf ?? 0) >= 0.6;
        const shadowGrade = (score: number) => {
          const dir0 = score >= 0.5 ? "UP" as const : score <= -0.5 ? "DOWN" as const : null;
          const bet = Math.abs(score) >= th.low && !verdict.abstain_reason && dcConfirm;
          const g = bet ? (Math.abs(score) >= th.high ? "High" : "Low") : dir0 && !isEvt ? "Lean" : "Flat";
          return { dir: bet ? (score > 0 ? "UP" : "DOWN") : dir0, grade: g, label: gl(g, bet ? (score > 0 ? "UP" : "DOWN") : dir0, isEvt) };
        };
        const wNf = await miniHedgeWnf(symbol);
        const nfTerm = nfo?.level ? wNf * Math.tanh(nfo.level.nf_level / 0.6) : 0;
        const sScore = Math.round((verdict.gap_score + nfTerm) * 100) / 100;
        const sh = t2u.shadow as Record<string, unknown> | undefined ?? {};
        const sg = shadowGrade(sScore);
        if (!sh.first_trigger && (sg.grade === "High" || sg.grade === "Low")) sh.first_trigger = { t: hhmm, dir: sg.dir, score: sScore };
        sh.last = { t: hhmm, score: sScore, dir: sg.dir ?? "NEUTRAL", label: sg.label, w_nf: wNf, dc_nf: nfo?.dc_nf ?? null, dc_confirm: dcConfirm };
        t2u.shadow = sh;
        const p1 = pieces?.p1_eu_semi_avg;
        const mScore = p1 != null ? Math.round((sScore + 0.75 * Math.tanh(p1 / 0.5)) * 100) / 100 : sScore;
        const mo = t2u.mosaic as Record<string, unknown> | undefined ?? {};
        const mg = shadowGrade(mScore);
        if (!mo.first_trigger && (mg.grade === "High" || mg.grade === "Low")) mo.first_trigger = { t: hhmm, dir: mg.dir, score: mScore };
        mo.last = { t: hhmm, score: mScore, dir: mg.dir ?? "NEUTRAL", label: mg.label };
        t2u.mosaic = mo;
        // [발주 D 8/20] T2+ v2 챌린저 — 야간선물 기준점 + drift 예측 (구판 shadow는 위에 보존·분리)
        // 판정 시점 = 19:35 절단(level 동결 시점) 이후 첫 평가. 성분별 기여 로그 포함 (절제 진단 구조).
        try {
          const nfoV2 = t2u.nf as { level?: { pct: number; nf_level: number; beta_mkt: number }; dc_nf?: number | null; bars?: { t: string; pct: number; vol?: number }[] } | undefined;
          if (nfoV2?.level && hhmm >= "19:35" && !t2u.shadow_v2) {
            const { judgeDrift, buildShadowV2 } = await import("./t2plusV2");
            const { fetchBasketAccel30m, fetchMacroEveningDelta } = await import("./data");
            const [accel, macro] = await Promise.all([fetchBasketAccel30m(symbol), fetchMacroEveningDelta()]);
            const drift = judgeDrift({
              basketAccel30m: accel, dcNf: nfoV2.dc_nf ?? null, nfCumSign: Math.abs(nfoV2.level.pct) >= 0.1 ? Math.sign(nfoV2.level.pct) : 0,
              dcPm: f.F21_dcpm, basketSign: Math.abs(f.F21_basket ?? 0) >= 0.1 ? Math.sign(f.F21_basket!) : 0,
              p1Slope: pieces?.p1_eu_semi_avg ?? null, eventTonight: ctx.eventTonight, macro,
            });
            const { G1B_CONFIG } = await import("@/lib/g1b/config");
            const sigmaV2 = G1B_CONFIG.sigmaBase[symbol as "000660" | "005930"][ctx.eventTonight ? "event" : "normal"];
            // 거래량 배율: 20일 축적 전 null (강등 미적용 — 사전 등록 명기). 축적: bars[].vol
            t2u.shadow_v2 = buildShadowV2({ t: hhmm, nfCutPct: nfoV2.level.pct, beta: nfoV2.level.beta_mkt, drift, sigma: sigmaV2, volRatio: null, thetaLow: 2.5 });
          }
        } catch { /* v2 결측 허용 — 본판정 무접촉 */ }
      }
      const { t2Action, phaseTag, gradeLabel } = await import("@/lib/g1/action");
      const { t2Grade } = await import("./score");
      const phase = await phaseTag("t2");
      const grade0 = t2Grade(verdict, th);   // 등급 = 점수 구간 (트리거 시각 θ 기준) — 행동과 분리 (발주자 확정 8/18)
      const isEventN = Boolean(verdict.event_night) || (verdict.abstain_reason ?? "").startsWith("보류1");
      const grade = { ...grade0, label: gradeLabel(grade0.grade, grade0.lean_dir, isEventN) }; // 용어 확정판 8/13 — 3곳 동일 규격
      (t2 as Record<string, unknown>).grade = grade;   // 4등급 + Lean 채점 원천 (발주자 8/12 §1·2)
      // 상충 플래그 (발주자 8/13 §2): 방향 판단(score) vs 번역 추정(잔여갭) 부호 불일치 — 3자 대조 표본
      (t2 as Record<string, unknown>).conflict =
        verdict.expected_residual_gap != null && verdict.gap_score !== 0 &&
        Math.sign(verdict.gap_score) !== Math.sign(verdict.expected_residual_gap);
      // 상충 플래그 v2 (발주자 판정 8/19 밤): 기준점(정규 종가) 통일 3자 — 룰 방향 / 잔여갭 경로 시가 예상 / 야간선물 β환산
      {
        const { conflictV2 } = await import("@/lib/g1/copy");
        const nfl = ((t2 as Record<string, unknown>).nf as { level?: { nf_level?: number } } | undefined)?.level?.nf_level ?? null;
        (t2 as Record<string, unknown>).conflict_v2 = conflictV2({ gapScore: verdict.gap_score, residGap: verdict.expected_residual_gap, nxtPx: f.nxt_last_px, rNxt: f.r_nxt, nfLevel: nfl });
      }
      // 즉시 시행 b (이벤트 밤): beat/miss 시나리오 2줄 — IM 미조달이라 G1B 이벤트 σ를 대용 (명기).
      if ((verdict.event_night || (verdict.abstain_reason ?? "").startsWith("보류1")) && !(t2 as Record<string, unknown>).event_scenario) {
        const { G1B_CONFIG } = await import("@/lib/g1b/config");
        const se = G1B_CONFIG.sigmaBase[symbol as "000660" | "005930"].event;
        (t2 as Record<string, unknown>).event_scenario = {
          event: verdict.abstain_reason,
          beat: `호재 시 +${se.toFixed(1)}% 안팎 갭 예상 (IM 미조달 — G1B 이벤트 σ 대용)`,
          miss: `악재 시 −${se.toFixed(1)}% 안팎 갭 예상`,
        };
        // 즉시 시행 c: E-등급 섀도 — E-Low 조건(IM<1.5x·High 문턱·포지셔닝 비극단) 중 검사 가능분만
        // + MT 내성 조건 병기 (WORKORDER_MT_v04 §5 사다리 2단계 — 기록 전용, 판정 무개입)
        const mtNote = await (await import("@/lib/mt/eshadow")).mtEShadowNote(
          symbol, date, verdict.gap_score >= 0.5 ? "UP" : verdict.gap_score <= -0.5 ? "DOWN" : null);
        // 헌법 발효(2026-08-20) 후: E-섀도 트랙 임무 종료 — 본판정 verdict.e_grade가 정본. 여기엔 발효 후 본판정 E 기록(e_record)만 남긴다.
        (t2 as Record<string, unknown>).e_record = {
          grade: verdict.e_grade ?? null, score: verdict.gap_score, size: verdict.size,
          e_low_checks: verdict.e_low_checks ?? null, mt: mtNote, constitution: "이벤트 밤 4등급제 발효 2026-08-20 (본판정·가상)",
        };
      }
      if (!blocked && verdict.direction !== "NEUTRAL") {
        t2.trigger_type = isFinal ? "F" : "E";
        t2.trigger_time = hhmmss;
        t2.entry_px_virtual = f.nxt_last_px;
        t2.verdict = verdict;
        const act = t2Action(verdict, blocked, phase, grade);
        (t2 as Record<string, unknown>).action = act;                       // B3: 지시 이력 저장
        t2.report_r1 = act.line + "\n" + grade.label + "\n" + buildT2Report(symbol, t2.trigger_type, hhmm, verdict, f, date); // B5: 첫 줄 동일·둘째 줄 등급 규격
        notes.push(`${symbol} T2-${t2.trigger_type} ${act.code} (score ${verdict.gap_score})`);
        await sendSignal(`[G1A T2-${t2.trigger_type}] 저녁 갭 판정 (${phase}·log-only)`, t2.report_r1, notes);
      } else if (isFinal) {
        t2.trigger_type = "F";
        t2.trigger_time = hhmmss;
        t2.entry_px_virtual = f.nxt_last_px; // C3: 보류 밤도 가상 기준가 기록 — 기회비용 채점의 정본
        t2.verdict = verdict;
        const act = t2Action(verdict, blocked, phase, grade);
        (t2 as Record<string, unknown>).action = act;
        t2.report_r1 = act.line + "\n" + grade.label + "\n" + buildT2Report(symbol, "F", hhmm, verdict, f, date);
        notes.push(`${symbol} T2-F ${act.code}`);
        await sendSignal(`[G1A T2-F] 베팅 보류 확정 (${phase}·log-only)`, t2.report_r1, notes);
      } else {
        notes.push(`${symbol} 대기 (${blocked})`);
      }
    } else if (
      t2.trigger_type && t2.verdict && t2.verdict.direction !== "NEUTRAL" &&
      !t2.reversal_watch.fired && hhmm <= W.t2End
    ) {
      // §5.5 반전 감시
      const f = await collectT2Features(symbol);
      const rev = reversalCheck(t2.verdict.direction, f);
      if (rev.fired) {
        t2.reversal_watch = { fired: true, time: hhmmss, action: "19:55 전 전량 청산(가상)" };
        const revReport = buildReversalReport(symbol, hhmm, rev.why!, t2);
        t2.report_r1 = (t2.report_r1 ?? "") + "\n\n" + revReport;
        notes.push(`${symbol} 반전 감시 발동 — ${rev.why}`);
        await sendSignal(`[G1A 반전] 청산 기록 (가상·log-only)`, revReport, notes);
      }
      // [발주자 8/15 §3] 야간선물 역행 경보 (섀도 단계·가상 기록 — 본판정 반전과 별개):
      // 트리거 시점의 야간선물 누적 대비 진입 방향 역행 -0.5% 이상이면 경보만 남긴다.
      {
        const t2u = t2 as Record<string, unknown>;
        const nfo = t2u.nf as { bars?: { t: string; pct: number }[]; reversal_alert?: unknown } | undefined;
        if (nfo?.bars?.length && !nfo.reversal_alert) {
          const trigT = (t2.trigger_time ?? "").slice(0, 5);
          const atTrig = nfo.bars.filter((b) => b.t <= trigT).pop() ?? nfo.bars[0];
          const cur = nfo.bars[nfo.bars.length - 1];
          const drift = Math.round((cur.pct - atTrig.pct) * 100) / 100;
          const against = t2.verdict.direction === "UP" ? drift <= -0.5 : drift >= 0.5;
          if (against) {
            nfo.reversal_alert = { t: hhmm, drift_pct: drift, base_t: atTrig.t, note: "야간선물 진입 방향 역행 ≥0.5% — 경보(가상)" };
            t2u.nf = nfo;
            notes.push(`${symbol} 야간선물 역행 경보 ${drift}% (가상)`);
          }
        }
      }
    }
    row.t2 = t2;
    await upsertDay(row);
  }
  return notes;
}

// ── 라벨 채점 (§3 — D+1 오전) ──
async function runLabels(): Promise<string[]> {
  const notes: string[] = [];
  const today = kst().date;
  const unlabeled = await loadUnlabeled();
  for (const row of unlabeled) {
    if (row.date >= today) continue;           // 오늘 판정분은 내일 채점
    if (!row.t2?.trigger_type) continue;       // 판정 자체가 없던 날(주말 등)은 스킵
    const symbol = row.symbol;
    const daily = await fetchDaily(symbol, 15);
    const di = daily.findIndex((b) => b.date === row.date);
    const d1 = daily.find((b, i) => i > di && b.open > 0);
    if (di < 0 || !d1 || d1.date > today) continue; // D+1 시가 미확정
    const closeD = daily[di].close;
    const L1 = closeD > 0 ? ((d1.open - closeD) / closeD) * 100 : null;
    const entry = row.t2.entry_px_virtual;
    const L1p = entry && entry > 0 ? ((d1.open - entry) / entry) * 100 : null;
    // L2: NXT 프리 첫 체결 / L3: 시가+30분
    let L2: number | null = null, L3: number | null = null;
    try {
      const pre = await fetchNxtPremarket(symbol, d1.date.replace(/-/g, ""));
      if (pre?.length && entry) L2 = ((pre[0].close - entry) / entry) * 100;
      const mins = await fetchDayMinutes(symbol, d1.date.replace(/-/g, ""), "094500");
      const at930 = mins?.filter((m) => m.time <= "09:30").pop();
      if (at930 && d1.open > 0) L3 = ((at930.close - d1.open) / d1.open) * 100;
    } catch { /* 보조 라벨 결측 허용 */ }
    const r2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);
    row.labels = {
      L1p: r2(L1p), L1: r2(L1), L2: r2(L2), L3: r2(L3),
      capture_ratio: L1p != null && L1 != null && Math.abs(L1) > 0.05 ? Math.round((L1p / L1) * 100) / 100 : null,
    };
    const v = row.t2.verdict;
    const hit = v && v.direction !== "NEUTRAL" && L1p != null
      ? (v.direction === "UP" ? L1p >= G1A_CONFIG.label.flatBand : L1p <= -G1A_CONFIG.label.flatBand)
      : null;
    row.outcome = { hit, luck_flag: false, postmortem: "" };
    // [발주 D §4 8/20] T2+ v2 이중 채점: ⓐ 최종 예상갭 vs 실측(L1) ⓑ drift 방향 vs 실제 야간 궤적(19:35→06:00)
    try {
      const sv2 = (row.t2 as unknown as Record<string, unknown>).shadow_v2 as { expected_gap_pct?: number; base_pct?: number; drift?: { dir?: string } } | undefined;
      if (sv2?.expected_gap_pct != null && L1 != null) {
        const { createAdminClient } = await import("@/lib/supabase/admin");
        const gb = await createAdminClient().from("g1b_days").select("night").eq("date", d1.date).eq("symbol", symbol).maybeSingle();
        const nfClose = (gb.data?.night as { night_fut?: { v?: number | null; late_arrival?: boolean } } | null)?.night_fut;
        const path = nfClose?.v != null && !nfClose.late_arrival && sv2.base_pct != null ? nfClose.v * 100 - sv2.base_pct : null;
        const driftDir = sv2.drift?.dir ?? "중립";
        const driftHit = path == null || driftDir === "중립" ? null : Math.abs(path) < 0.15 ? null : (driftDir === "상방") === (path > 0);
        (row.labels as unknown as Record<string, unknown>).v2 = {
          te_pct: Math.round(Math.abs(L1 - sv2.expected_gap_pct) * 100) / 100,
          drift_hit: driftHit, nf_path_pct: path != null ? Math.round(path * 100) / 100 : null,
          note: "ⓑ는 base 무임승차 차단 — drift 단독 채점 (발주 D §4)",
        };
      }
    } catch { /* v2 채점 결측 허용 */ }
    await upsertDay(row);
    notes.push(`${symbol} ${row.date} 라벨 (L1' ${row.labels.L1p ?? "—"}%)`);
  }
  return notes;
}

export async function runG1AService(): Promise<{ ok: boolean; window: string; notes: string[] }> {
  const { date, hhmm, hhmmss, weekday } = kst();
  if (!(await g1aTablesReady())) return { ok: false, window: "none", notes: ["마이그레이션 034 미적용 — g1a_days 없음"] };
  if (weekday === 0 || weekday === 6) return { ok: true, window: "weekend", notes: [] };

  if (hhmm >= W.labelStart && hhmm <= W.labelEnd) return { ok: true, window: "labels", notes: await runLabels() };
  if (hhmm >= W.t1Start && hhmm <= W.t1End) return { ok: true, window: "t1", notes: await runT1(date) };
  if (hhmm >= W.t2Start && hhmm <= W.t2End) return { ok: true, window: "t2", notes: await runT2(date, hhmm, hhmmss) };
  return { ok: true, window: "idle", notes: [] };
}
