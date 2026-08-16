// MT 엔진 — 하루치 MT 산출 (스펙 SPEC_MT_v04.md §1.4·§1.5·§3.1).
// 순수 함수: 같은 bars·ctx면 라이브·60일 백필·3년 소급이 **같은 값**을 낸다 (엔진 이중 구현 금지).
// 역할 분리 (발주자 보충 §1.4-1b):
//   · 국면 전환 선언 = 투표 (fill ≥ 0.6 → 1표, 2/3 · 4부품 3/4)
//   · MT 톤 값       = 연속 가중합 (게이트·내성 판정용)
// 두 경로는 서로를 참조하지 않는다.

import { betaSox } from "./c1";
import { MT_CONFIG, MT_ENGINE_VER } from "./config";
import { maxHigh, minLow, r2, r3 } from "./indicators";
import { buildPanels, findFtd, type PanelContext } from "./panels";
import { computeBox, computePhase, confirmLevels } from "./phase";
import type { Bar, MtDay, MtSymbol, PhaseKey, ReverseEvent, ToneState, TransitionState } from "./types";

const PHASES: PhaseKey[] = ["S1", "S2", "S3", "S4"];

/** §1.5 역신호 — 가격 이력만으로 재현 가능하게 산출 (상태 저장 불필요) */
function reverseSignals(bars: Bar[], i: number): { log: ReverseEvent[]; votes: Partial<Record<PhaseKey, number>> } {
  const R = MT_CONFIG.reverse;
  const log: ReverseEvent[] = [];
  const votes: Partial<Record<PhaseKey, number>> = {};

  // R2 눈금 통일 (2026-08-16): 역신호의 기준선도 가격 확인과 같은 눈금(종가)을 쓴다 — 어긋나면 "가짜 돌파"의 정의가 확정 규칙과 달라진다
  const useHL = (MT_CONFIG.box.basis as string) === "hl";
  const hiLine = (k: number) => (useHL ? maxHigh(bars, k, 20) : (k >= 19 ? Math.max(...bars.slice(k - 19, k + 1).map((b) => b.close)) : null));
  const loLine = (k: number) => (useHL ? minLow(bars, k, 20) : (k >= 19 ? Math.min(...bars.slice(k - 19, k + 1).map((b) => b.close)) : null));
  // 가짜 돌파: 박스 상단 돌파 후 2일 내 박스 안 회귀 → S2 확정 취소 + S3 경계 1표
  for (let k = Math.max(21, i - R.fakeBreakoutDays); k <= i; k++) {
    const lv = hiLine(k - 1);
    if (lv == null || bars[k].close <= lv) continue;
    for (let d = 1; d <= R.fakeBreakoutDays; d++) {
      if (k + d > i) break;
      if (bars[k + d].close < lv) {
        log.push({ date: bars[k + d].date, kind: "가짜돌파", detail: `${bars[k].date} 상단 ${Math.round(lv).toLocaleString()} 돌파 후 ${d}일 내 회귀 — 돌파가 아니라 유지가 신호` });
        votes.S3 = (votes.S3 ?? 0) + 1;
        break;
      }
    }
  }
  // Spring: 박스 하단 이탈 후 3일 내 복귀 → 하락 아님, S1 강화 1표 [Wyckoff Spring]
  for (let k = Math.max(21, i - R.springDays); k <= i; k++) {
    const lv = loLine(k - 1);
    if (lv == null || (useHL ? bars[k].low : bars[k].close) >= lv) continue;
    for (let d = 1; d <= R.springDays; d++) {
      if (k + d > i) break;
      if (bars[k + d].close > lv) {
        log.push({ date: bars[k + d].date, kind: "Spring", detail: `${bars[k].date} 하단 ${Math.round(lv).toLocaleString()} 이탈 후 ${d}일 내 복귀` });
        votes.S1 = (votes.S1 ?? 0) + 1;
        break;
      }
    }
  }
  // 가짜 확인일: FTD 후 5일 내 직전 저점 하회 → 확인 취소
  const f = findFtd(bars, i);
  if (f) {
    const fi = bars.findIndex((b) => b.date === f.date);
    if (fi > 0) {
      const priorLow = minLow(bars, fi - 1, 20);
      for (let d = 1; d <= R.fakeFtdDays && fi + d <= i; d++) {
        if (priorLow != null && bars[fi + d].close < priorLow) {
          log.push({ date: bars[fi + d].date, kind: "가짜확인일", detail: `${f.date} 확인일 후 ${d}일 내 직전 저점 ${Math.round(priorLow).toLocaleString()} 하회 — 확인 취소` });
          break;
        }
      }
    }
  }
  return { log, votes };
}

