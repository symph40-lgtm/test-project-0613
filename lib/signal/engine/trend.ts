// 추세일 판별 엔진 — 마스터 스펙 2.5 (T1~T8, DC1/DC2) + 확장 O1 시가유형·확장 가점.
// 입력은 장중 틱 시계열(K200 선물 기준). 데이터가 없는 신호는 available=false로
// 만점에서 제외하고, 판정은 "가용 만점 대비 비율"로 정규화한다 (plan.md 편차 1).
//
// 2026-07-09 사용자 개정:
//  - T4(외인 선물)·T5(프로그램) KIS 연동 — 부호가 아닌 30분 기울기(감속=상방/가속=하방)로 판정
//  - T8 재정의: 거래대금 확장 → 외인 현물+프로그램 수급 흐름 (순매도 감속=매수기회 등, 가중 2)
//  - T6 재정의: 5분봉 전환 횟수 → 스윙 고점·저점(산·골) 연결선 구조 ("변동성의 추세").
//    고점2+저점2 연결선 동방향=추세, 불일치면 3점(부족 시 4점) 연결선의 지향 방향, 그래도
//    불가하면 횡보. 판단은 13:30까지 매 틱 재평가 (개장 초반 한정 아님).

import { SIGNAL_CONFIG } from "../config";
import type { IntradayTick, TrendResult, TSignal } from "../types";

type Pt = { min: number; px: number };

const S = SIGNAL_CONFIG.session;
const T = SIGNAL_CONFIG.trend;

// 선물 가격 시계열 추출 (futPx 없으면 하닉으로 폴백 — 폴백 시 표기)
function extractSeries(ticks: IntradayTick[]): { pts: Pt[]; source: "선물" | "하닉" } {
  const fut: Pt[] = [], hyx: Pt[] = [];
  for (const t of ticks) {
    if (t.minuteOfDay < S.openMin || t.minuteOfDay > S.endMin + 15) continue;
    if (t.futPx !== null) fut.push({ min: t.minuteOfDay, px: t.futPx });
    if (t.hynixPx !== null) hyx.push({ min: t.minuteOfDay, px: t.hynixPx });
  }
  return fut.length >= Math.max(5, hyx.length * 0.3)
    ? { pts: fut, source: "선물" }
    : { pts: hyx, source: "하닉" };
}

