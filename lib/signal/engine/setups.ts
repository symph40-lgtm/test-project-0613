// 셋업 판정 — 레버리지(L1~L11)·인버스(S1~S7)·하드 블록(X·XS). 마스터 스펙 2.2~2.3, 4.1~4.2.
// 하드 블록은 스코어와 무관하게 최우선 차단 (학습·확장 모듈이 무효화 불가).
//
// 2026-07-09 사용자 개정:
//  - LM(매크로 게이트) 신설·필수: 매크로 악화(금리↑·환율↑·SOX↓ 중 2개 이상)면 차트(축2)가 좋아도
//    레버리지 진입 금지 — 매크로가 널뛰면 주가도 널뛰어 변동이 너무 큼.
//  - L1(Bias 상방) 필수에서 제외 — 참고 표기만. L8(컨센서스 가점)·S5(디커플링 가점) 제거.
//  - L10 근사·S2 매크로 악화 판정에서 SOX를 나스닥보다 우선.
// 2026-07-10 사용자 개정:
//  - FG(외인 현물 게이트) 신설·양쪽 필수: 장중 외국인 코스피 현물 순매수 30분 기울기(T8과 같은
//    눈금 ±150억)가 뚜렷한 이탈이면 레버리지 금지, 뚜렷한 개선이면 인버스 금지.
//    데이터 부재·중립은 통과 — 수급은 차단 조건이지 단독 진입 근거가 아님 (백테스트 판정 불변).

import { SIGNAL_CONFIG } from "../config";
import type { BiasResult, CheckItem, IntradayTick, PremarketContext, SetupResult, TrendResult } from "../types";
import { cumReturnPct, consecutiveUpDays } from "./daily";
import { flowDelta } from "./trend";

const S = SIGNAL_CONFIG.session;

type Inputs = {
  ctx: PremarketContext;
  bias: BiasResult;
  trend: TrendResult | null;
  ticks: IntradayTick[];
  gapPct: number | null;       // 하닉 기준 당일 갭
  minuteOfDay: number;
  crashActive: boolean;        // 분기1 — 직전 1~3일 누적 -12% 이상
  crashCumPct: number | null;
};

