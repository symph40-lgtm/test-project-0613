// 국면별 전용 패널 (S1~S4) + 상시 부품 C1~C7 — 스펙 SPEC_MT_v04.md §1.2·§1.3
// 각 부품은 0~1 연속 충족도(fill)를 낸다 (발주자 보충 §1.4-1a). 투표는 fill ≥ 0.6.
// 부품 총수 동결: S1 4 · S2 4 · S3 4 · S4 3 · 상시 7. 추가는 신규 시그널 절차로만.

import { c1Series, ratioMedian } from "./c1";
import type { C1Context } from "./c1";
import { MT_CONFIG, PART_NAMES } from "./config";
import { clamp, clvAvg, maxHigh, mean, minLow, r2, r3, ramp, realizedVol, ret, volByDirection } from "./indicators";
import { computeBox, confirmLevels } from "./phase";
import type { Bar, CommonParts, PanelState, PartFill, PhaseKey } from "./types";

export type PanelContext = {
  symbol: string;
  c1: C1Context;
  /** 상대강도용 지수 종가 (일자 → 종가). 대상이 지수면 leaders로 대체 */
  indexCloseByDate?: Map<string, number>;
  /** 대상이 KOSPI200일 때 주도주 종가 (삼전·하닉) */
  leaderCloseByDate?: Map<string, number>[];
  /** 라이브 전용 등락종목수 비율 (소급 구간은 undefined) */
  breadth?: number | null;
  /** C5 수급 (60일까지만 조달) */
  flow?: { streak: number | null; decel: number | null } | null;
  /**
   * 부품 가중 (§4.2 월간 재캘리브레이션의 산물). 미지정 = 전부 1.
   * ⚠ 가중은 **연속 가중합(톤) 경로에만** 쓰인다. 투표(전환 선언)는 가중과 무관하게 1부품 1표다
   *   — 발주자 보충 §1.4-1b의 역할 분리를 코드 수준에서 지킨다.
   */
  weights?: Record<string, number>;
};

const part = (key: string, fill: number | null, detail: string): PartFill => ({
  key, name: PART_NAMES[key] ?? key, fill: fill == null ? null : r3(clamp(fill, 0, 1)), available: fill != null, detail,
});

// ── 공통 재료 ──────────────────────────────────────────────
/** 20일 상대강도 = 대상 20일 수익률 − 지수 20일 수익률 (%p) */
function relStrength(bars: Bar[], i: number, ctx: PanelContext): number | null {
  const n = 20;
  if (i < n) return null;
  const own = bars[i - n].close > 0 ? (bars[i].close / bars[i - n].close - 1) * 100 : null;
  if (own == null) return null;
  const refRet = (m: Map<string, number>) => {
    const a = m.get(bars[i].date), b = m.get(bars[i - n].date);
    return a != null && b != null && b > 0 ? (a / b - 1) * 100 : null;
  };
  if (ctx.indexCloseByDate) {
    const r = refRet(ctx.indexCloseByDate);
    return r == null ? null : own - r;
  }
  // 대상이 지수 자신 — 주도주(삼전·하닉) 평균 상대강도로 대체
  if (ctx.leaderCloseByDate?.length) {
    const xs: number[] = [];
    for (const m of ctx.leaderCloseByDate) {
      const a = m.get(bars[i].date), b = m.get(bars[i - n].date);
      if (a != null && b != null && b > 0) xs.push((a / b - 1) * 100 - own);
    }
    return mean(xs);
  }
  return null;
}

/** 하락일/상승일 평균 거래량 비 (낮을수록 매물 고갈) */
function downUpVolRatio(bars: Bar[], i: number, n: number): number | null {
  const { up, down } = volByDirection(bars, i, n);
  return up && up > 0 && down != null ? down / up : null;
}

export type FtdHit = { day: number; date: string; lowDate: string; gain: number; strong: boolean };

/**
 * 확인일(FTD) 탐색 — 바닥 시도(20일 신저가) 이후 **4~7일차**의 대량 상승일. [O'Neil Follow-Through Day]
 * 반환 규칙: 강한 확인(strong) 우선, 같은 등급이면 **가장 최근** 것.
 * (초기 구현은 가장 오래된 바닥 시도에서 조기 반환해 7/31 같은 최근 사건을 가렸다 — 2026-08-15 백필 검산에서 교정.)
 */
