// MT-OPT — 자기교정 3계층 (스펙 SPEC_MT_v04.md §4, G1-OPT 이식).
//   상태 계층   : 일일 채점 라벨 3종 (service.runLabels) + C1 등급별 오분류율 (여기)
//   파라미터 계층: 월간 IC 기반 부품 가중 재배분 — 1회 ≤30% · |IC|<0.05 강등 · 15일 섀도 병행 후 교체
//   헌법 계층   : 부품 수 동결·게이트 배율 상한·단독 베팅 금지 (코드가 아니라 스펙이 지킨다)
// 이 모듈은 **제안만** 한다. 활성 가중 교체는 섀도 15일을 채운 뒤에만 일어난다.

import { c1ForDay } from "./c1";
import type { C1Context } from "./c1";
import { MT_CONFIG } from "./config";
import { spearman } from "./indicators";
import type { Bar, MtDay, PhaseKey } from "./types";

const PHASES: PhaseKey[] = ["S1", "S2", "S3", "S4"];

/**
 * C1 등급별 오분류율 (§3.1 "오분류율 매일 기록").
 * 정의: 하위 등급의 재료 **방향**이 같은 날 상위 등급(A > B > C)의 방향과 다른 비율.
 * 상위 등급이 없는 날은 채점 대상이 아니다 — "표본 없음"으로 남기고 추정하지 않는다.
 */
export function c1MisclassRate(bars: Bar[], from: number, symbol: string, ctx: C1Context): {
  B_vs_A: { n: number; wrong: number; rate: number | null };
  C_vs_A: { n: number; wrong: number; rate: number | null };
  C_vs_B: { n: number; wrong: number; rate: number | null };
} {
  const acc = { B_vs_A: { n: 0, wrong: 0 }, C_vs_A: { n: 0, wrong: 0 }, C_vs_B: { n: 0, wrong: 0 } };
  for (let i = Math.max(1, from); i < bars.length; i++) {
    const a = c1ForDay(bars, i, symbol, { ...ctx, allowGrades: ["A"] });
    const b = c1ForDay(bars, i, symbol, { ...ctx, allowGrades: ["B"] });
    const c = c1ForDay(bars, i, symbol, { ...ctx, allowGrades: ["C"] });
    const cmp = (lo: typeof a, hi: typeof a, key: keyof typeof acc) => {
      if (!lo.grade || !hi.grade || lo.materialDir === 0 || hi.materialDir === 0) return;
      acc[key].n++;
      if (lo.materialDir !== hi.materialDir) acc[key].wrong++;
    };
    cmp(b, a, "B_vs_A"); cmp(c, a, "C_vs_A"); cmp(c, b, "C_vs_B");
  }
  const fin = (x: { n: number; wrong: number }) => ({ ...x, rate: x.n ? Math.round((x.wrong / x.n) * 1000) / 1000 : null });
  return { B_vs_A: fin(acc.B_vs_A), C_vs_A: fin(acc.C_vs_A), C_vs_B: fin(acc.C_vs_B) };
}

/** 부품별 IC — fill(단독) vs 라벨(5일 수익률)의 순위상관 */
export function partIC(days: MtDay[]): Record<string, { ic: number | null; n: number }> {
  const bucket: Record<string, { xs: number[]; ys: number[] }> = {};
  for (const d of days) {
    const y = d.labels?.dir5d?.ret5d;
    if (y == null) continue;
    for (const k of PHASES) {
      for (const p of d.panels[k].parts) {
        if (p.fill == null) continue;
        bucket[p.key] ??= { xs: [], ys: [] };
        bucket[p.key].xs.push(p.fill);
        // S3 패널은 하락 증거 — 부호를 뒤집어 "증거가 맞았는가"로 통일한다
        bucket[p.key].ys.push(k === "S3" ? -y : y);
      }
    }
  }
  const out: Record<string, { ic: number | null; n: number }> = {};
  for (const [k, v] of Object.entries(bucket)) out[k] = { ic: spearman(v.xs, v.ys), n: v.xs.length };
  return out;
}