export function computeSetups(inp: Inputs): SetupResult {
  const { ctx, bias, trend, ticks, gapPct, minuteOfDay, crashActive } = inp;

  // ── L5 외인 수급 3요소 (하닉 개별 잠정치 — plan.md 편차 2)
  const l5 = foreignThreeFactor(ticks, ctx.frgn20dAvg.hynix);

  // ── 매크로 악화 지표 (LM 게이트·S2 공용) — 해외장은 SOX 우선, 없으면 나스닥 (2026-07-09)
  const usEquity = ctx.overnight.soxPct ?? ctx.overnight.nasdaqPct;
  const macroBadItems = [
    ctx.usRates.regime === "상승",
    (ctx.usdkrw.changePercent ?? 0) > 0.3,
    (usEquity ?? 0) < -0.5,
  ];
  const macroBad = macroBadItems.filter(Boolean).length;

  // ── FG 외인 현물 게이트 (2026-07-10) — 코스피 외국인 현물 순매수(KIS 억원) 30분 기울기.
  // T8과 같은 눈금(±t8MinDelta30). null(데이터 부재·중립)은 양쪽 통과.
  const kfFlow = flowDelta(ticks, (t) => t.kospiFrgn);
  const fgTh = SIGNAL_CONFIG.trend.t8MinDelta30;
  const fgDir: "UP" | "DOWN" | null =
    kfFlow === null ? null : kfFlow.delta >= fgTh ? "UP" : kfFlow.delta <= -fgTh ? "DOWN" : null;
  const fgDetail = kfFlow === null
    ? "KIS 수급 대기 — 통과"
    : `외인현물 누적 ${fmtBil(kfFlow.cur)} · Δ${kfFlow.spanMin}분 ${fmtBil(kfFlow.delta)} (기준 ±${fgTh}억)`;

  // ══ 레버리지(롱) ══
  const L: CheckItem[] = [];
  const push = (arr: CheckItem[]) => (code: string, label: string, kind: CheckItem["kind"], pass: boolean | null, points: number, detail: string) =>
    arr.push({ code, label, kind, pass, points, detail });
  const l = push(L);

  // ══ 재설계 2026-07-15 (사용자 지정): 필수는 "이것 아니면 절대 안 되는" 조건만 —
  // 방향(L3)·시간대(L4)·차단형 게이트(LM·FG). 나머지는 배점 차등 가점 (만점 14).
  // LM — 매크로 게이트 (필수): 매크로 악화 2개 이상이면 레버리지 진입 금지 (차단형).
  l("LM", "매크로 게이트(악화 2개 미만)", "필수", macroBad < 2, 0,
    `악화 ${macroBad}/3 (금리↑ ${fmtB(macroBadItems[0])} · 환율↑ ${fmtB(macroBadItems[1])} · SOX↓ ${fmtB(macroBadItems[2])})`);
  // FG — 외인 현물 게이트 (필수): 외인 현물이 뚜렷이 이탈 중이면 레버리지 금지 (차단형 — 부재·중립 통과).
  l("FG", "외인 현물 게이트(이탈 아님)", "필수", fgDir !== "DOWN", 0, fgDetail);
  const l3 = trend === null ? null : trend.dir === "UP" && (trend.grade === "추세일" || trend.grade === "약한추세" || (trend.dc1 !== null && trend.dc1 >= 0.55));
  l("L3", "상방 방향 형성·유지 확인", "필수", l3, 0,
    trend === null ? "장중 데이터 대기" : `방향 ${trend.dir ?? "-"} · ${trend.grade} · DC1 ${pctOrDash(trend.dc1)}`);
  const inWindow = minuteOfDay >= S.observeEndMin && minuteOfDay <= S.entryEndMin;
  l("L4", `진입 시간대(${hm(S.observeEndMin)}~${hm(S.entryEndMin)})`, "필수", inWindow, 0, minuteToStr(minuteOfDay));

  // ── 가점 (배점 차등 — 2026-07-15 재설계)
  // L5 외인 수급 +3 (필수→고배점 가점): 외인이 팔아도 상방인 날이 있어 절대 조건이 아니며,
  // 실측상 네이버 잠정치가 장중 미제공이라 필수로 두면 레버리지 확정이 영구 불가능했음.
  l("L5", "외인 수급(①수준+②감속)", "가점", l5.pass, 3, l5.detail);
  const cum3 = cumReturnPct(ctx.hynixDaily, 3, true);
  const qualSrc = ctx.qualSource === "user" ? "사용자 입력" : ctx.qualSource === "ai" ? "AI 자동 분석" : "입력";
  l("L6", `직전 1~3일 누적 ${SIGNAL_CONFIG.crashCumPct}% 이상 낙폭`, "가점", crashActive, 3, `누적 ${inp.crashCumPct?.toFixed(1) ?? cum3?.toFixed(1) ?? "?"}%`);
  // L1 Bias 상방 +2/+1 (참고→가점 승격, 사용자 지정 2026-07-15): 강도 2↑ +2, 강도 1 +1
  l("L1", "Bias 상방(축1)", "가점", bias.dir === "상방", bias.dir === "상방" && bias.strength >= 2 ? 2 : 1,
    `축1 ${bias.dir} 강도${bias.strength}${bias.dir === "상방" ? (bias.strength >= 2 ? " (+2)" : " (+1)") : ""}`);
  l("L7", "낙폭 원인 비실적", "가점", ctx.causeNonEarnings, 2, ctx.causeNonEarnings === null ? "AI 분석 대기" : qualSrc);
  // (L8 이익 컨센서스 가점 — 사용자 개정 2026-07-09로 제거. XS2 차단 판단에는 계속 사용)
  // L10 — AI 서프라이즈 판정(컨센서스 대비 발표값) 우선, 없으면 시장 반응으로 근사.
  const l10 = ctx.macroSurprise !== null
    ? ctx.macroSurprise === "easing"
    : ctx.usRates.changePp !== null && usEquity !== null
      ? ctx.usRates.changePp < -0.03 && usEquity > 0.5
      : null;
  l("L10", "전일 매크로 서프라이즈 완화적", "가점", l10, 2,
    ctx.macroSurprise !== null ? `지표 서프라이즈 ${ctx.macroSurprise === "easing" ? "완화" : "긴축"} (AI 판정)` : l10 === null ? "자동 근사 불가" : "금리↓+SOX↑ 근사");
  // L2 금리·환율 안정 +1 (참고→저배점 가점 — Bias C3·C4와 부분 중복이라 배점 최소)
  const fxOk = ctx.usdkrw.changePercent !== null ? ctx.usdkrw.changePercent <= 0.1 : null;
  const rateOk = ctx.usRates.regime !== null ? ctx.usRates.regime !== "상승" : null;
  l("L2", "금리·환율 안정", "가점", fxOk === null || rateOk === null ? null : fxOk && rateOk, 1,
    `환율 ${fmtB(fxOk)} · 금리(2Y) ${fmtB(rateOk)} (Bias 중복이라 +1만)`);
  l("L9", "개인·기관이 외인 물량 흡수", "가점", l5.absorb, 1, l5.absorbDetail);
  // (L11 기대인플레 — 데이터 소스가 없어 영구 미산출이라 목록에서 제거, 2026-07-15)

  // 금지 X1~X3
  const longBlocked: string[] = [];
  if (gapPct !== null && gapPct > SIGNAL_CONFIG.gapBigPct) {
    // "큰 갭일수록 확인 구간을 길게" (2.2.1 X1) — 갭 1%당 5분, 최소 10분·최대 60분 확인 후에만 해제
    const confirmUntil = S.observeEndMin + Math.min(60, Math.max(10, Math.round(gapPct * 5)));
    const confirmed =
      trend !== null && trend.dir === "UP" &&
      (trend.grade === "추세일" || trend.grade === "약한추세") &&
      minuteOfDay >= confirmUntil;
    if (!confirmed) {
      longBlocked.push(
        `X1: 갭 +${gapPct.toFixed(1)}% 초과 — 시초 추격 금지, ${minuteToStr(confirmUntil)} 이후 상승 지속 확인 시 허용`,
      );
    }
  }
  const binaryToday = ctx.events.some((e) => e.binary && e.when === "당일");
  if (binaryToday) longBlocked.push("X2 주의: 당일 바이너리 이벤트 — 오버나잇 금지(당일 청산 원칙 준수)");
  // X3 일일 손실 한도 — 계좌 미연동, 사용자 확인 사항으로만 표기

  const requiredL = L.filter((i) => i.kind === "필수");
  const longRequiredOk = requiredL.every((i) => i.pass === true);
  const longBonus = L.filter((i) => i.kind === "가점" && i.pass === true).reduce((s, i) => s + i.points, 0);
  const hardBlockedL = longBlocked.some((b) => b.startsWith("X1"));
  // 상방 추세일 확정이면 가점 미달이어도 진입후보 — 판정-카드 정합 (숏과 대칭, 2026-07-15)
  const trendUpConfirmed = trend !== null && trend.dir === "UP" && trend.grade === "추세일";
  const longVerdict = hardBlockedL ? "차단"
    : !longRequiredOk ? "대기"
    : longBonus >= SIGNAL_CONFIG.score.longStrong ? "강한신호"
    : longBonus >= SIGNAL_CONFIG.score.longCandidate || trendUpConfirmed ? "진입후보"
    : "대기";

  // ══ 인버스 ══
  const Sh: CheckItem[] = [];
  const s = push(Sh);
  // ══ 재설계 2026-07-15 (사용자 지정): 필수는 방향(S3·S4)·차단형 게이트(FG)만.
  // S1(과열)·S2(매크로 악화)는 하락 확률을 높이는 근거이지 "이것 아니면 안 되는" 절대 조건이
  // 아님 — 차트 주도 하락일(매크로 악화 1개뿐)도 실재. 배점 차등 가점으로 (만점 8).
  // FG — 외인 현물 게이트 (필수·차단형): 외인 현물이 뚜렷이 개선 중이면 인버스 금지.
  s("FG", "외인 현물 게이트(개선 아님)", "필수", fgDir !== "UP", 0, fgDetail);
  const s3 = trend === null ? null : trend.dir === "DOWN" && (trend.grade === "추세일" || trend.grade === "약한추세" || (trend.dc1 !== null && trend.dc1 >= 0.55));
  s("S3", "하방 방향 형성·유지 확인", "필수", s3, 0,
    trend === null ? "장중 데이터 대기" : `방향 ${trend.dir ?? "-"} · ${trend.grade}`);
  const s4 = trend === null ? null : trend.dir === "DOWN" && trend.dc1 !== null && trend.dc1 >= 0.5;
  s("S4", "FKS200 꺾임/하방 지속", "필수", s4, 0, trend === null ? "장중 데이터 대기" : `DC1 ${pctOrDash(trend.dc1)}`);

  // ── 가점 (배점 차등 — 2026-07-15 재설계)
  // S2 매크로 악화 +3 (필수→고배점 가점): 인버스의 가장 강한 근거이지만 절대 조건은 아님
  s("S2", "매크로 악화(2개 이상)", "가점", macroBad >= 2, 3, `충족 ${macroBad}/3 (금리↑·환율↑·SOX↓)`);
  // S1 과열/하방 Bias +2 (필수→가점)
  const upDays = consecutiveUpDays(ctx.hynixDaily, true);
  const cum5 = cumReturnPct(ctx.hynixDaily, 5, true);
  const overheat = upDays >= 2 || (cum5 !== null && cum5 >= SIGNAL_CONFIG.overheatCumPct);
  s("S1", "과열 또는 하방 Bias", "가점", overheat || bias.dir === "하방", 2,
    `연속상승 ${upDays}일 · 5일 ${cum5?.toFixed(1) ?? "?"}% · Bias ${bias.dir}`);
  // S5 — 디커플링 과열: 판정 제외, 참고 표기만 (사용자 개정 2026-07-09)
  const lastTick = ticks[ticks.length - 1];
  s("S5", "디커플링 과열 (판정 제외 — 참고)", "가점", null, 0, lastTick ? `니케이 ${fmt(lastTick.nikkeiChg)}% · 하닉 ${fmt(lastTick.hynixChg)}%` : "데이터 대기");
  // S6 — 악재 뉴스 발생: AI 자동 주석으로 자동 판정 (사용자 지정 2026-07-13 — 수동확인 제거).
  // 전일 미국 뉴스 하방(L7) 또는 낙폭 원인 주석 존재(= 하락 + 원인 분석됨)면 악재 있음.
  // annotation_source='user'인 날은 사용자 입력이 그대로 반영된다 (autoAnnotate가 덮어쓰지 않음).
  const s6 = ctx.usNews.impact === "하방" || ctx.causeNonEarnings !== null ? true
    : ctx.usNews.impact !== null ? false : null;
  s("S6", "악재 뉴스 발생", "가점", s6, 2,
    ctx.usNews.impact === "하방" ? `전일 미국 뉴스 하방 (${qualSrc})${ctx.usNews.note ? ` — ${ctx.usNews.note}` : ""}`
    : ctx.causeNonEarnings !== null ? `낙폭 원인 주석 있음 (${qualSrc})`
    : ctx.usNews.impact !== null ? `전일 미국 뉴스 ${ctx.usNews.impact} — 뚜렷한 악재 없음 (${qualSrc})`
    : "AI 분석 대기");

  // S7 — 금리 우려 유지: C4(2Y 레짐·5일 추세)·C6(10Y 절대 레벨 단계)로 자동 판정 (사용자 지정 2026-07-13).
  const tenY = ctx.macroExtra?.us10y ?? null;
  const us10yFirstBand = SIGNAL_CONFIG.us10yBands[0].from;
  const tenYWorry: boolean | null = tenY === null || tenY.level === null ? null
    : tenY.level >= us10yFirstBand && (tenY.changePp === null || tenY.changePp > -0.03);
  const twoYWorry: boolean | null = ctx.usRates.regime === null ? null
    : ctx.usRates.regime === "상승" || (ctx.macroTrend.rate5dPp !== null && ctx.macroTrend.rate5dPp > 0.08);
  const s7 = tenYWorry === null && twoYWorry === null ? null : tenYWorry === true || twoYWorry === true;
  s("S7", "매크로 컨센서스 수준 → 금리 우려 유지", "가점", s7, 1,
    `2Y ${ctx.usRates.regime ?? "?"}${ctx.macroTrend.rate5dPp !== null ? ` · 5일 ${ctx.macroTrend.rate5dPp > 0 ? "+" : ""}${ctx.macroTrend.rate5dPp.toFixed(2)}%p` : ""} · 10Y ${tenY?.level != null ? `${tenY.level.toFixed(2)}%` : "?"}${tenYWorry === true ? ` (경계 ${us10yFirstBand}%↑)` : ""}`);

  const shortBlocked: string[] = [];
  if (crashActive && gapPct !== null && gapPct > 0) {
    shortBlocked.push(`XS1: 폭락(${inp.crashCumPct?.toFixed(1)}%) 후 갭상승 — V반등, 인버스 절대 금지`);
  } else if (crashActive) {
    shortBlocked.push(`XS1 준용: 직전 폭락 ${inp.crashCumPct?.toFixed(1)}% — V반등 분기 우선, 인버스 금지`);
  }
  if (ctx.causeNonEarnings === true && ctx.consensusIntact === true) {
    shortBlocked.push(`XS2: 비실적 낙폭 + 컨센서스 유지 구간 — 인버스 금지 (${qualSrc})`);
  }

  const requiredS = Sh.filter((i) => i.kind === "필수");
  const shortRequiredOk = requiredS.every((i) => i.pass === true);
  const shortBonus = Sh.filter((i) => i.kind === "가점" && i.pass === true).reduce((sm, i) => sm + i.points, 0);
  // 하락 추세일 확정이면 가점 미달이어도 진입후보 — 판정(추세일_하방·인버스 검토)과 셋업 카드가
  // 어긋나지 않게 (사용자 피드백 2026-07-13: 필수 전부 충족 + 강한 하락일인데 '대기 0/3' 표시)
  const trendDownConfirmed = trend !== null && trend.dir === "DOWN" && trend.grade === "추세일";
  const shortVerdict = shortBlocked.length > 0 ? "차단"
    : shortRequiredOk && (shortBonus >= SIGNAL_CONFIG.score.shortCandidate || trendDownConfirmed) ? "진입후보"
    : "대기";

  return {
    long: { items: L, requiredOk: longRequiredOk, bonus: longBonus, blocked: longBlocked, verdict: longVerdict },
    short: { items: Sh, requiredOk: shortRequiredOk, bonus: shortBonus, blocked: shortBlocked, verdict: shortVerdict },
  };
}

