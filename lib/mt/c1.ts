// C1 반응비대칭 — MT의 핵심 측정 (스펙 SPEC_MT_v04.md §2, 발주자 승인 2026-08-15 3단 등급).
//   반응배율 = 실반응 ÷ 정당화 반응
//   등급 A 컨센서스 수동 입력 / B cause_text 어휘 판별 / C 전일밤 ^SOX (전 구간 소급 가능)
// 등급은 항상 병기하고 등급별 오분류율을 따로 채점한다 — 등급 C의 신뢰도를 스스로 측정하기 위함.

import { MT_CONFIG } from "./config";
import { clamp, median, regressBeta, ret } from "./indicators";
import type { Bar, C1Day, C1Grade } from "./types";

export type C1Context = {
  /** KRX 일자 → 전일밤 해외 재료 수익률 % (^SOX) */
  soxByDate: Map<string, number>;
  /** 등급 A: KRX 일자 → { dir: -1|1, surprisePct } (컨센서스 수동 입력 — 현재 표본 0) */
  consensusByDate?: Map<string, { dir: -1 | 1; surprisePct: number }>;
  /** 등급 B: KRX 일자 → cause_text */
  causeTextByDate?: Map<string, string>;
  /**
   * 허용 등급 (기본 A·B·C 전부). 발주자 보충 조건 ①②의 "두 벌 보고"·"A-C 일치율" 실측 장치:
   *   ["A","B"] → C 프록시 없이 산출 (관문 판정용 A+B 벌)
   *   ["C"]     → C 프록시만 산출 (A·B 존재일과 나란히 놓아 일치율을 잰다)
   */
  allowGrades?: C1Grade[];
};

/** B등급 재료 방향 — 규칙 기반 어휘 판별 (사전은 config 등록 상수). 판별 불가 시 0 */
export function lexiconDir(text: string | undefined | null): -1 | 0 | 1 {
  if (!text) return 0;
  let g = 0, b = 0;
  for (const w of MT_CONFIG.lexicon.good) if (text.includes(w)) g++;
  for (const w of MT_CONFIG.lexicon.bad) if (text.includes(w)) b++;
  return g > b ? 1 : b > g ? -1 : 0;
}

/** β_SOX — 60일 롤링 회귀(대상 일간수익률 ~ 전일밤 SOX). 표본 부족 시 pack 폴백 */
export function betaSox(bars: Bar[], i: number, symbol: string, soxByDate: Map<string, number>): number {
  const cfg = MT_CONFIG.c1;
  const xs: number[] = [], ys: number[] = [];
  for (let k = Math.max(1, i - cfg.betaWindow + 1); k <= i; k++) {
    const s = soxByDate.get(bars[k].date);
    const r = ret(bars, k);
    if (s == null || r == null) continue;
    xs.push(s); ys.push(r);
  }
  const fallback = cfg.betaFallback[symbol] ?? 1.0;
  if (xs.length < cfg.betaMinN) return fallback;
  const b = regressBeta(xs, ys);
  return b == null ? fallback : clamp(b, cfg.betaFloor, cfg.betaCap);
}

/** 하루치 C1 — 등급 결정 → 정당화 반응 → 반응배율 */
export function c1ForDay(bars: Bar[], i: number, symbol: string, ctx: C1Context, beta?: number): C1Day {
  const cfg = MT_CONFIG.c1;
  const date = bars[i].date;
  const actual = ret(bars, i);
  const b = beta ?? betaSox(bars, i, symbol, ctx.soxByDate);
  const sox = ctx.soxByDate.get(date) ?? null;
  const base: C1Day = {
    date, grade: null, materialDir: 0, justified: null, actual, ratio: null, raw: null, clipped: false, excluded: true, note: "재료 없음",
  };

  const con = ctx.consensusByDate?.get(date);
  const allow = ctx.allowGrades ?? ["A", "B", "C"];
  const wantA = allow.includes("A"), wantB = allow.includes("B"), wantC = allow.includes("C");

  // 등급 A — 컨센서스 서프라이즈 (입력일만)
  if (con && wantA) {
    const justified = con.dir * Math.abs(con.surprisePct) * cfg.surpriseSens;
    return finish(base, "A", justified, actual, b, "컨센서스 서프라이즈");
  }
  // 등급 B — cause_text 어휘로 재료 방향 확정, 크기는 해외 재료 β 환산
  if (wantB && ctx.causeTextByDate?.has(date) && sox != null) {
    const dir = lexiconDir(ctx.causeTextByDate.get(date));
    if (dir !== 0) return finish(base, "B", dir * Math.abs(b * sox), actual, b, `cause_text 어휘 ${dir > 0 ? "호재" : "악재"}`);
  }
  // 등급 C — 전일밤 SOX 부호·크기 (전 구간 소급 가능)
  if (wantC && sox != null) return finish(base, "C", b * sox, actual, b, `전일밤 SOX ${sox.toFixed(2)}% × β ${b.toFixed(2)}`);
  return base;
}

function finish(base: C1Day, grade: C1Grade, justified: number, actual: number | null, beta: number, note: string): C1Day {
  const cfg = MT_CONFIG.c1;
  const excluded = Math.abs(justified) < cfg.minJustifiedAbs;
  const raw = excluded || actual == null ? null : actual / justified;
  const ratio = raw == null ? null : clamp(raw, -cfg.ratioClip, cfg.ratioClip);
  const clipped = raw != null && Math.abs(raw) > cfg.ratioClip;
  return {
    ...base, grade,
    materialDir: justified > 0 ? 1 : justified < 0 ? -1 : 0,
    justified: Math.round(justified * 100) / 100,
    actual,
    ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
    raw: raw == null ? null : Math.round(raw * 100) / 100,   // 윈저화 전 원값 (발주자 8/20 밤 §3ⓐ)
    clipped,
    excluded,
    note: excluded
      ? `${note} — 재료 미달(|정당화| < ${cfg.minJustifiedAbs}%)`
      : `${note} · β ${beta.toFixed(2)}${clipped ? ` (배율 ±${cfg.ratioClip} 윈저화, 원값 ${raw!.toFixed(1)})` : ""}`,
  };
}

/** 창 [i-n+1, i]의 C1 시계열 (패널이 호출) */
export function c1Series(bars: Bar[], i: number, n: number, symbol: string, ctx: C1Context): C1Day[] {
  const beta = betaSox(bars, i, symbol, ctx.soxByDate);
  const out: C1Day[] = [];
  for (let k = Math.max(1, i - n + 1); k <= i; k++) out.push(c1ForDay(bars, k, symbol, ctx, beta));
  return out;
}

/** 방향별 반응배율 중앙값 — 호재일(+1)/악재일(−1) */
export function ratioMedian(series: C1Day[], dir: -1 | 1): number | null {
  return median(series.filter((d) => !d.excluded && d.materialDir === dir && d.ratio != null).map((d) => d.ratio as number));
}

/** 등급 구성비 (모든 소급 채점표 병기 — 발주자 보충 조건 ③) */
export function gradeMix(series: C1Day[]): { A: number; B: number; C: number; none: number; n: number } {
  const n = series.length || 1;
  const cnt = (g: C1Grade) => series.filter((d) => d.grade === g).length;
  const pct = (x: number) => Math.round((x / n) * 1000) / 10;
  return { A: pct(cnt("A")), B: pct(cnt("B")), C: pct(cnt("C")), none: pct(cnt(null)), n: series.length };
}
