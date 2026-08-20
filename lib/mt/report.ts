// MT 표시 문구 — 스펙 SPEC_MT_v04.md §3.2. lib/g1/copy.ts와 같은 규약:
//   · 미래 예측 서술 금지 ("오를 것") — 현재 상태·증거 충족도만
//   · 국면은 항상 확률 표기 (단정 금지)
//   · 부품은 충족도 수치를 항상 병기 (발주자 보충 §1.4-1a)

import { MT_CONFIG, MT_NAME, PHASE_NAMES } from "./config";
import type { MtDay, PhaseKey } from "./types";

const won = (v: number) => Math.round(v).toLocaleString();
const sgn = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

/** "S1 바닥권 70%·S2 25%" — 상위 2개까지, 단정 금지 */
export function phaseLine(day: MtDay): string {
  const ps = (Object.entries(day.phase.P) as [PhaseKey, number][]).sort((a, b) => b[1] - a[1]);
  return ps.slice(0, 2).map(([k, v]) => `${k} ${PHASE_NAMES[k]} ${Math.round(v * 100)}%`).join("·");
}

/**
 * 전환 상태 서술 — "→ S2 시도 중" / "→ S2 확정" / ""
 * ⚠ 동결 (2026-08-16 발주자 판정 4): 전환 선언 트랙은 3년 표본 동결 — 재채점 1회 미달(오탐률 86%).
 *   화면 노출은 내린다 (빈 문자열). 로그(mt_days.transition)에는 계속 기록되며 라이브 전진 검증 재료가 된다.
 */
export const TRANSITION_FROZEN = true;
export function transitionPhrase(day: MtDay): string {
  if (TRANSITION_FROZEN) return "";
  const t = day.transition;
  if (t.confirmed && t.to) return ` → ${t.to} ${PHASE_NAMES[t.to]} 전환 확정 (가격 확인 완료)`;
  if (t.candidate) {
    const to = t.candidate === "S1" ? "S2" : t.candidate === "S3" ? "S3·S4" : t.candidate === "S4" ? "S1" : t.candidate;
    return ` → ${to} 시도 중 (패널 ${day.panels[t.candidate].vote}/${day.panels[t.candidate].threshold ?? "—"}표, 가격 확인 대기)`;
  }
  return "";
}

/** 패널 부품 — 충족도 병기 (✓ = fill ≥ 0.6) */
export function panelChips(day: MtDay, key?: PhaseKey): string {
  const k = key ?? day.transition.candidate ?? day.phase.top;
  const p = day.panels[k];
  if (!p) return "—";
  const unstable = MT_CONFIG.approved.unstableParts as readonly string[];
  return p.parts.map((x) =>
    (x.available ? `${x.name} ${x.fill!.toFixed(2)} ${(x.fill ?? 0) >= MT_CONFIG.vote.fillThreshold ? "✓" : "✗"}` : `${x.name} —(결측)`)
    + (unstable.includes(x.key) ? "(안정성 미검증)" : "")
  ).join(" · ");
}

export function toneLine(day: MtDay): string {
  return `톤 ${sgn(day.tone.mt)} ${day.tone.direction}·${day.tone.strength}`;
}

export function boxLine(day: MtDay): string {
  const b = day.box.primary === 20 ? day.box.n20 : day.box.primary === 60 ? day.box.n60 : null;
  if (!b) return `박스 없음 (추세 구간 — 20일 폭 ${day.box.n20.widthPct}%)`;
  return `박스 ${won(b.low)}~${won(b.high)} (${day.box.primary}일, 위치 ${day.box.positionPct ?? "—"}%)`;
}

/** 보조 플래그 — 발생 시에만 (스펙 §3.2) */
export function flags(day: MtDay): string[] {
  const out: string[] = [];
  const s1 = day.panels.S1.parts;
  const noBad = s1.find((p) => p.key === "S1_1");
  if ((noBad?.fill ?? 0) >= MT_CONFIG.vote.fillThreshold) out.push("악재 무반응 감지");
  const ftd = s1.find((p) => p.key === "S1_3");
  if ((ftd?.fill ?? 0) >= 1) out.push("확인일 발생");
  // 역신호 플래그(가짜돌파·Spring·가짜확인일)는 전환 선언 트랙 소속 — 동결 중 화면 노출 없음 (로그에는 남는다)
  if (!TRANSITION_FROZEN) for (const e of day.transition.reverseLog) if (e.date === day.date) out.push(`${e.kind} — ${e.detail}`);
  return out;
}

/** 카드 상시 줄 (T2·R1) — 3줄 구조 */
export function mtCardLines(day: MtDay): { head: string; panel: string; tail: string; flags: string[] } {
  const c1 = day.common.C1;
  // [발주자 8/20 밤 §3ⓑ·ⓒ] 표기 규격: "악재 과반응 5.0배 (하락 에너지)" —
  //   재료(호재/악재) + 반응어(배율 부호·크기: 같은 방향 |r|>1 과반응 / |r|≤1 과소반응 / 반대 방향 역반응) + 실반응 에너지 방향.
  //   등급 항상 병기(스펙 원칙) · 등급 C 날 확정 규격 = "등급 C 프록시·투표 제외" · 윈저화 밤은 원값 병기(§3ⓐ).
  const c1txt = (() => {
    if (!c1.grade) return "C1 재료 없음";
    const gradeTxt = `등급 ${c1.grade}${c1.grade === "C" ? " 프록시·투표 제외" : ""}`;
    if (c1.excluded || c1.ratio == null) return `C1 재료 미달 (${gradeTxt})`;
    const r = c1.ratio;
    const mat = c1.materialDir > 0 ? "호재" : "악재";
    const react = r >= 0 ? (Math.abs(r) > 1 ? "과반응" : "과소반응") : "역반응";
    const energy = c1.materialDir * Math.sign(r || 1) > 0 ? "상승 에너지" : "하락 에너지";
    const rawTxt = c1.clipped && c1.raw != null ? `·원값 ${c1.raw.toFixed(1)} (±5 윈저화)` : "";
    return `C1 ${mat} ${react} ${Math.abs(r).toFixed(1)}배 (${energy}·${gradeTxt}${rawTxt})`;
  })();
  return {
    head: `MT ${MT_NAME[day.symbol] ?? day.symbol}: ${phaseLine(day)}${transitionPhrase(day)}`,
    panel: `패널 [${panelChips(day)}]`,
    tail: `${toneLine(day)} | ${boxLine(day)} | ${c1txt}`,
    flags: flags(day),
  };
}

/** 한 줄 요약 (리포트 텍스트·문자용) */
export function mtOneLine(day: MtDay): string {
  const l = mtCardLines(day);
  return `${l.head} | ${l.panel} | ${l.tail}${l.flags.length ? ` | ${l.flags.join(" · ")}` : ""}`;
}

export const MT_DISCLAIMER =
  "MT는 후행·관성 지표다 — 전환점을 예언하지 않고 증거가 쌓이는 것을 집계한다. 1단계는 표시 전용(판정 무개입). " +
  "전환 선언 트랙은 3년 표본 동결(2026-08-16 재채점 미달·오탐률 86%) — 화면은 톤·패널 충족도·박스만, 검증 미달 꼬리표 유지.";
