// RV1 — 하닉 분봉 모멘텀 판정 (사용자 지정 2026-07-07, 임계값: config.reversal)
//
// 추세·반전 여부와 무관하게 아래 중 하나가 성립하면 그 방향으로 판정한다 (사용자 확정 3차 —
// "계속 변동하는 상황에서 추세를 조건으로 하는 것은 오히려 제약"):
//  1) 1분봉 1개 ≥ 0.8%  2) 1분봉 3개 합 ≥ 1.0%  3) 1분봉 5개 합 ≥ 1.5%
//  4) 5분봉 1개 ≥ 1.0%  5) 5분봉 3개 합 ≥ 2.2%  6) 5개 합 ≥ 2.7%  7) 7개 합 ≥ 3.2%
// 상승 = 레버리지 검토 / 하락 = 인버스 검토 (즉시 문자 — alerts.ts).
// 양방향이 동시에 성립하면 |변동|이 큰 쪽 하나만 판정한다.
//
// 수치는 전일 종가 대비 등락률(hynixChg)의 차(%p)로 계산 — 등락률 차 ≈ 가격 변화율.
// 5분봉은 완성된 봉만 사용 (진행 중 봉은 틱마다 값이 바뀌어 판정이 진동 — T6과 동일 원칙).
// 1분봉 조건은 최신 틱 그대로 사용해 즉시성을 확보한다.

import { SIGNAL_CONFIG } from "../config";
import type { IntradayTick } from "../types";

export type ReversalHit = {
  dir: "UP" | "DOWN";         // 방향 (UP=상승 → 레버리지)
  cond: string;               // 성립 조건 표기 (예: "5분봉3개 -2.3%p")
  movePct: number;            // 변동 크기 (%p, 부호 = 방향)
  preMovePct: number | null;  // 직전 흐름 (%p) — 표기용, 데이터 부족 시 null
  // 신호 창 극값 대비 현재 되돌림 (%p) — UP이면 윗꼬리, DOWN이면 아랫꼬리.
  // 되돌림이 크면 그 모멘텀은 이미 반대 세력에 흡수된 것 (윗꼬리 필터, 2026-07-13)
  retracePp?: number | null;
};

type Pt = { min: number; chg: number };

// 창 시작 시점 기준 직전 추세 — lookback분 전(없으면 세션 첫 값) 대비 순변화
function preTrend(series: Pt[], startIdx: number, lookbackMin: number): number | null {
  const startMin = series[startIdx].min;
  let prevIdx = 0;
  for (let i = startIdx - 1; i >= 0; i--) {
    if (series[i].min <= startMin - lookbackMin) { prevIdx = i; break; }
  }
  if (prevIdx === startIdx) return null;
  return series[startIdx].chg - series[prevIdx].chg;
}

export function detectReversal(ticks: IntradayTick[]): ReversalHit | null {
  const R = SIGNAL_CONFIG.reversal;
  const S = SIGNAL_CONFIG.session;
  const pts: Pt[] = ticks
    .filter((t) => t.hynixChg !== null && isFinite(t.hynixChg) && t.minuteOfDay >= S.openMin)
    .map((t) => ({ min: t.minuteOfDay, chg: t.hynixChg as number }));
  if (pts.length < 4) return null;
  // 같은 분 중복 틱은 마지막 값만 (1분봉 종가)
  const m1: Pt[] = [];
  for (const p of pts) {
    if (m1.length > 0 && m1[m1.length - 1].min === p.min) m1[m1.length - 1] = p;
    else m1.push(p);
  }

  // 5분봉 종가 — 완성된 버킷만 (버킷 [5b, 5b+5)의 마지막 틱, 종료가 현재 분 이하)
  const nowMin = m1[m1.length - 1].min;
  const byBucket = new Map<number, Pt>();
  for (const p of m1) byBucket.set(Math.floor(p.min / 5), p);
  const m5: Pt[] = [...byBucket.entries()]
    .filter(([b]) => (b + 1) * 5 <= nowMin)
    .sort(([a], [b]) => a - b)
    .map(([, p]) => p);

  const conds: { series: Pt[]; w: number; th: number; label: string }[] = [
    { series: m1, w: 1, th: R.m1Single, label: "1분봉" },
    { series: m1, w: 3, th: R.m1Sum3, label: "1분봉3개" },
    { series: m1, w: 5, th: R.m1Sum5, label: "1분봉5개" },
    { series: m5, w: 1, th: R.m5Single, label: "5분봉" },
    { series: m5, w: 3, th: R.m5Sum3, label: "5분봉3개" },
    { series: m5, w: 5, th: R.m5Sum5, label: "5분봉5개" },
    { series: m5, w: 7, th: R.m5Sum7, label: "5분봉7개" },
  ];

  let best: ReversalHit | null = null;
  let bestStartMin: number | null = null;
  for (const c of conds) {
    const n = c.series.length;
    if (n < c.w + 1) continue;
    const move = c.series[n - 1].chg - c.series[n - 1 - c.w].chg;
    if (Math.abs(move) < c.th) continue;
    // 직전 흐름은 문자 표기용으로만 계산 — 판정 조건 아님 (추세·반전 전제 없음, 사용자 확정)
    const pre = preTrend(c.series, n - 1 - c.w, R.trendLookbackMin);
    if (best === null || Math.abs(move) > Math.abs(best.movePct)) {
      best = {
        dir: move > 0 ? "UP" : "DOWN",
        cond: `${c.label} ${move > 0 ? "+" : ""}${move.toFixed(1)}%p`,
        movePct: Number(move.toFixed(2)),
        preMovePct: pre !== null ? Number(pre.toFixed(2)) : null,
      };
      bestStartMin = c.series[n - 1 - c.w].min;
    }
  }
  // 신호 창 극값 대비 현재 되돌림 (윗꼬리/아랫꼬리) — 1분 시계열 기준. 필터 판정은 alerts.ts
  if (best !== null && bestStartMin !== null) {
    const winPts = m1.filter((p) => p.min >= bestStartMin);
    const cur = m1[m1.length - 1].chg;
    if (winPts.length > 0) {
      const ext = best.dir === "UP" ? Math.max(...winPts.map((p) => p.chg)) : Math.min(...winPts.map((p) => p.chg));
      best.retracePp = Number(Math.abs(ext - cur).toFixed(2));
    }
  }
  return best;
}
