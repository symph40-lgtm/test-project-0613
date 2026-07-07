// 추세일 판별 엔진 — 마스터 스펙 2.5 (T1~T8, DC1/DC2) + 확장 O1 시가유형·확장 가점.
// 입력은 장중 틱 시계열(K200 선물 기준). 데이터가 없는 신호(T4·T5·T8)는 available=false로
// 만점에서 제외하고, 판정은 "가용 만점 대비 비율"로 정규화한다 (plan.md 편차 1).

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

export function computeTrend(ticks: IntradayTick[], gapPct: number | null): TrendResult {
  const { pts, source } = extractSeries(ticks);
  const signals: TSignal[] = [];
  const sig = (code: string, label: string, available: boolean, pass: boolean, dir: "UP" | "DOWN" | null, detail: string) =>
    signals.push({ code, label, available, pass, dir, weight: T.weights[code] ?? 0, detail });

  const nowMin = pts.length > 0 ? pts[pts.length - 1].min : 0;
  const dayOpen = pts[0]?.px ?? null;
  const last = pts[pts.length - 1]?.px ?? null;

  if (pts.length < 5 || dayOpen === null || last === null) {
    // 데이터 부족 — 전 신호 미산출
    for (const code of ["T1", "T2", "T3", "T7"]) sig(code, code, false, false, null, "장중 데이터 부족");
    sig("T4", "외인 선물 수급", false, false, null, "KIS 미연동 — 데이터 없음");
    sig("T5", "프로그램 매매", false, false, null, "KIS 미연동 — 데이터 없음");
    sig("T8", "거래대금 확장", false, false, null, "실시간 거래대금 소스 없음");
    return {
      signals, score: 0, maxAvailable: 0, normalized: 0, grade: "비추세", dir: null, flips: 0, midday: null,
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

  // ── 5분봉 (T3 되돌림 · T6 방향 전환)
  const bars5 = resample(pts, 5);

  // T6 — 09:00~10:00 방향 전환 횟수 (5분봉 종가 이동의 부호 전환, 미세 이동 무시)
  // 완성된 봉만 집계 — 진행 중인 봉은 틱마다 부호가 바뀌어 전환 횟수가 2↔3으로 진동,
  // 횡보일↔추세일 판정이 1분 단위로 왕복하며 모순된 문자가 나갔음 (2026-07-07 실측)
  const eps = Math.abs(dayOpen) * 0.0005;
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
  const t6Violated = flips > T.t6MaxFlips;

  // T3 — 되돌림 깊이 (진행 방향 기준 극값 대비 현재 되돌림 < 40%)
  const dayHigh = Math.max(...pts.map((p) => p.px));
  const dayLow = Math.min(...pts.map((p) => p.px));
  // 시가 대비 ±0.1% 이내는 방향 미형성으로 취급
  const dayDir: "UP" | "DOWN" | null =
    last > dayOpen * 1.001 ? "UP" : last < dayOpen * 0.999 ? "DOWN" : null;
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

  // T4·T5·T8 — 데이터 소스 부재 (KIS 선물 수급·프로그램·거래대금)
  sig("T4", "외인 선물 수급", false, false, null, "KIS 미연동 — 기록·판정 제외");
  sig("T5", "프로그램 매매 방향", false, false, null, "KIS 미연동 — 기록·판정 제외");
  sig("T8", "거래대금 확장", false, false, null, "실시간 거래대금 소스 없음");

  // T7 — 갭 방향과 첫 30분 진행 방향 일치 (gap-and-go)
  const first30 = pts.filter((p) => p.min < S.openMin + 30);
  const f30Last = first30[first30.length - 1]?.px ?? null;
  if (gapPct === null || f30Last === null || first30.length < 3) {
    sig("T7", "갭-초반 방향 일치", false, false, null, "갭 또는 초반 데이터 없음");
  } else if (Math.abs(gapPct) < 0.15) {
    sig("T7", "갭-초반 방향 일치", true, false, null, `무갭(${gapPct.toFixed(2)}%) — 해당 없음`);
  } else {
    const earlyDir = f30Last > dayOpen ? 1 : f30Last < dayOpen ? -1 : 0;
    const match = earlyDir !== 0 && Math.sign(gapPct) === earlyDir;
    sig("T7", "갭-초반 방향 일치", true, match, match ? (earlyDir > 0 ? "UP" : "DOWN") : null,
      `갭 ${gapPct > 0 ? "+" : ""}${gapPct.toFixed(2)}% · 초반 ${earlyDir > 0 ? "상승" : earlyDir < 0 ? "하락" : "보합"}${match ? " (일치)" : " (역방향 → 반전일 후보)"}`);
  }

  // ── DC1/DC2 (봉 주기 = config.dc.barMin, 실시간 라벨 — 2.5.6)
  const barsDc = resample(pts, SIGNAL_CONFIG.dc.barMin).filter((b) => b.startMin >= S.openMin);
  let dc1: number | null = null, dc2: number | null = null;
  if (barsDc.length >= 3 && dayDir !== null) {
    const daySign = dayDir === "UP" ? 1 : -1;
    const same = barsDc.filter((b) => Math.sign(b.close - b.open) === daySign).length;
    dc1 = same / barsDc.length;
    const pathSum = barsDc.reduce((s, b) => s + Math.abs(b.close - b.open), 0);
    dc2 = pathSum > 0 ? Math.abs(last - dayOpen) / pathSum : null;
  }

  // ── 장중 재형성(지연) 추세 — 최근 롤링 창 기준 재평가. 추세는 장 초반에만 형성되는 게 아니라
  // 초반 왕복 후 중반부터 형성될 수 있다 (사용자 관찰). 창 내 DC1·순이동·전환 횟수로 판정.
  const MD = T.midday;
  let midday: { active: boolean; dir: "UP" | "DOWN" | null; dc1: number | null; movePct: number | null; flips: number | null } | null = null;
  {
    const winStart = nowMin - MD.windowMin;
    const winPts = pts.filter((p) => p.min >= winStart);
    const winBarsDc = barsDc.filter((b) => b.startMin >= winStart);
    if (winPts.length >= 10 && winBarsDc.length >= MD.minBars) {
      const first = winPts[0].px, lastW = winPts[winPts.length - 1].px;
      const movePct = ((lastW - first) / first) * 100;
      const winDir: "UP" | "DOWN" | null = movePct > 0.05 ? "UP" : movePct < -0.05 ? "DOWN" : null;
      let winDc1: number | null = null;
      if (winDir !== null) {
        const sgn = winDir === "UP" ? 1 : -1;
        winDc1 = winBarsDc.filter((b) => Math.sign(b.close - b.open) === sgn).length / winBarsDc.length;
      }
      // 창 내 방향 전환 (5분봉, T6과 동일 로직)
      const winBars5 = resample(winPts, 5);
      let winFlips = 0, prevSign = 0;
      for (let i = 1; i < winBars5.length; i++) {
        const mv = winBars5[i].close - winBars5[i - 1].close;
        if (Math.abs(mv) < eps) continue;
        const sg = Math.sign(mv);
        if (prevSign !== 0 && sg !== prevSign) winFlips++;
        prevSign = sg;
      }
      const active =
        winDir !== null &&
        winDc1 !== null && winDc1 >= MD.dc1Theta &&
        Math.abs(movePct) >= MD.minMovePct &&
        winFlips <= T.t6MaxFlips;
      midday = { active, dir: winDir, dc1: winDc1, movePct, flips: winFlips };
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
  // 낡은 방향으로 투표하는 문제 방지. 미형성 시 장중 재형성 방향 → 신호 가중 투표 순.
  const voteDir: "UP" | "DOWN" | null =
    dirVotes.UP === dirVotes.DOWN ? null : dirVotes.UP > dirVotes.DOWN ? "UP" : "DOWN";
  const dir: "UP" | "DOWN" | null = dayDir ?? (midday?.active ? midday.dir : null) ?? voteDir;

  // 장중 재형성 정합: 창 내 추세가 성립하고 방향이 현재 판정 방향과 일치
  const middayAligned = midday !== null && midday.active && (dir === null || midday.dir === dir);

  // DC 이중 확인 (2.5.6) — 전일 기준 충족 또는 장중 재형성 창 충족
  const dcConfirm =
    (dc1 !== null && dc2 !== null && dc1 >= SIGNAL_CONFIG.dc.dc1Theta && dc2 >= SIGNAL_CONFIG.dc.dc2Min) ||
    middayAligned;

  let grade: TrendResult["grade"];
  if (t6Violated && !middayAligned) grade = "횡보일선언";
  else if (normalized >= T.confirmRatio && dcConfirm) grade = "추세일";
  else if (normalized >= T.weakRatio || middayAligned) grade = "약한추세";
  else grade = "비추세";

  if (t6Violated && middayAligned) {
    extNotes.push(
      `초반 횡보(전환 ${flips}회) 후 장중 재형성 — 최근 ${MD.windowMin}분 DC1 ${midday!.dc1 !== null ? (midday!.dc1 * 100).toFixed(0) + "%" : "-"} · 이동 ${midday!.movePct !== null ? midday!.movePct.toFixed(1) + "%" : "-"}`,
    );
  }
  if (source === "하닉") extNotes.push("선물 시세 부족 — 하닉 시계열로 판정(참고 정확도)");

  return {
    signals, score, maxAvailable, normalized, grade, dir, flips, midday,
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