/** 패널 내 부품 쌍 상관 — >0.7 지속 시 이중계상 경보 (발주자 보충 §1.4-3) */
export function pairCorrelations(days: MtDay[]): { panel: PhaseKey; a: string; b: string; corr: number }[] {
  const out: { panel: PhaseKey; a: string; b: string; corr: number }[] = [];
  for (const k of PHASES) {
    const keys = days[0]?.panels[k].parts.map((p) => p.key) ?? [];
    for (let x = 0; x < keys.length; x++) {
      for (let y = x + 1; y < keys.length; y++) {
        const xs: number[] = [], ys: number[] = [];
        for (const d of days) {
          const px = d.panels[k].parts.find((p) => p.key === keys[x])?.fill;
          const py = d.panels[k].parts.find((p) => p.key === keys[y])?.fill;
          if (px == null || py == null) continue;
          xs.push(px); ys.push(py);
        }
        const c = spearman(xs, ys);
        if (c != null && Math.abs(c) > MT_CONFIG.recal.pairCorrAlert) out.push({ panel: k, a: keys[x], b: keys[y], corr: Math.round(c * 1000) / 1000 });
      }
    }
  }
  return out;
}

/**
 * 월간 재캘리브레이션 제안 — IC → 가중. 제약(§4.2):
 *   · 1회 변경폭 ≤ 30%  · |IC| < 0.05 부품은 가중 0 강등(기록은 지속)  · 15일 섀도 병행 후 교체
 * 반환은 **제안(shadow)** 이다. 활성 가중은 promoteWeights가 섀도 15일을 확인한 뒤에만 바꾼다.
 */
export function proposeWeights(current: Record<string, number>, ic: Record<string, { ic: number | null; n: number }>): {
  proposed: Record<string, number>; demoted: string[]; notes: string[];
} {
  const R = MT_CONFIG.recal;
  const proposed: Record<string, number> = {};
  const demoted: string[] = [];
  const notes: string[] = [];
  const keys = Object.keys(ic);
  const absIC = keys.map((k) => Math.abs(ic[k].ic ?? 0));
  const meanAbs = absIC.length ? absIC.reduce((a, b) => a + b, 0) / absIC.length : 0;
  for (const k of keys) {
    const cur = current[k] ?? 1;
    const v = ic[k].ic;
    if (v == null || Math.abs(v) < R.icFloor) {
      proposed[k] = 0; demoted.push(k);
      notes.push(`${k}: |IC| ${v == null ? "산출 불가" : Math.abs(v).toFixed(3)} < ${R.icFloor} → 가중 0 강등 (기록은 지속)`);
      continue;
    }
    const target = meanAbs > 0 ? (Math.abs(v) / meanAbs) * 1 : cur;   // 평균 IC 대비 상대 가중
    const lo = cur * (1 - R.maxChangeRatio), hi = cur * (1 + R.maxChangeRatio);
    proposed[k] = Math.round(Math.min(hi, Math.max(lo, target)) * 1000) / 1000;
    if (proposed[k] !== target) notes.push(`${k}: 목표 ${target.toFixed(3)} → 변경폭 ${R.maxChangeRatio * 100}% 제한으로 ${proposed[k]}`);
  }
  return { proposed, demoted, notes };
}

export type MtOptState = {
  weights: Record<string, number>;          // 활성 가중 (기본 전부 1)
  shadow?: { weights: Record<string, number>; since: string; days: number } | null;
  ic_history?: { month: string; ic: Record<string, { ic: number | null; n: number }> }[];
  pair_corr?: { month: string; alerts: { panel: string; a: string; b: string; corr: number }[] }[];
  c1_misclass?: { month: string; rates: ReturnType<typeof c1MisclassRate> };
  updated_for?: string;                     // YYYY-MM
};

/** 섀도 15일을 채웠으면 활성 가중을 교체 (§4.2) */
export function promoteWeights(state: MtOptState, today: string): { state: MtOptState; promoted: boolean; note: string } {
  const sh = state.shadow;
  if (!sh) return { state, promoted: false, note: "섀도 없음" };
  const days = Math.round((Date.parse(today) - Date.parse(sh.since)) / 86400e3);
  if (days < MT_CONFIG.recal.shadowDays) {
    return { state: { ...state, shadow: { ...sh, days } }, promoted: false, note: `섀도 ${days}/${MT_CONFIG.recal.shadowDays}일 병행 중` };
  }
  return {
    state: { ...state, weights: sh.weights, shadow: null },
    promoted: true,
    note: `섀도 ${days}일 완료 — 활성 가중 교체`,
  };
}