// L5 — 외인 수급 3요소 (하닉 잠정 순매매량 틱 시계열 기반)
function foreignThreeFactor(ticks: IntradayTick[], avg20: number | null): {
  pass: boolean | null; detail: string; absorb: boolean | null; absorbDetail: string;
} {
  const pts = ticks.filter((t) => t.hynixFrgn !== null).map((t) => ({ min: t.minuteOfDay, v: t.hynixFrgn as number, inst: t.hynixInst }));
  if (pts.length === 0) return { pass: null, detail: "외인 잠정치 데이터 대기", absorb: null, absorbDetail: "데이터 대기" };
  const cur = pts[pts.length - 1];

  // 순매수 중이면 3요소 자동 충족
  if (cur.v >= 0) {
    return {
      pass: true,
      detail: `외인 순매수 ${fmtQty(cur.v)}주 — 수급 우호`,
      absorb: null,
      absorbDetail: "외인 매도 국면 아님",
    };
  }

  // ① 수준 — 당일 누적 순매도 ≤ 20일 평균 × 1.5 (절대 기준치의 배율 정규화, 버퍼 포함)
  const ratio = avg20 !== null && avg20 > 0 ? Math.abs(cur.v) / avg20 : null;
  const levelOk = ratio === null ? null : ratio <= 1.5;

  // ② 기울기 — 30분 구간별 순매도 증가분 감속 (뒤 구간 ≤ 앞 구간)
  let slopeOk: boolean | null = null;
  const bucket = (min: number) => Math.floor(min / 30);
  const byBucket = new Map<number, number>();
  for (const p of pts) byBucket.set(bucket(p.min), p.v); // 구간 마지막 값
  const keys = [...byBucket.keys()].sort((a, b) => a - b);
  if (keys.length >= 3) {
    const incs: number[] = [];
    for (let i = 1; i < keys.length; i++) {
      incs.push(Math.abs(byBucket.get(keys[i])!) - Math.abs(byBucket.get(keys[i - 1])!));
    }
    const lastInc = incs[incs.length - 1], prevInc = incs[incs.length - 2];
    slopeOk = lastInc <= prevInc; // 매도 증가분 감속
  }

  // ③ 상대강도 (가점 참고) — 페이스 ≤ 20일 평균 1.2배
  const paceOk = ratio === null ? null : ratio <= SIGNAL_CONFIG.foreign.paceMaxRatio;

  const pass = levelOk === null || slopeOk === null ? null : levelOk && slopeOk;
  const detail = `①수준 ${fmtB(levelOk)}(${ratio === null ? "?" : ratio.toFixed(2) + "×20일평균"}) ②감속 ${fmtB(slopeOk)} ③페이스 ${fmtB(paceOk)}`;

  // L9 — 기관 순매수가 외인 매도의 절반 이상 흡수
  const absorb = cur.inst !== null ? cur.inst > 0 && cur.inst >= Math.abs(cur.v) * 0.5 : null;
  const absorbDetail = cur.inst === null ? "기관 잠정치 없음" : `기관 ${fmtQty(cur.inst)}주 vs 외인 ${fmtQty(cur.v)}주`;

  return { pass, detail, absorb, absorbDetail };
}

function fmtB(v: boolean | null): string {
  return v === null ? "?" : v ? "충족" : "미충족";
}
function fmtBil(v: number): string {
  return `${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}억`;
}
function fmt(v: number | null): string {
  return v === null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}
function fmtQty(v: number): string {
  return new Intl.NumberFormat("ko-KR").format(Math.round(v));
}
function pctOrDash(v: number | null): string {
  return v === null ? "-" : `${(v * 100).toFixed(0)}%`;
}
function hm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function minuteToStr(m: number): string {
  return `${hm(m)} KST`;
}
