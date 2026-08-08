// G1B T3 — R1/R2 리포트 텍스트 (스펙 §10 템플릿 + log-only 가상 지시 명기). 발송 없음 — 저장만.

import type { G1BSymbol } from "./config";
import type { Obs } from "./data";

const NAME: Record<G1BSymbol, string> = { "000660": "하닉", "005930": "삼전" };
const p1 = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
const raw = (o?: Obs) => (o && !o.late_arrival && o.v != null ? `${(o.v * 100).toFixed(2)}%` : "결측");

export function buildR1(symbol: G1BSymbol, date: string, fair: number | null, sigma: number, q80: number | null,
                        expOpen: number | null, w: Record<string, number>, night: Record<string, Obs>, regime: string): string {
  return [
    `[G1B/R1·가상] ${date.slice(5)} 07:20 | ${NAME[symbol]} (log-only)`,
    `지수: SPX ${raw(night.r_spx)} / 글로벡스 ${raw(night.gx)} / 야간선물 ${raw(night.night_fut)}`,
    `고유: SOXX ${raw(night.r_soxx)} / MU ${raw(night.r_mu)} / 시간외초과 ${raw(night.ah_excess)} / GDR ${raw(night.r_gdr)}`,
    `FairGap_R1 ${p1(fair)} ± ${sigma.toFixed(2)}% (1σ)${q80 != null ? ` · 꼬리80분위 ${q80.toFixed(2)}%` : ""} [레짐 ${regime}]`,
    expOpen ? `예상시가 ${expOpen.toLocaleString()}` : `예상시가 산출 불가(종가 결측)`,
    `가중 ${Object.entries(w).map(([k, v]) => `${k} ${v}`).join(" · ") || "결측"}`,
    `지시: 가상 — Phase 1(실사용 전환)은 D+15 게이트 통과 후 (A1-6)`,
  ].join("\n");
}

export function buildR2(symbol: G1BSymbol, date: string, fair2: number | null, est: number | null,
                        residual: number | null, resSigma: number | null, signal: string): string {
  return [
    `[G1B/R2·가상] ${date.slice(5)} 08:55 | ${NAME[symbol]} (log-only)`,
    `FairGap_R2 ${p1(fair2)}`,
    est ? `동시호가 예상체결 ${est.toLocaleString()} → 잔차 ${p1(residual)} = ${resSigma ?? "—"}σ` : `동시호가 예상체결 결측`,
    `판정: ${signal}`,
  ].join("\n");
}
