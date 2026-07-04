// 셋업 판정 — 레버리지(L1~L11)·인버스(S1~S7)·하드 블록(X·XS). 마스터 스펙 2.2~2.3, 4.1~4.2.
// 하드 블록은 스코어와 무관하게 최우선 차단 (학습·확장 모듈이 무효화 불가).

import { SIGNAL_CONFIG } from "../config";
import type { BiasResult, CheckItem, IntradayTick, PremarketContext, SetupResult, TrendResult } from "../types";
import { cumReturnPct, consecutiveUpDays } from "./daily";

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

  // ══ 레버리지(롱) ══
  const L: CheckItem[] = [];
  const push = (arr: CheckItem[]) => (code: string, label: string, kind: CheckItem["kind"], pass: boolean | null, points: number, detail: string) =>
    arr.push({ code, label, kind, pass, points, detail });
  const l = push(L);

  l("L1", "Bias 상방", "필수", bias.dir === "상방", 0, `축1 ${bias.dir} 강도${bias.strength}`);
  const fxOk = ctx.usdkrw.changePercent !== null ? ctx.usdkrw.changePercent <= 0.1 : null;
  const rateOk = ctx.usRates.regime !== null ? ctx.usRates.regime !== "상승" : null;
  l("L2", "금리·환율 안정", "필수",
    fxOk === null || rateOk === null ? null : fxOk && rateOk, 0,
    `환율 ${fmtB(fxOk)} · 금리 ${fmtB(rateOk)}`);
  const l3 = trend === null ? null : trend.dir === "UP" && (trend.grade === "추세일" || trend.grade === "약한추세" || (trend.dc1 !== null && trend.dc1 >= 0.55));
  l("L3", "상방 방향 형성·유지 확인", "필수", l3, 0,
    trend === null ? "장중 데이터 대기" : `방향 ${trend.dir ?? "-"} · ${trend.grade} · DC1 ${pctOrDash(trend.dc1)}`);
  const inWindow = minuteOfDay >= S.observeEndMin && minuteOfDay <= S.entryEndMin;
  l("L4", `진입 시간대(${hm(S.observeEndMin)}~${hm(S.entryEndMin)})`, "필수", inWindow, 0, minuteToStr(minuteOfDay));
  l("L5", "외인 수급(①수준+②감속 필수)", "필수", l5.pass, 0, l5.detail);

  const cum3 = cumReturnPct(ctx.hynixDaily, 3, true);
  const qualSrc = ctx.qualSource === "user" ? "사용자 입력" : ctx.qualSource === "ai" ? "AI 자동 분석" : "입력";
  l("L6", `직전 1~3일 누적 ${SIGNAL_CONFIG.crashCumPct}% 이상 낙폭`, "가점", crashActive, 3, `누적 ${inp.crashCumPct?.toFixed(1) ?? cum3?.toFixed(1) ?? "?"}%`);
  l("L7", "낙폭 원인 비실적", "가점", ctx.causeNonEarnings, 2, ctx.causeNonEarnings === null ? "AI 분석 대기" : qualSrc);
  l("L8", "이익 컨센서스 유지·상향", "가점", ctx.consensusIntact, 2, ctx.consensusIntact === null ? "AI 분석 대기" : qualSrc);
  l("L9", "개인·기관이 외인 물량 흡수", "가점", l5.absorb, 1, l5.absorbDetail);
  const l10 = ctx.usRates.t10yChangePct !== null && ctx.overnight.nasdaqPct !== null
    ? ctx.usRates.t10yChangePct < -0.5 && ctx.overnight.nasdaqPct > 0.5
    : null;
  l("L10", "전일 매크로 서프라이즈 완화적", "가점", l10, 2, l10 === null ? "자동 근사 불가" : "금리↓+나스닥↑ 근사");
  l("L11", "기대인플레 하락 추세", "가점", null, 1, "데이터 소스 없음 — 수동 확인");

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
  const longVerdict = hardBlockedL ? "차단"
    : !longRequiredOk ? "대기"
    : longBonus >= SIGNAL_CONFIG.score.longStrong ? "강한신호"
    : longBonus >= SIGNAL_CONFIG.score.longCandidate ? "진입후보"
    : "대기";

  // ══ 인버스 ══
  const Sh: CheckItem[] = [];
  const s = push(Sh);
  const upDays = consecutiveUpDays(ctx.hynixDaily, true);
  const cum5 = cumReturnPct(ctx.hynixDaily, 5, true);
  const overheat = upDays >= 2 || (cum5 !== null && cum5 >= SIGNAL_CONFIG.overheatCumPct);
  s("S1", "과열 또는 하방 Bias", "필수", overheat || bias.dir === "하방", 0,
    `연속상승 ${upDays}일 · 5일 ${cum5?.toFixed(1) ?? "?"}% · Bias ${bias.dir}`);
  const macroBad = [
    ctx.usRates.regime === "상승",
    (ctx.usdkrw.changePercent ?? 0) > 0.3,
    (ctx.overnight.nasdaqPct ?? 0) < -0.5,
  ].filter(Boolean).length;
  s("S2", "매크로 악화(2개 이상)", "필수", macroBad >= 2, 0, `충족 ${macroBad}/3 (금리↑·환율↑·해외↓)`);
  const s3 = trend === null ? null : trend.dir === "DOWN" && (trend.grade === "추세일" || trend.grade === "약한추세" || (trend.dc1 !== null && trend.dc1 >= 0.55));
  s("S3", "하방 방향 형성·유지 확인", "필수", s3, 0,
    trend === null ? "장중 데이터 대기" : `방향 ${trend.dir ?? "-"} · ${trend.grade}`);
  const s4 = trend === null ? null : trend.dir === "DOWN" && trend.dc1 !== null && trend.dc1 >= 0.5;
  s("S4", "FKS200 꺾임/하방 지속", "필수", s4, 0, trend === null ? "장중 데이터 대기" : `DC1 ${pctOrDash(trend.dc1)}`);

  const lastTick = ticks[ticks.length - 1];
  const s5 = lastTick
    ? (lastTick.nikkeiChg ?? 0) < -0.3 && (lastTick.hynixChg ?? 0) > 0.5
    : null;
  s("S5", "디커플링 과열(타국↓·한국↑)", "가점", s5, 2, lastTick ? `니케이 ${fmt(lastTick.nikkeiChg)}% · 하닉 ${fmt(lastTick.hynixChg)}%` : "데이터 대기");
  s("S6", "악재 뉴스 발생", "가점", null, 2, "수동 확인 (원인 주석 입력)");
  s("S7", "매크로 컨센서스 수준 → 금리 우려 유지", "가점", null, 1, "수동 확인");

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
  const shortVerdict = shortBlocked.length > 0 ? "차단"
    : shortRequiredOk && shortBonus >= SIGNAL_CONFIG.score.shortCandidate ? "진입후보"
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