export type MtContext = Omit<PanelContext, "symbol"> & {
  mode?: "live" | "backfill" | "retro";
  /** 부검 절제 전용: 국면 점수의 변동성 수축 항(C6 경로)을 끈다 */
  noSqueeze?: boolean;
};

export function computeMtDay(symbol: MtSymbol, bars: Bar[], i: number, ctx: MtContext): MtDay {
  const phase = computePhase(bars, i, { noSqueeze: ctx.noSqueeze });
  const box = computeBox(bars, i);
  const { panels, common } = buildPanels(bars, i, { ...ctx, symbol });
  common.C1.beta = r3(betaSox(bars, i, symbol, ctx.c1.soxByDate));

  // 역신호 표 가산 → 후보 재판정 (투표 경로 전용 — 톤 값은 건드리지 않는다)
  const rev = reverseSignals(bars, i);
  const fakeBreakoutToday = rev.log.some((e) => e.kind === "가짜돌파" && e.date === bars[i].date);
  const ftdCancelled = rev.log.some((e) => e.kind === "가짜확인일");
  for (const k of PHASES) {
    const add = rev.votes[k] ?? 0;
    if (add) {
      panels[k].vote += add;
      panels[k].candidate = panels[k].threshold != null && panels[k].vote >= panels[k].threshold;
    }
  }
  if (ftdCancelled) {
    const p = panels.S1.parts.find((x) => x.key === "S1_3");
    if (p && p.fill) { p.fill = 0; p.detail += " → 역신호로 취소"; }
    panels.S1.vote = panels.S1.parts.filter((x) => x.available && (x.fill ?? 0) >= MT_CONFIG.vote.fillThreshold).length + (rev.votes.S1 ?? 0);
    panels.S1.candidate = panels.S1.threshold != null && panels.S1.vote >= panels.S1.threshold;
  }

  // §1.4 전환 확정 = 후보 + 가격 확인.
  // ⚠ 가격 확인의 기준선은 **전일까지의 박스**다. 당일 고가를 포함한 박스로 재면 close ≤ high ≤ box_high라
  //   돌파가 원리상 성립하지 않는다 (2026-08-15 검산에서 잡은 버그). 표시용 박스(box)는 당일 포함 유지.
  // R1 (H3, 2026-08-16 재설계 패키지 — 발주서 원문 복원): 가격 확인의 **방향은 후보를 세운 패널이 정한다**.
  //   S1·S4 후보 → 상단 돌파 / S3 후보 → 하단 이탈. 여러 패널이 동시 후보면 각각 검사, 표 수 최다 우선.
  //   종전 구현은 방향을 phase.top에 맡겨 발주서에 없던 제약을 추가했고, 이것이 3년 성립률 1%의 주범이었다
  //   (docs/MT_AUTOPSY.md 2-6·4-6). 국면 확률은 이제 톤 값에만 쓰인다.
  const lv = confirmLevels(computeBox(bars, i - 1), bars, i - 1);
  const close = bars[i].close;
  const upOk = close > lv.high, dnOk = close < lv.low;
  const dirOfPanel = (k: PhaseKey): "up" | "down" => (k === "S3" ? "down" : "up");
  const toOf = (k: PhaseKey): PhaseKey => (k === "S1" ? "S2" : k === "S4" ? "S1" : phase.top === "S2" ? "S3" : "S4");
  // 후보 패널들 (S2 패널은 "추세 건강" 질문이라 전환 후보가 아님)
  const cands = (["S1", "S3", "S4"] as PhaseKey[]).filter((k) => panels[k].candidate)
    .sort((a, b) => panels[b].vote - panels[a].vote);
  const candidate = cands[0] ?? null;
  const priceOk = candidate ? (dirOfPanel(candidate) === "up" ? upOk : dnOk) : upOk || dnOk;
  const blockedByReverse = !!candidate && priceOk && dirOfPanel(candidate) === "up" && fakeBreakoutToday;
  const confirmed = !!candidate && priceOk && !blockedByReverse;
  const showDir = candidate ? dirOfPanel(candidate) : upOk ? "up" : "down";
  const transition: TransitionState = {
    candidate, confirmed,
    from: confirmed ? phase.top : null,
    to: confirmed && candidate ? toOf(candidate) : null,
    priceConfirm: `${showDir === "up" ? "상단" : "하단"} ${Math.round(showDir === "up" ? lv.high : lv.low).toLocaleString()} ${priceOk ? (showDir === "up" ? "돌파" : "이탈") : "미돌파"} (${lv.via}${candidate ? ` · ${candidate} 후보 방향` : ""})`,
    priceOk, priceUp: upOk, priceDown: dnOk,
    blockedByReverse,
    reverseLog: rev.log,
    votesAdjust: rev.votes,
  };

  // §3.1 톤 = 연속 가중합
  const T = MT_CONFIG.tone;
  const byPhase = {} as Record<PhaseKey, number>;
  let mt = 0;
  for (const k of PHASES) {
    const fill = panels[k].fillAvg ?? 0;
    const tone = T.inertia[k] + T.evidence[k] * fill;
    byPhase[k] = r3(tone) as number;
    mt += phase.P[k] * tone;
  }
  mt = Math.max(-1, Math.min(1, mt));
  const abs = Math.abs(mt);
  const tone: ToneState = {
    mt: r3(mt) as number,
    direction: mt > 0.02 ? "상승 에너지" : mt < -0.02 ? "하락 에너지" : "중립",
    strength: abs < T.strengthWeak ? "약" : abs < T.strengthStrong ? "중" : "강",
    byPhase,
  };

  const missing: string[] = [];
  for (const k of PHASES) for (const p of panels[k].parts) if (!p.available) missing.push(p.key);
  if (common.C5_flow == null) missing.push("C5");
  if (common.c4_source !== "breadth") missing.push("C4_breadth(이력 없음 — 상대강도 대체)");
  missing.push("C6_V1(VKOSPI 미조달)");

  return {
    date: bars[i].date, symbol, phase, panels, common, box, tone, transition,
    labels: null,
    meta: { engine_ver: MT_ENGINE_VER, mode: ctx.mode ?? "live", missing },
  };
}