export function findFtd(bars: Bar[], i: number): FtdHit | null {
  const hits = ftdCandidates(bars, i);
  if (!hits.length) return null;
  const strong = hits.filter((h) => h.strong);
  const pool = strong.length ? strong : hits;
  return pool[pool.length - 1]; // 가장 최근
}

/** 탐색 범위(최근 40일) 안의 확인일 후보 전부 — 오래된 → 최근 */
export function ftdCandidates(bars: Bar[], i: number): FtdHit[] {
  const c = MT_CONFIG.panel.ftd;
  const out: FtdHit[] = [];
  for (let low = Math.max(c.lowWindow, i - 40); low <= i - c.minDay; low++) {
    const lowVal = minLow(bars, low, c.lowWindow);
    if (lowVal == null || bars[low].low > lowVal) continue;   // 그날이 20일 신저가여야 '바닥 시도'
    for (let d = c.minDay; d <= c.maxDay; d++) {
      const k = low + d;
      if (k > i) break;
      const r = ret(bars, k);
      if (r == null) continue;
      const vol20 = mean(bars.slice(Math.max(0, k - 20), k).map((b) => b.volume));
      const strong = r >= c.minGainPct && bars[k].volume > bars[k - 1].volume && vol20 != null && bars[k].volume > vol20;
      const partial = r >= c.minGainPct || (vol20 != null && bars[k].volume > vol20 && r > 0);
      if (strong || partial) out.push({ day: d, date: bars[k].date, lowDate: bars[low].date, gain: r2(r) as number, strong });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 특정 하루(i)가 확인일 조건을 만족하는지 — ⓑ 같은 개별일 판정 보고용 */
export function ftdAtDay(bars: Bar[], i: number): { hit: FtdHit | null; nearestLow: { date: string; dayDiff: number } | null } {
  const c = MT_CONFIG.panel.ftd;
  const hit = ftdCandidates(bars, i).find((h) => h.date === bars[i].date) ?? null;
  let nearestLow: { date: string; dayDiff: number } | null = null;
  for (let low = i - 1; low >= Math.max(c.lowWindow, i - 40); low--) {
    const lowVal = minLow(bars, low, c.lowWindow);
    if (lowVal != null && bars[low].low <= lowVal) { nearestLow = { date: bars[low].date, dayDiff: i - low }; break; }
  }
  return { hit, nearestLow };
}

// ── 패널 ──────────────────────────────────────────────────
export function buildPanels(bars: Bar[], i: number, ctx: PanelContext): {
  panels: Record<PhaseKey, PanelState>; common: CommonParts;
} {
  const P = MT_CONFIG.panel;
  const series = c1Series(bars, i, MT_CONFIG.c1.window, ctx.symbol, ctx.c1);
  const badMed = ratioMedian(series, -1);
  const goodMed = ratioMedian(series, 1);
  // 표시용 박스는 engine이 따로 산출한다 — 여기서는 돌파 기준선(전일 박스)만 필요
  // S1④ 돌파 부품도 기준선은 **전일까지의 박스** (당일 고가 포함 시 돌파가 원리상 성립 불가 — engine 주석 참조)
  const lv = confirmLevels(computeBox(bars, i - 1), bars, i - 1);
  const close = bars[i].close;
  const dnUp10 = downUpVolRatio(bars, i, P.volWindow);
  const rs = relStrength(bars, i, ctx);

  // ── R4 배선 재료 (2026-08-16 재설계 패키지 — 재료 보강, 부품 수 동결)
  const W = MT_CONFIG.wire;
  const clv20 = clvAvg(bars, i, 20);                       // C3 종반 강도
  const high252v = maxHigh(bars, i, Math.min(252, i + 1));
  const high52 = high252v && high252v > 0 ? close / high252v : null;   // C7 52주 고점 근접도
  const flowStreak = ctx.flow?.streak ?? null;             // C5 외인 연속 (부호 = 매수/매도, 절대값 = 일수)
  const c5Bonus = (dir: 1 | -1) => (flowStreak != null && Math.sign(flowStreak) === dir && Math.abs(flowStreak) >= W.C5.streakMin ? W.C5.bonus : 0);
  const c7Mult = (at: number, mult: number) => (high52 != null && high52 >= at ? mult : 1);
  /** C3 합성: fill = (1−w)×기존 + w×CLV항 (CLV 결측이면 기존 그대로) */
  const withC3 = (fill: number | null, w: number, clvTerm: number | null) =>
    fill == null ? null : clvTerm == null ? fill : (1 - w) * fill + w * clvTerm;

  // ── S1 바닥권
  const s1: PartFill[] = [
    part("S1_1", badMed == null ? null : ramp(0.8 - badMed, 0, 0.8),
      badMed == null ? "악재일 표본 없음" : `악재일 반응배율 중앙값 ${badMed.toFixed(2)}`),
    part("S1_2", dnUp10 == null ? null : Math.min(1, ramp(1.0 - dnUp10, 0, 0.4) + c5Bonus(1)),
      dnUp10 == null ? "거래량 표본 없음" : `하락일/상승일 거래량 ${dnUp10.toFixed(2)}${c5Bonus(1) ? ` · 외인 매수 연속 +${W.C5.bonus}` : ""}`),
    (() => {
      const f = findFtd(bars, i);
      return part("S1_3", f ? (f.strong ? 1 : 0.5) : 0,
        f ? `${f.date} 바닥 시도 +${f.day}일차 ${f.gain}%${f.strong ? " (대량 확인)" : " (부분 충족)"}` : "확인일 없음");
    })(),
    part("S1_4", (() => {
      const base = close > lv.high ? 1 : close > lv.high * 0.995 ? 0.6 : lv.high > lv.low ? ramp(close, lv.low, lv.high) * 0.5 : null;
      return base == null ? null : Math.min(1, base * c7Mult(W.C7.S1_4.at, W.C7.S1_4.mult));
    })(),
      `종가 ${close.toLocaleString()} vs 상단 ${Math.round(lv.high).toLocaleString()} (${lv.via})${high52 != null && high52 >= W.C7.S1_4.at ? " · 52주 고점권" : ""}`),
  ];

  // ── S2 상승 추세
  const gapDays = (() => {
    let g = 0;
    for (let k = Math.max(1, i - P.gap.window + 1); k <= i; k++) {
      if (bars[k].open > bars[k - 1].high && bars[k].low > bars[k - 1].close) g++;
    }
    return g;
  })();
  const s2: PartFill[] = [
    part("S2_1", Math.min(1, gapDays / P.gap.target), `최근 ${P.gap.window}일 미충족 상방갭 ${gapDays}건`),
    part("S2_2", dnUp10 == null ? null : ramp(1.0 - dnUp10, 0, 0.3),
      dnUp10 == null ? "거래량 표본 없음" : `눌림 거래량비 ${dnUp10.toFixed(2)}`),
    (() => {
      const clvUp = clv20 == null ? null : ramp(clv20, 0.45, 0.65);
      const baseFill = ctx.breadth != null ? ramp(ctx.breadth, P.breadthFloor, P.breadthFloor + P.breadthSpan)
        : rs == null ? null : ramp(rs, P.rsFloor, P.rsFloor + P.rsSpan);
      const baseTxt = ctx.breadth != null ? `등락종목수 비율 ${(ctx.breadth * 100).toFixed(0)}%` : rs == null ? "상대강도 미가용" : `상대강도 ${rs.toFixed(2)}%p (소급 대체)`;
      return part("S2_3", withC3(baseFill, W.C3.S2_3, clvUp), `${baseTxt}${clv20 != null ? ` · CLV20 ${clv20.toFixed(2)}` : ""}`);
    })(),
    part("S2_4", goodMed == null ? null : clamp(goodMed / 1.0, 0, 1),
      goodMed == null ? "호재일 표본 없음" : `호재일 반응배율 중앙값 ${goodMed.toFixed(2)}`),
  ];

  // ── S3 천장권
  const distr = (() => {
    const recent = volByDirection(bars, i, 10);
    const prior = volByDirection(bars, i - 10, 10);
    if (!recent.up || !prior.up || !recent.down || !prior.down) return null;
    const a = recent.up / prior.up, b = recent.down / prior.down;
    return { fill: ramp(1 - a, 0, 0.3) * 0.5 + ramp(b - 1, 0, 0.3) * 0.5, a, b };
  })();
  const utad = (() => {
    let u = 0;
    for (let k = Math.max(1, i - P.utad.window + 1); k <= i; k++) {
      const b20 = maxHigh(bars, k - 1, 20);
      if (b20 == null || bars[k].high <= b20) continue;
      for (let d = 1; d <= P.utad.returnDays; d++) {
        if (k + d <= i && bars[k + d].close < b20) { u++; break; }
      }
    }
    return u;
  })();
  const s3: PartFill[] = [
    part("S3_1", goodMed == null ? null : ramp(0.8 - goodMed, 0, 0.8),
      goodMed == null ? "호재일 표본 없음" : `호재일 반응배율 중앙값 ${goodMed.toFixed(2)}`),
    part("S3_2", distr ? Math.min(1, distr.fill + c5Bonus(-1)) : null,
      distr ? `상승일 거래량 ×${distr.a.toFixed(2)} · 하락일 ×${distr.b.toFixed(2)}${c5Bonus(-1) ? ` · 외인 매도 연속 +${W.C5.bonus}` : ""}` : "거래량 표본 없음"),
    part("S3_3", Math.min(1, Math.min(1, utad / P.utad.target) * c7Mult(W.C7.S3_3.at, W.C7.S3_3.mult)),
      `상방 돌파 후 복귀 ${utad}회 (최근 ${P.utad.window}일)${high52 != null && high52 >= W.C7.S3_3.at ? " · 52주 고점권" : ""}`),
    part("S3_4", withC3(rs == null ? null : ramp(-rs, -1, 4), W.C3.S3_4, clv20 == null ? null : ramp(0.55 - clv20, 0, 0.2)),
      rs == null ? "상대강도 미가용" : `상대강도 ${rs.toFixed(2)}%p${clv20 != null ? ` · CLV20 ${clv20.toFixed(2)}` : ""}`),
  ];

  // ── S4 하락 추세
  const sc = (() => {
    for (let k = Math.max(1, i - P.sc.window + 1); k <= i; k++) {
      const vol20 = mean(bars.slice(Math.max(0, k - 20), k).map((b) => b.volume));
      const body = ((bars[k].close - bars[k].open) / bars[k].open) * 100;
      if (vol20 == null || bars[k].volume < vol20 * P.sc.volMult || body > P.sc.bodyPct) continue;
      for (let d = 1; d <= P.sc.reboundDays; d++) {
        const r = k + d <= i ? ret(bars, k + d) : null;
        if (r != null && r >= P.sc.reboundPct) return { fill: 1, date: bars[k].date, rebound: true };
      }
      return { fill: 0.5, date: bars[k].date, rebound: false };
    }
    return null;
  })();
  const peak = (() => {
    const rv = realizedVol(bars, i, 20);
    if (rv == null) return null;
    let hi = rv;
    for (let k = Math.max(20, i - P.peakout.window + 1); k <= i; k++) {
      const v = realizedVol(bars, k, 20);
      if (v != null && v > hi) hi = v;
    }
    return hi > 0 ? { fill: ramp(hi - rv, 0, P.peakout.dropRatio * hi), rv, hi } : null;
  })();
  const badRecent = ratioMedian(c1Series(bars, i, 5, ctx.symbol, ctx.c1), -1);
  const badPrior = i >= 5 ? ratioMedian(c1Series(bars, i - 5, 5, ctx.symbol, ctx.c1), -1) : null;
  const s4: PartFill[] = [
    part("S4_1", sc?.fill ?? 0, sc ? `${sc.date} 대량 장대음봉${sc.rebound ? " + 반등 확인" : " (반등 미확인)"}` : "클라이맥스 없음"),
    part("S4_2", badRecent == null || badPrior == null || badPrior <= 0 ? null : ramp((badPrior - badRecent) / badPrior, 0, 1),
      badRecent == null || badPrior == null ? "악재일 표본 부족" : `악재 반응배율 ${badPrior.toFixed(2)} → ${badRecent.toFixed(2)}`),
    part("S4_3", peak?.fill ?? null, peak ? `RV20 ${peak.rv.toFixed(1)}% (10일 고점 ${peak.hi.toFixed(1)}%)` : "변동성 표본 없음"),
  ];

  // 발주자 승인 5건 (2026-08-16 부검 판정) — 투표 경로 반영. 톤(fillAvg)은 건드리지 않는다.
  const AP = MT_CONFIG.approved;
  const todayGrade = series[series.length - 1]?.grade ?? null;
  const c1VoteOk = todayGrade != null && (AP.c1GradesForVote as readonly string[]).includes(todayGrade);
  const mk = (parts0: PartFill[]): PanelState => {
    // C1 등급 A/B 한정: 등급 C(프록시)·미분류 날은 C1 파생 4부품을 **투표에서 결측** 처리 (기록·톤은 유지)
    const parts = parts0.map((p) =>
      AP.c1Parts.includes(p.key) && !c1VoteOk && p.available
        ? { ...p, detail: `${p.detail} [C1 등급 ${todayGrade ?? "없음"} — 투표 제외]` }
        : p);
    const voteEligible = (p: PartFill) => p.available && !(AP.c1Parts.includes(p.key) && !c1VoteOk);
    const avail = parts.filter((p) => p.available);
    const availVote = parts.filter(voteEligible);
    const threshold = MT_CONFIG.vote.byAvailable[availVote.length] ?? null;
    // 투표 가중: 안정성 진단 확정값(voteWeightOverride) > 늑대소년 0.5 > 기본 1 (v0.4.2 동결)
    const voteW = (k: string) => AP.voteWeightOverride[k] ?? (AP.wolfParts.includes(k) ? AP.wolfVote : 1);
    const vote = availVote.reduce((a, p) => a + ((p.fill ?? 0) >= MT_CONFIG.vote.fillThreshold ? voteW(p.key) : 0), 0);
    // 톤 경로만 가중 적용 (투표는 1부품 1표 — 역할 분리)
    const w = (k: string) => ctx.weights?.[k] ?? 1;
    const wSum = avail.reduce((a, p) => a + w(p.key), 0);
    return {
      parts, vote, threshold,
      candidate: threshold != null && vote >= threshold,
      fillAvg: avail.length && wSum > 0
        ? r3(avail.reduce((a, p) => a + w(p.key) * (p.fill as number), 0) / wSum)
        : null,
    };
  };

  // ── 상시 부품 C1~C7
  const today = series[series.length - 1];
  const vol20 = volByDirection(bars, i, MT_CONFIG.panel.volWindowLong);
  const rv20 = realizedVol(bars, i, 20), rv60 = realizedVol(bars, i, 60);
  const common: CommonParts = {
    C1: {
      ratio: today?.ratio ?? null, grade: today?.grade ?? null, materialDir: today?.materialDir ?? 0,
      justified: today?.justified ?? null, excluded: today?.excluded ?? true,
      beta: null, // engine에서 채움 (β는 대상·창 단위 1회 산출)
    },
    C2_vol_asym: vol20.up && vol20.down ? r2(vol20.up / vol20.down) : null,
    C3_clv20: r3(clv20),
    C4_breadth_or_rs: ctx.breadth != null ? r3(ctx.breadth) : r2(rs),
    C5_flow: ctx.flow ?? null,
    C6_squeeze: rv20 != null && rv60 ? r2(rv20 / rv60) : null,
    C6_peakout: peak ? r3(peak.fill) : null,
    C7_high52: r3(high52),
    c4_source: ctx.breadth != null ? "breadth" : rs != null ? "rs" : null,
  };

  return { panels: { S1: mk(s1), S2: mk(s2), S3: mk(s3), S4: mk(s4) }, common };
}
