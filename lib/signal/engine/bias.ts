// 축1 — Bias (매크로·펀더멘털 방향·강도). 마스터 스펙 2.2.
// 구성: 금리·환율(C3·C4) + 밤사이 해외장(C5, 전일 이벤트 방향의 프록시) + 모멘텀 맥락(과대낙폭·과열)
// + 수동 입력(L7 낙폭 원인, L8 컨센서스). 강도 1~3은 정렬 요소 수에 비례 (스펙: 개선 강도에 비중 연동).

import { SIGNAL_CONFIG } from "../config";
import type { BiasResult, PremarketContext } from "../types";
import { cumReturnPct, consecutiveUpDays } from "./daily";

export function computeBias(ctx: PremarketContext): BiasResult {
  const factors: BiasResult["factors"] = [];
  const add = (code: string, label: string, dir: "상방" | "하방" | "중립" | "미상", detail: string) =>
    factors.push({ code, label, dir, detail });

  // C3 환율
  const fx = ctx.usdkrw.changePercent;
  const fxLevel = ctx.usdkrw.level;
  if (fx === null) add("C3", "환율(USD/KRW)", "미상", "시세 없음");
  else {
    const dir = fx <= 0.05 ? "상방" : fx > 0.3 ? "하방" : "중립";
    const levelNote = fxLevel !== null && fxLevel >= SIGNAL_CONFIG.usdkrwHigh ? ` · ${SIGNAL_CONFIG.usdkrwHigh}원 위(경계)` : "";
    add("C3", "환율(USD/KRW)", dir, `전일比 ${fx > 0 ? "+" : ""}${fx.toFixed(2)}%${levelNote}`);
  }

  // C4 미 금리
  const { regime, t10yChangePct } = ctx.usRates;
  if (regime === null) add("C4", "미 금리(10Y)", "미상", "데이터 없음");
  else add("C4", "미 금리(10Y)", regime === "상승" ? "하방" : "상방",
    `${regime} (전일 ${t10yChangePct !== null ? (t10yChangePct > 0 ? "+" : "") + t10yChangePct.toFixed(2) + "%" : "?"})`);

  // C5 밤사이 미국장 — 전일 이벤트·지표 서프라이즈 방향의 프록시 (L10 자동 근사)
  const { nasdaqPct, soxPct } = ctx.overnight;
  const on = [nasdaqPct, soxPct].filter((v): v is number => v !== null);
  if (on.length === 0) add("C5", "밤사이 미국장", "미상", "데이터 없음");
  else {
    const avg = on.reduce((s, v) => s + v, 0) / on.length;
    add("C5", "밤사이 미국장(나스닥·SOX)", avg > 0.3 ? "상방" : avg < -0.3 ? "하방" : "중립",
      `나스닥 ${fmtPct(nasdaqPct)} · SOX ${fmtPct(soxPct)}`);
  }

  // L10 — 경제지표 서프라이즈 (AI가 뉴스에서 직접 판정 — 컨센서스 대비 발표값의 방향)
  // 성공사례 원형: NFP 컨센 11만 vs 실제 5만 = easing → 금리인상 우려 후퇴 = 하락 추세 전환의 선행 신호
  if (ctx.macroSurprise === "easing") add("L10", "지표 서프라이즈 완화적", "상방", "컨센서스 대비 완화 방향 — 매크로 전환 선행 신호");
  else if (ctx.macroSurprise === "tightening") add("L10", "지표 서프라이즈 긴축적", "하방", "컨센서스 대비 긴축 방향");

  // 매크로 전환 감지 — "추세 중의 변화"가 방향 전환을 선행 (5일 추세와 전일 방향이 반대)
  const { t10y5dPct, usdkrw5dPct } = ctx.macroTrend;
  if (t10y5dPct !== null && t10yChangePct !== null) {
    if (t10y5dPct > 1 && t10yChangePct < -0.5)
      add("전환", "금리 상승 추세 꺾임", "상방", `5일 +${t10y5dPct.toFixed(1)}% 추세 중 전일 ${t10yChangePct.toFixed(1)}% 반락`);
    else if (t10y5dPct < -1 && t10yChangePct > 0.5)
      add("전환", "금리 하락 추세 꺾임", "하방", `5일 ${t10y5dPct.toFixed(1)}% 추세 중 전일 +${t10yChangePct.toFixed(1)}% 반등`);
  }
  if (usdkrw5dPct !== null && fx !== null) {
    if (usdkrw5dPct > 0.7 && fx < -0.2)
      add("전환", "환율 상승 추세 꺾임", "상방", `5일 +${usdkrw5dPct.toFixed(1)}% 추세 중 전일 ${fx.toFixed(1)}% 반락`);
    else if (usdkrw5dPct < -0.7 && fx > 0.2)
      add("전환", "환율 하락 추세 꺾임", "하방", `5일 ${usdkrw5dPct.toFixed(1)}% 추세 중 전일 +${fx.toFixed(1)}% 반등`);
  }

  // 모멘텀 맥락 — 과대 낙폭(L6, 역발상 상방) / 과열(S1, 하방)
  const cum3 = cumReturnPct(ctx.hynixDaily, 3, true);
  if (cum3 !== null && cum3 <= SIGNAL_CONFIG.crashCumPct) {
    add("L6", "과대 낙폭(V반등 후보)", "상방", `하닉 직전 3일 누적 ${cum3.toFixed(1)}% ≤ ${SIGNAL_CONFIG.crashCumPct}%`);
  }
  const cum5 = cumReturnPct(ctx.hynixDaily, 5, true);
  const upDays = consecutiveUpDays(ctx.hynixDaily, true);
  if ((cum5 !== null && cum5 >= SIGNAL_CONFIG.overheatCumPct) || upDays >= SIGNAL_CONFIG.overheatDays + 1) {
    add("S1", "과열(반전 경계)", "하방", `5일 누적 ${cum5?.toFixed(1) ?? "?"}% · 연속상승 ${upDays}일`);
  }

  // L7·L8 정성 판단 (AI 자동 분석, 사용자 입력 시 우선)
  const src = ctx.qualSource === "user" ? "사용자 입력" : ctx.qualSource === "ai" ? "AI 자동 분석" : "입력";
  if (ctx.causeNonEarnings === null) add("L7", "낙폭 원인(비실적 여부)", "미상", "AI 분석 대기 (직접 입력 가능)");
  else if (ctx.causeNonEarnings) add("L7", "낙폭 원인 비실적(수급·지정학 등)", "상방", `펀더멘털 무손상 — ${src}`);
  else add("L7", "낙폭 원인 실적성", "하방", `펀더멘털 훼손 — ${src}`);

  if (ctx.consensusIntact === null) add("L8", "이익 컨센서스", "미상", "AI 분석 대기 (직접 입력 가능)");
  else add("L8", "이익 컨센서스", ctx.consensusIntact ? "상방" : "하방",
    ctx.consensusIntact ? `유지·상향 중 — ${src}` : `하향 중 — ${src}`);

  // C2 리밸런싱 월
  add("C2", "리밸런싱 캘린더", ctx.rebalance === "순풍" ? "상방" : ctx.rebalance === "역풍" ? "하방" : "중립", `${ctx.rebalance} 월`);

  // 방향·강도 산출 — 상·하방 요소 수 차이
  const ups = factors.filter((f) => f.dir === "상방").length;
  const downs = factors.filter((f) => f.dir === "하방").length;
  const net = ups - downs;
  const dir: BiasResult["dir"] = net > 0 ? "상방" : net < 0 ? "하방" : "중립";
  const strength = (dir === "중립" ? 0 : Math.min(3, Math.abs(net))) as 0 | 1 | 2 | 3;

  return { dir, strength, factors };
}

function fmtPct(v: number | null): string {
  return v === null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