// N분봉 리샘플 (버킷 내 마지막 값 = 종가, 첫 값 = 시가)
function resample(pts: Pt[], barMin: number): { open: number; close: number; startMin: number }[] {
  const bars = new Map<number, { open: number; close: number; startMin: number }>();
  for (const p of pts) {
    const bucket = Math.floor((p.min - S.openMin) / barMin);
    const b = bars.get(bucket);
    if (!b) bars.set(bucket, { open: p.px, close: p.px, startMin: S.openMin + bucket * barMin });
    else b.close = p.px;
  }
  return [...bars.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

// ── 수급 시계열 헬퍼 — 최근 windowMin분 누적 순매수 변화 (억원).
// setups.ts의 FG 외인 현물 게이트(2026-07-10)도 같은 눈금을 쓰므로 export.
export function flowDelta(ticks: IntradayTick[], sel: (t: IntradayTick) => number | null, windowMin = 30): {
  cur: number; delta: number; spanMin: number;
} | null {
  const pts = ticks
    .filter((t) => sel(t) !== null && isFinite(sel(t) as number) && t.minuteOfDay >= S.openMin)
    .map((t) => ({ min: t.minuteOfDay, v: sel(t) as number }));
  if (pts.length < 2) return null;
  const cur = pts[pts.length - 1];
  const past = pts.filter((p) => p.min <= cur.min - windowMin);
  const base = past.length > 0 ? past[past.length - 1] : pts[0];
  if (cur.min - base.min < 10) return null; // 최소 10분 간격 없으면 기울기 판정 유보
  return { cur: cur.v, delta: cur.v - base.v, spanMin: cur.min - base.min };
}

// ── 스윙 구조 (T6 재정의, 2026-07-09) ─────────────────────────
// 지그재그 피벗: 진행 방향 극값에서 minAmpPct 이상 반전하면 직전 극값을 산(H)/골(L)로 확정.
type SwingPivot = { min: number; px: number; kind: "H" | "L" };

function zigzagPivots(pts: Pt[], minAmpPct: number): SwingPivot[] {
  const out: SwingPivot[] = [];
  if (pts.length < 2) return out;
  const amp = (px: number) => (px * minAmpPct) / 100;
  let dir: 1 | -1 | 0 = 0;
  let hi = pts[0], lo = pts[0], ext = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (dir === 0) {
      // 방향 미확정 — 최고·최저 추적, 진폭이 열리면 반대편 극값을 첫 피벗으로
      if (p.px > hi.px) hi = p;
      if (p.px < lo.px) lo = p;
      if (p.px <= hi.px - amp(hi.px)) { out.push({ ...hi, kind: "H" }); dir = -1; ext = p; }
      else if (p.px >= lo.px + amp(lo.px)) { out.push({ ...lo, kind: "L" }); dir = 1; ext = p; }
    } else if (dir === 1) {
      if (p.px > ext.px) ext = p;
      else if (p.px <= ext.px - amp(ext.px)) { out.push({ ...ext, kind: "H" }); dir = -1; ext = p; }
    } else {
      if (p.px < ext.px) ext = p;
      else if (p.px >= ext.px + amp(ext.px)) { out.push({ ...ext, kind: "L" }); dir = 1; ext = p; }
    }
  }
  return out;
}

type SwingResult = NonNullable<TrendResult["swing"]>;

// 사용자 알고리즘: 고점 연결선·저점 연결선의 방향으로 추세 판단.
// 1) 고점 2개 + 저점 2개: 두 연결선이 같은 방향이면 그 방향의 추세.
// 2) 불일치·평탄이면: 고점 3개나 저점 3개가 생길 때까지 대기 후, 3점 연결선(첫→끝)의 지향 방향.
//    양쪽 다 3점이면 일치할 때만 채택.
// 3) 3점으로도 불가(평탄·상충)면 4점으로. 4점까지도 불가하면 횡보.
// cfg: 스윙 파라미터 오버라이드 — 미국 신호(SMH 변동성이 K200의 ~2배)용 주입점 (2026-07-13).
// 미지정이면 한국 기본값 — 기존 동작 불변.
export function computeSwingStructure(pts: Pt[], cfg?: { minAmpPct: number; tolPct: number }): SwingResult {
  const SW = cfg ?? T.swing;
  const tol = SW.tolPct / 100;
  const pivots = zigzagPivots(pts, SW.minAmpPct);
  const highs = pivots.filter((p) => p.kind === "H").map((p) => p.px);
  const lows = pivots.filter((p) => p.kind === "L").map((p) => p.px);
  const base: Omit<SwingResult, "status" | "dir" | "detail"> = { highs: highs.length, lows: lows.length };

  const dirOf = (a: number, b: number): "UP" | "DOWN" | "FLAT" =>
    b > a * (1 + tol) ? "UP" : b < a * (1 - tol) ? "DOWN" : "FLAT";
  const arrow = (d: "UP" | "DOWN" | "FLAT") => (d === "UP" ? "상승" : d === "DOWN" ? "하락" : "평탄");
  // k점 연결선의 지향 방향 (첫→끝)
  const lineDir = (vals: number[], k: number): "UP" | "DOWN" | "FLAT" | null =>
    vals.length >= k ? dirOf(vals[vals.length - k], vals[vals.length - 1]) : null;

  if (highs.length < 2 || lows.length < 2) {
    return { ...base, status: "미정", dir: null, detail: `스윙 부족 (산 ${highs.length}·골 ${lows.length}) — 구조 확정 대기` };
  }

  const h2 = dirOf(highs[highs.length - 2], highs[highs.length - 1]);
  const l2 = dirOf(lows[lows.length - 2], lows[lows.length - 1]);
  if (h2 === l2 && h2 !== "FLAT") {
    return { ...base, status: "추세", dir: h2, detail: `고점선·저점선 모두 ${arrow(h2)} (2점 일치)` };
  }
  if (h2 === "FLAT" && l2 === "FLAT") {
    return { ...base, status: "횡보", dir: null, detail: "고점선·저점선 모두 평탄 — 산·골 반복" };
  }

  // 2점 불일치 — k점 확장 판단 (3점 → 4점). 어느 방향으로 튈지 모르니 다음 산·골까지 보고,
  // k점 연결선이 지향하는 방향이 분명할 때만 추세로 반영. 한쪽 평탄·상충은 '판단 불가' →
  // 다음 단계로 (성급한 추세·횡보 선언 모두 방지).
  const prefix = `고점선 ${arrow(h2)}·저점선 ${arrow(l2)} 불일치`;
  for (const k of [3, 4]) {
    const hk = lineDir(highs, k);
    const lk = lineDir(lows, k);
    if (hk === null && lk === null) {
      return { ...base, status: "미정", dir: null, detail: `${prefix} → 다음 산·골 대기 (${k}점 판단 불가)` };
    }
    if (hk !== null && lk !== null) {
      if (hk === lk && hk !== "FLAT") return { ...base, status: "추세", dir: hk, detail: `${prefix} → ${k}점 연결선 모두 ${arrow(hk)}` };
      if (hk === "FLAT" && lk === "FLAT") return { ...base, status: "횡보", dir: null, detail: `${prefix} → ${k}점 연결선 모두 평탄 (횡보)` };
      continue; // 상충·한쪽 평탄 — 다음 단계(4점)로, 4점까지도 불가하면 루프 종료 후 횡보
    }
    // 한쪽만 k점 확보 — 그 연결선의 지향 방향이 분명하면 반영 ("고점 3개나 저점 3개로 판단")
    const single = hk ?? lk;
    if (single !== "FLAT" && single !== null) {
      return { ...base, status: "추세", dir: single, detail: `${prefix} → ${hk !== null ? "고점" : "저점"} ${k}점 연결선 ${arrow(single)}` };
    }
    // 한쪽만 있고 평탄 → 다음 단계
  }
  return { ...base, status: "횡보", dir: null, detail: `${prefix} — 4점까지도 방향 불일치 (횡보)` };
}

// opts.dc: DC 임계값 오버라이드 — 미국 신호(SMH 실측 분포가 K200과 다름)가 같은 엔진을 쓰기 위한
// 주입점 (2026-07-13). 미지정이면 한국 기본값 — 기존 동작 불변.
export function computeTrend(
  ticks: IntradayTick[],
  gapPct: number | null,
  opts?: {
    dc?: { barMin: number; dc1Theta: number; dc2Min: number };
    swing?: { minAmpPct: number; tolPct: number };
    // 가격 눈금 오버라이드 (2026-07-13 사용자 지정: "FKS200 기준 값들을 SMH에 맞게") —
    // 방향 형성 대역·무갭 컷·장중 재형성 기준은 %값이라 기초지수 변동성에 비례해야 한다.
    // 미지정이면 한국 K200 기본값 — 기존 동작 불변.
    scale?: { dayDirMinPct: number; noGapPct: number; middayMinMovePct: number; middayDirMinPct: number };
  },
): TrendResult {
  const DCC = opts?.dc ?? SIGNAL_CONFIG.dc;
  const SC = opts?.scale ?? { dayDirMinPct: 0.1, noGapPct: 0.15, middayMinMovePct: SIGNAL_CONFIG.trend.midday.minMovePct, middayDirMinPct: 0.05 };
  const { pts, source } = extractSeries(ticks);
  const signals: TSignal[] = [];
  const sig = (code: string, label: string, available: boolean, pass: boolean, dir: "UP" | "DOWN" | null, detail: string) =>
    signals.push({ code, label, available, pass, dir, weight: T.weights[code] ?? 0, detail });

  const nowMin = pts.length > 0 ? pts[pts.length - 1].min : 0;
  const dayOpen = pts[0]?.px ?? null;
  const last = pts[pts.length - 1]?.px ?? null;

  if (pts.length < 5 || dayOpen === null || last === null) {
    // 데이터 부족 — 전 신호 미산출
    for (const code of ["T1", "T2", "T3", "T6", "T7"]) sig(code, code, false, false, null, "장중 데이터 부족");
    sig("T4", "외인 선물 수급", false, false, null, "KIS 수급 데이터 대기");
    sig("T5", "프로그램 매매", false, false, null, "KIS 수급 데이터 대기");
    sig("T8", "외인 현물·프로그램 흐름", false, false, null, "KIS 수급 데이터 대기");
    return {
      signals, score: 0, maxAvailable: 0, normalized: 0, grade: "비추세", dir: null, flips: 0, swing: null, midday: null,
      dc1: null, dc2: null, openType: null, openCrossCount: null, openMaxAdverse: null,
      extBonus: 0, extNotes: [`시계열 ${pts.length}틱(${source}) — 판정 불가`],
    };
  }

  // ── Opening Range (09:00~09:30)
  const orPts = pts.filter((p) => p.min < S.openMin + T.orbMin);
  const orH = orPts.length >= 3 ? Math.max(...orPts.map((p) => p.px)) : null;
  const orL = orPts.length >= 3 ? Math.min(...orPts.map((p) => p.px)) : null;

  // T1 — 시초 레인지 이탈 유지. "첫 이탈" 고정이 아니라 "현재 레인지 밖 연속 유지 시간"으로 판정 —
  // 초반 왕복 후 장중에 이탈하는 지연 추세도 포착한다.
  if (orH === null || orL === null || nowMin < S.observeEndMin) {
    sig("T1", "시초 레인지 이탈(ORB)", false, false, null, "09:30 이후 + OR 데이터 필요");
  } else {
    const after = pts.filter((p) => p.min >= S.openMin + T.orbMin);
    let outDir: "UP" | "DOWN" | null = null; // 현재 레인지 밖 방향
    let outSince = 0;                         // 이탈 시작 분
    let everBroke = false;
    for (const p of after) {
      const side: "UP" | "DOWN" | null = p.px > orH ? "UP" : p.px < orL ? "DOWN" : null;
      if (side === null) outDir = null; // 레인지 재진입 — 유지 시간 리셋
      else {
        if (outDir !== side) { outDir = side; outSince = p.min; }
        everBroke = true;
      }
    }
    const heldMin = outDir !== null ? nowMin - outSince : 0;
    const pass = outDir !== null && heldMin >= T.t1HoldMin;
    sig("T1", "시초 레인지 이탈(ORB)", true, pass, pass ? outDir : null,
      outDir === null
        ? everBroke ? "이탈 후 재진입 — 유지 리셋" : "레인지 내부 유지"
        : `${outDir === "UP" ? "상단" : "하단"} 이탈 ${heldMin}분 유지 (기준 ${T.t1HoldMin}분)`);
  }

  // T2 — TWAP 편측성 (VWAP 근사 — 거래량 무료 소스 부재)
  if (pts.length < 15) {
    sig("T2", "TWAP 편측성(VWAP 근사)", false, false, null, "표본 부족");
  } else {
    let sum = 0, above = 0, below = 0;
    pts.forEach((p, i) => {
      sum += p.px;
      const twap = sum / (i + 1);
      if (i >= 5) (p.px >= twap ? above++ : below++); // 초기 워밍업 5틱 제외
    });
    const total = above + below;
    const ratio = total > 0 ? Math.max(above, below) / total : 0;
    const dir: "UP" | "DOWN" = above >= below ? "UP" : "DOWN";
    const pass = ratio >= T.t2SideRatio;
    sig("T2", "TWAP 편측성(VWAP 근사)", true, pass, pass ? dir : null,
      `${dir === "UP" ? "상방" : "하방"} 편측 ${(ratio * 100).toFixed(0)}% (기준 ${T.t2SideRatio * 100}%)`);
  }

  // ── 5분봉 (스윙 구조 · 참고용 전환 횟수)
  const bars5 = resample(pts, 5);
  const eps = Math.abs(dayOpen) * 0.0005;

  // (참고 표시용) 09:00~10:00 5분봉 전환 횟수 — 2026-07-09 개정으로 횡보 판정에는 미사용
  const early5 = bars5.filter((b) => b.startMin < S.openMin + 60 && b.startMin + 5 <= nowMin);
  let flips = 0;
  {
    let prevSign = 0;
    for (let i = 1; i < early5.length; i++) {
      const mv = early5[i].close - early5[i - 1].close;
      if (Math.abs(mv) < eps) continue;
      const s = Math.sign(mv);
      if (prevSign !== 0 && s !== prevSign) flips++;
      prevSign = s;
    }
  }

  // T6 — 스윙 구조 (산·골 연결선, "변동성의 추세"). 완성된 5분봉 종가만 사용 —
  // 진행 중 봉을 넣으면 피벗이 틱마다 진동한다 (2026-07-07 실측 교훈 동일 적용).
  const doneBars5 = bars5.filter((b) => b.startMin + 5 <= nowMin);
  const swing = computeSwingStructure(doneBars5.map((b) => ({ min: b.startMin, px: b.close })), opts?.swing);
  sig("T6", "스윙 구조(고점·저점 연결선)", swing.status !== "미정", swing.status === "추세",
    swing.status === "추세" ? swing.dir : null,
    `${swing.detail} [산${swing.highs}·골${swing.lows}]`);
  const rangeBySwing = swing.status === "횡보";

  // T3 — 되돌림 깊이 (진행 방향 기준 극값 대비 현재 되돌림 < 40%)
  const dayHigh = Math.max(...pts.map((p) => p.px));
  const dayLow = Math.min(...pts.map((p) => p.px));
  // 시가 대비 ±dayDirMinPct 이내는 방향 미형성으로 취급 (K200 0.1% / SMH 0.2% — 눈금 주입)
  const dayDir: "UP" | "DOWN" | null =
    last > dayOpen * (1 + SC.dayDirMinPct / 100) ? "UP" : last < dayOpen * (1 - SC.dayDirMinPct / 100) ? "DOWN" : null;
  if (dayDir === null || nowMin < S.observeEndMin) {
    sig("T3", "되돌림 깊이", false, false, null, "방향 미형성");
  } else {
    const extreme = dayDir === "UP" ? dayHigh : dayLow;
    const span = Math.abs(extreme - dayOpen);
    const pullback = span > 0 ? Math.abs(extreme - last) / span : 1;
    const pass = pullback < T.t3PullbackMax;
    sig("T3", "되돌림 깊이", true, pass, pass ? dayDir : null,
      `되돌림 ${(pullback * 100).toFixed(0)}% (기준 <${T.t3PullbackMax * 100}%)`);
  }

  // ── T4·T5·T8 — KIS 수급 (2026-07-09 연동)
  const fmtBil = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}억`;

  // T4 — 외인 선물 수급: 부호가 아닌 30분 기울기 (매수 확대/매도 감속=상방, 반대=하방. 스펙 2.5.2)
  const futFlow = flowDelta(ticks, (t) => t.futFrgn);
  if (futFlow === null) {
    sig("T4", "외인 선물 수급", false, false, null, "KIS 수급 데이터 대기");
  } else {
    const d = futFlow.delta;
    const dir: "UP" | "DOWN" | null = d >= T.t4MinDelta30 ? "UP" : d <= -T.t4MinDelta30 ? "DOWN" : null;
    sig("T4", "외인 선물 수급", true, dir !== null, dir,
      `누적 ${fmtBil(futFlow.cur)} · ${futFlow.spanMin}분간 ${fmtBil(d)} (기준 ±${T.t4MinDelta30}억)`);
  }

  // T5 — 프로그램 매매 방향: 차익+비차익 순매수 부호가 가격 방향과 일치 (스펙 2.5.2)
  const prgmFlow = flowDelta(ticks, (t) => t.kospiPrgm, 5); // 현재값만 필요 — 짧은 창
  if (prgmFlow === null) {
    sig("T5", "프로그램 매매 방향", false, false, null, "KIS 수급 데이터 대기");
  } else {
    const prgmDir: "UP" | "DOWN" | null = prgmFlow.cur > 100 ? "UP" : prgmFlow.cur < -100 ? "DOWN" : null;
    const pass = prgmDir !== null && dayDir !== null && prgmDir === dayDir;
    sig("T5", "프로그램 매매 방향", true, pass, pass ? prgmDir : null,
      `프로그램 ${fmtBil(prgmFlow.cur)} · 가격 ${dayDir ?? "미형성"}${pass ? " (일치)" : ""}`);
  }

  // T8 — 외인 현물+프로그램 흐름 (2026-07-09 재정의, 중요·가중 2): 30분 기울기.
  // 순매도라도 감속(Δ+)이면 매수기회, 순매수라도 감속(Δ-)이면 매도기회 (사용자 지정).
  const kfrgnFlow = flowDelta(ticks, (t) => t.kospiFrgn);
  const kprgmFlow = flowDelta(ticks, (t) => t.kospiPrgm);
  if (kfrgnFlow === null && kprgmFlow === null) {
    sig("T8", "외인 현물·프로그램 흐름", false, false, null, "KIS 수급 데이터 대기");
  } else {
    const judge = (f: typeof kfrgnFlow): "UP" | "DOWN" | null =>
      f === null ? null : f.delta >= T.t8MinDelta30 ? "UP" : f.delta <= -T.t8MinDelta30 ? "DOWN" : null;
    const a = judge(kfrgnFlow), b = judge(kprgmFlow);
    // 두 소스가 있으면 일치할 때만, 한쪽만 있으면 그 방향
    const dir: "UP" | "DOWN" | null = a !== null && b !== null ? (a === b ? a : null) : a ?? b;
    const parts = [
      kfrgnFlow ? `외인 ${fmtBil(kfrgnFlow.cur)}(Δ30분 ${fmtBil(kfrgnFlow.delta)})` : "외인 대기",
      kprgmFlow ? `프로그램 ${fmtBil(kprgmFlow.cur)}(Δ ${fmtBil(kprgmFlow.delta)})` : "프로그램 대기",
    ];
    sig("T8", "외인 현물·프로그램 흐름", true, dir !== null, dir,
      `${parts.join(" · ")}${dir === "UP" ? " → 매수세 개선" : dir === "DOWN" ? " → 매수세 이탈" : ""}`);
  }

  // T7 — 갭 방향과 첫 30분 진행 방향 일치 (gap-and-go)
  const first30 = pts.filter((p) => p.min < S.openMin + 30);
  const f30Last = first30[first30.length - 1]?.px ?? null;
  if (gapPct === null || f30Last === null || first30.length < 3) {
    sig("T7", "갭-초반 방향 일치", false, false, null, "갭 또는 초반 데이터 없음");
  } else if (Math.abs(gapPct) < SC.noGapPct) {
    sig("T7", "갭-초반 방향 일치", true, false, null, `무갭(${gapPct.toFixed(2)}% < ${SC.noGapPct}) — 해당 없음`);
  } else {
    const earlyDir = f30Last > dayOpen ? 1 : f30Last < dayOpen ? -1 : 0;
    const match = earlyDir !== 0 && Math.sign(gapPct) === earlyDir;
    sig("T7", "갭-초반 방향 일치", true, match, match ? (earlyDir > 0 ? "UP" : "DOWN") : null,
      `갭 ${gapPct > 0 ? "+" : ""}${gapPct.toFixed(2)}% · 초반 ${earlyDir > 0 ? "상승" : earlyDir < 0 ? "하락" : "보합"}${match ? " (일치)" : " (역방향 → 반전일 후보)"}`);
  }

  // ── DC1/DC2 (봉 주기 = DCC.barMin, 실시간 라벨 — 2.5.6)
  const barsDc = resample(pts, DCC.barMin).filter((b) => b.startMin >= S.openMin);
  let dc1: number | null = null, dc2: number | null = null;
  if (barsDc.length >= 3 && dayDir !== null) {
    const daySign = dayDir === "UP" ? 1 : -1;
    const same = barsDc.filter((b) => Math.sign(b.close - b.open) === daySign).length;
    dc1 = same / barsDc.length;
    const pathSum = barsDc.reduce((s, b) => s + Math.abs(b.close - b.open), 0);
    dc2 = pathSum > 0 ? Math.abs(last - dayOpen) / pathSum : null;
  }

  // ── 장중 재형성(지연) 추세 — 최근 롤링 창(기본 90분) 기준 재평가. 추세는 장 초반에만 형성되는 게 아니라
  // 초반 왕복 후 중반부터 형성될 수 있다 (사용자 관찰). 창 내 DC1·순이동으로 판정.
  // (2026-07-09: 창 내 전환 횟수 조건 제거 — 전환 횟수 기반 판정은 사용자 개정으로 폐기)
  const MD = T.midday;
  let midday: { active: boolean; dir: "UP" | "DOWN" | null; dc1: number | null; movePct: number | null; flips: number | null } | null = null;
  {
    const winStart = nowMin - MD.windowMin;
    const winPts = pts.filter((p) => p.min >= winStart);
    const winBarsDc = barsDc.filter((b) => b.startMin >= winStart);
    if (winPts.length >= 10 && winBarsDc.length >= MD.minBars) {
      const first = winPts[0].px, lastW = winPts[winPts.length - 1].px;
      const movePct = ((lastW - first) / first) * 100;
      const winDir: "UP" | "DOWN" | null = movePct > SC.middayDirMinPct ? "UP" : movePct < -SC.middayDirMinPct ? "DOWN" : null;
      let winDc1: number | null = null;
      if (winDir !== null) {
        const sgn = winDir === "UP" ? 1 : -1;
        winDc1 = winBarsDc.filter((b) => Math.sign(b.close - b.open) === sgn).length / winBarsDc.length;
      }
      const active =
        winDir !== null &&
        winDc1 !== null && winDc1 >= MD.dc1Theta &&
        Math.abs(movePct) >= SC.middayMinMovePct;
      midday = { active, dir: winDir, dc1: winDc1, movePct, flips: null };
    }
  }

  // ── O1 시가 유형 (확장기획서 2장 — 기록 전용, enabled 시 가점)
  const o1 = computeOpenType(pts);

  // ── 스코어 합산 (가용 신호만)
  let score = 0, maxAvailable = 0;
  const dirVotes: Record<"UP" | "DOWN", number> = { UP: 0, DOWN: 0 };
  for (const s of signals) {
    if (!s.available) continue;
    maxAvailable += s.weight;
    if (s.pass) {
      score += s.weight;
      if (s.dir) dirVotes[s.dir] += s.weight;
    }
  }

  // ── 확장 가점 (기본 OFF — enabled인 모듈만, 합산 캡 30%)
  let extBonus = 0;
  const extNotes: string[] = [];
  if (SIGNAL_CONFIG.ext.o1.enabled && o1.openType === "drive") { extBonus += 3; extNotes.push("O1 open_drive +3"); }
  else if (SIGNAL_CONFIG.ext.o1.enabled && o1.openType === "test_drive") { extBonus += 2; extNotes.push("O1 open_test_drive +2"); }
  const extCap = maxAvailable * SIGNAL_CONFIG.ext.bonusCapRatio;
  if (extBonus > extCap) { extBonus = extCap; extNotes.push(`가점 캡 적용(≤${extCap.toFixed(1)})`); }
  score += extBonus;

  const normalized = maxAvailable > 0 ? score / maxAvailable : 0;
  // 방향: 당일 진행 방향(시가 대비)이 형성됐으면 그것을 우선 — 반전일(7/3형)에서 초반 신호(T7)가
  // 낡은 방향으로 투표하는 문제 방지. 미형성 시 장중 재형성 → 스윙 구조 → 신호 가중 투표 순.
  const voteDir: "UP" | "DOWN" | null =
    dirVotes.UP === dirVotes.DOWN ? null : dirVotes.UP > dirVotes.DOWN ? "UP" : "DOWN";
  const dir: "UP" | "DOWN" | null =
    dayDir ?? (midday?.active ? midday.dir : null) ?? (swing.status === "추세" ? swing.dir : null) ?? voteDir;

  // 장중 재형성 정합: 창 내 추세가 성립하고 방향이 현재 판정 방향과 일치
  const middayAligned = midday !== null && midday.active && (dir === null || midday.dir === dir);

  // DC 이중 확인 (2.5.6) — 전일 기준 충족 또는 장중 재형성 창 충족
  const dcConfirm =
    (dc1 !== null && dc2 !== null && dc1 >= DCC.dc1Theta && dc2 >= DCC.dc2Min) ||
    middayAligned;

  // 횡보일 선언 = 스윙 구조가 '횡보' (산·골 연결선 4점까지 불일치/평탄) AND 장중 재형성 없음.
  // '미정'(스윙 부족·다음 산골 대기)은 횡보가 아니다 — 성급한 횡보일 선언 방지 (2026-07-09 사용자 개정).
  let grade: TrendResult["grade"];
  if (rangeBySwing && !middayAligned) grade = "횡보일선언";
  else if (normalized >= T.confirmRatio && dcConfirm) grade = "추세일";
  else if (normalized >= T.weakRatio || middayAligned) grade = "약한추세";
  else grade = "비추세";

  if (rangeBySwing && middayAligned) {
    extNotes.push(
      `스윙 횡보 구조였으나 장중 재형성 — 최근 ${MD.windowMin}분 DC1 ${midday!.dc1 !== null ? (midday!.dc1 * 100).toFixed(0) + "%" : "-"} · 이동 ${midday!.movePct !== null ? midday!.movePct.toFixed(1) + "%" : "-"}`,
    );
  }
  if (source === "하닉") extNotes.push("선물 시세 부족 — 하닉 시계열로 판정(참고 정확도)");

  return {
    signals, score, maxAvailable, normalized, grade, dir, flips, swing, midday,
    dc1, dc2,
    openType: o1.openType, openCrossCount: o1.crossCount, openMaxAdverse: o1.maxAdverse,
    extBonus, extNotes,
  };
}

// O1 — 시가 유형 분류 (09:00~09:30, 확장기획서 2.2 의사코드)
function computeOpenType(pts: Pt[]): {
  openType: "drive" | "test_drive" | "auction" | "undetermined" | null;
  crossCount: number | null;
  maxAdverse: number | null;
} {
  // 09:05~09:30 (초반 호가 불안정 5분 제외 옵션 적용)
  const win = pts.filter((p) => p.min >= S.openMin + 5 && p.min < S.openMin + SIGNAL_CONFIG.ext.o1.windowMin);
  const openPx = pts.find((p) => p.min <= S.openMin + 5)?.px ?? pts[0]?.px;
  if (!openPx || win.length < 8) return { openType: win.length > 0 ? "undetermined" : null, crossCount: null, maxAdverse: null };

  let cross = 0;
  let prevSide = 0;
  let maxAdverseUp = 0, maxAdverseDown = 0;
  for (const p of win) {
    const side = p.px > openPx ? 1 : p.px < openPx ? -1 : prevSide;
    if (prevSide !== 0 && side !== 0 && side !== prevSide) cross++;
    if (side !== 0) prevSide = side;
    maxAdverseUp = Math.max(maxAdverseUp, (openPx - p.px) / openPx);   // 최종 상방일 때의 역행
    maxAdverseDown = Math.max(maxAdverseDown, (p.px - openPx) / openPx);
  }
  const finalPx = win[win.length - 1].px;
  const finalDir = Math.sign(finalPx - openPx);
  const move = Math.abs(finalPx - openPx) / openPx;
  const maxAdverse = finalDir >= 0 ? maxAdverseUp : maxAdverseDown;
  const { driveMin, testMax, crossLimit } = SIGNAL_CONFIG.ext.o1;

  let openType: "drive" | "test_drive" | "auction" | "undetermined";
  if (cross === 0 && move >= driveMin) openType = "drive";
  else if (cross <= 2 && maxAdverse <= testMax) openType = "test_drive";
  else if (cross >= crossLimit) openType = "auction";
  else openType = "undetermined";

  return { openType, crossCount: cross, maxAdverse };
}
