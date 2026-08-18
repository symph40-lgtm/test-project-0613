// G1A v0.3 리포트 텍스트 (스펙 §9 템플릿). 발송하지 않고 로그에 저장만 —
// sms_pause(~8/21) + dispatch NM_ONLY 허용목록(sms-newmodel-only) 때문. 발송 편입은 별도 결정.

import type { G1ASymbol, T2Features, T2State, T2Verdict } from "./types";

const NAME: Record<G1ASymbol, string> = { "000660": "하닉", "005930": "삼전" };
const s1 = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}`);

export function buildT2Report(
  symbol: G1ASymbol, kind: "E" | "F", time: string, v: T2Verdict, f: T2Features, dateKst: string,
): string {
  const md = dateKst.slice(5).replace("-", "-");
  if (v.direction === "NEUTRAL") {
    const why = v.abstain_reason ?? (v.three_way_agree === false ? "3자 불일치" : `GapScore ${s1(v.gap_score)} (θ 미달)`);
    return [
      `[G1A/T2-${kind}] ${md} ${time} | ${NAME[symbol]}`,
      `판정: NEUTRAL — 노포지션`,
      `사유: ${why}`,
      `프리마켓 ${s1(f.F21_basket)}% · 미선물 ${s1(f.F22_usfut)}% · 유럽 ${s1(f.F20_europe)}%`,
    ].join("\n");
  }
  return [
    `[G1A/T2-${kind}] ${md} ${time} | ${NAME[symbol]}`,
    `판정: ${v.direction}·${v.confidence} → NXT ${v.size} 진입 (log-only 가상)`,
    `GapScore ${s1(v.gap_score)} (θ ${v.theta_applied} 통과) | DC-PM ${f.F21_dcpm == null ? "—" : Math.round(f.F21_dcpm * 100) + "%"} | ${v.three_way_agree ? "3자 일치" : "3자 불일치"}`,
    `예상잔여갭 ${s1(v.expected_residual_gap)}% (바스켓 |수익률| |${s1(v.r_basket)}%| ${v.r_basket != null && Math.abs(v.r_basket) >= 0.5 ? "≥0.5% 통과" : "<0.5% 미달"} · NXT 기반영 ${s1(v.r_nxt_pre_entry)}%)`,
    `게이트: 스프레드 ${f.spread_pct == null ? "미측정" : f.spread_pct.toFixed(2) + "%"} (${v.liquidity}) | BiasGate ${v.bias_gate}`,
    `감시: 19:55까지 DC-PM 40% 붕괴·부호 반전 시 청산 기록`,
  ].join("\n");
}

export function buildReversalReport(symbol: G1ASymbol, time: string, why: string, t2: T2State): string {
  return [
    `[G1A/반전] ${time} | ${NAME[symbol]}`,
    `진입(${t2.trigger_time} ${t2.verdict?.direction}·${t2.verdict?.size}) → ${why}`,
    `조치: 19:55 이전 전량 청산 (log-only 가상 기록)`,
  ].join("\n");
}
