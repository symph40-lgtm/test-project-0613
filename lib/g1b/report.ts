// G1B T3 — R1/R2 리포트 텍스트 (스펙 §10 템플릿 + log-only 가상 지시 명기). 발송 없음 — 저장만.

import type { G1BSymbol } from "./config";
import type { Obs } from "./data";

const NAME: Record<G1BSymbol, string> = { "000660": "하닉", "005930": "삼전" };
const p1 = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
const raw = (o?: Obs) => (o && !o.late_arrival && o.v != null ? `${(o.v * 100).toFixed(2)}%` : "결측");

export function buildR1(symbol: G1BSymbol, date: string, fair: number | null, sigma: number, q80: number | null,
                        expOpen: number | null, w: Record<string, number>, night: Record<string, Obs>, regime: string,
                        nfCtx?: { sessionNight: string | null; cutT: string | null; cutPct: number | null }): string {
  // 야간선물 표기 규격 (발주자 8/19 저녁 §1·§2): 세션 밤짜 + 시각 병기, 저녁 절단 → 새벽 관측 화살표
  const probeT = ((night as Record<string, unknown>).night_fut_probe as { t?: string } | undefined)?.t ?? "04:50";
  const nfV = night.night_fut && !night.night_fut.late_arrival ? night.night_fut.v : null;
  const nfTxt = (() => {
    const nm = nfCtx?.sessionNight ? `야간선물(${Number(nfCtx.sessionNight.slice(5, 7))}/${Number(nfCtx.sessionNight.slice(8, 10))}밤)` : "야간선물";
    const cut = nfCtx?.cutPct != null ? `저녁 ${nfCtx.cutT ?? "19:35"} ${p1(nfCtx.cutPct)}` : null;
    const dawn = nfV != null ? `새벽 ${probeT} ${p1(nfV * 100)}` : "새벽 결측";
    let note = "";
    if (nfCtx?.cutPct != null && nfV != null && Math.abs(nfV * 100 - nfCtx.cutPct) >= 1.0) {
      const flip = Math.sign(nfCtx.cutPct) !== Math.sign(nfV) && Math.abs(nfCtx.cutPct) >= 0.3;
      note = flip ? " (밤사이 반전)" : ` (밤사이 ${nfV * 100 < nfCtx.cutPct ? "하락" : "상승"} 심화)`;
    }
    return `${nm}: ${cut ? cut + " → " : ""}${dawn}${note}`;
  })();
  return [
    `[G1B/R1·가상] ${date.slice(5)} 07:20 | ${NAME[symbol]} (log-only)`,
    `지수: SPX ${raw(night.r_spx)} / 글로벡스 ${raw(night.gx)} / ${nfTxt}`,
    `고유: SOXX ${raw(night.r_soxx)} / MU ${raw(night.r_mu)} / 시간외초과 ${raw(night.ah_excess)} / GDR ${raw(night.r_gdr)}`,
    `FairGap_R1 ${p1(fair)} ± ${sigma.toFixed(2)}% (1σ)${q80 != null ? ` · 꼬리80분위 ${q80.toFixed(2)}%` : ""} [레짐 ${regime}]`,
    expOpen ? `예상시가 ${expOpen.toLocaleString()}` : `예상시가 산출 불가(종가 결측)`,
    `가중 ${Object.entries(w).map(([k, v]) => `${k} ${v}`).join(" · ") || "결측"}`,
    // 미편입 전문가 신분 명기 (발주자 표기 지시 8/15 §2) — 리스트 부재가 '누락'으로 오해되지 않게
    ...(night.night_fut && !night.night_fut.late_arrival && night.night_fut.v != null
      ? [`미편입: 야간선물 새벽 ${probeT} 관측 ${raw(night.night_fut)} (검증 중 — 챌린저 v1.1c 병행)`] : []),
    `지시: 가상 — Phase 1(실사용 전환)은 D+15 게이트 통과 후 (A1-6)`,
  ].join("\n");
}

// [발주자 지시 8/20 밤 — R2 표기] 판정 줄 3숫자 규격: "동시호가 예상가 X vs 이론가 Y (차 +원·+%·+σ) → 신호".
// 기존 σ 단독 표기는 괄호 안에 유지 (채점 회계 불변). v1.1c 이론가는 데이터 있는 밤부터 같은 규격 병기.
export function buildR2(symbol: G1BSymbol, date: string, fair2: number | null, est: number | null,
                        residual: number | null, resSigma: number | null, signal: string,
                        theoPx?: number | null, v11c?: { theoPx: number | null; resSigma: number | null }): string {
  const wonS = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString()}`;
  const judge = est && theoPx
    ? `동시호가 예상가 ${est.toLocaleString()} vs 이론가 ${theoPx.toLocaleString()} (차 ${wonS(est - theoPx)}원·${p1(residual)}·${resSigma ?? "—"}σ) → ${signal}`
    : `판정: ${signal}${est ? ` (잔차 ${p1(residual)} = ${resSigma ?? "—"}σ)` : ""}`;
  return [
    `[G1B/R2·가상] ${date.slice(5)} 08:55 | ${NAME[symbol]} (log-only)`,
    `FairGap_R2 ${p1(fair2)}`,
    est ? judge : `동시호가 예상체결 결측 — ${signal}`,
    ...(est && v11c?.theoPx != null
      ? [`병행 vs v1.1c 이론가 ${v11c.theoPx.toLocaleString()} (차 ${wonS(est - v11c.theoPx)}원·${v11c.resSigma ?? "—"}σ) — 채점 회계 무접촉`] : []),
  ].join("\n");
}