/** 구간 전체 산출 (백필·소급) — from 인덱스부터 끝까지. 후보 유지창까지 적용된 결과를 돌려준다. */
export function computeMtSeries(symbol: MtSymbol, bars: Bar[], fromIdx: number, ctx: MtContext): MtDay[] {
  const out: MtDay[] = [];
  for (let i = fromIdx; i < bars.length; i++) out.push(computeMtDay(symbol, bars, i, ctx));
  return applyConfirmWindow(out);
}

/**
 * 후보 유지창 적용 (스펙 §1.4 해석 — 등록 상수 MT_CONFIG.vote.confirmWindow).
 * "전환 확정 = 후보 + 가격 확인"에서 둘이 **같은 날일 필요는 없다**. 최근 window일 안에 같은 패널의
 * 후보가 섰고 오늘 가격 확인이 오면 확정으로 본다. window = 0이면 동일일 전용(원 구현)과 같다.
 * 하루치만 필요한 라이브도 최근 20일을 계산해 이 함수를 통과시킨다 — 라이브·소급 동일 경로 유지.
 */
export function applyConfirmWindow(days: MtDay[], window = MT_CONFIG.vote.confirmWindow): MtDay[] {
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d.transition.confirmed || d.transition.blockedByReverse) continue;
    if (!d.transition.priceUp && !d.transition.priceDown) continue;
    const start = Math.max(0, i - window);
    for (let k = i; k >= start; k--) {
      const cand = days[k].transition.candidate;
      if (!cand) continue;
      // R1: 후보 패널이 자기 방향의 가격 확인을 받는다 — S1·S4 후보는 상단 돌파, S3 후보는 하단 이탈
      const wantUp = cand === "S1" || cand === "S4";
      const okDir = wantUp ? d.transition.priceUp : d.transition.priceDown;
      if (!okDir) continue;
      d.transition.confirmed = true;
      d.transition.from = d.phase.top;
      d.transition.to = cand === "S1" ? "S2" : cand === "S4" ? "S1" : d.phase.top === "S2" ? "S3" : "S4";
      d.transition.candidate = d.transition.candidate ?? cand;
      d.transition.priceConfirm += ` · 후보 ${days[k].date}(D-${i - k}) 유지창 내`;
      break;
    }
  }
  return days;
}

/** §4.1-1 방향 라벨 — MT 부호 vs 이후 5거래일 수익률 부호 */
export function labelDirection(bars: Bar[], i: number, mt: number): { mt_sign: number; ret5d: number | null; hit: boolean | null } {
  const h = MT_CONFIG.label.horizonDays;
  const j = i + h;
  const ret5d = j < bars.length && bars[i].close > 0 ? r2(((bars[j].close - bars[i].close) / bars[i].close) * 100) : null;
  const sign = mt > 0.02 ? 1 : mt < -0.02 ? -1 : 0;
  if (ret5d == null || sign === 0) return { mt_sign: sign, ret5d, hit: null };
  if (Math.abs(ret5d) < MT_CONFIG.label.flatBandPct) return { mt_sign: sign, ret5d, hit: null };
  return { mt_sign: sign, ret5d, hit: Math.sign(ret5d) === sign };
}
