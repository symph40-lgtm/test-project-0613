// 6월 실사례 재현 검증 — 마스터 스펙 4.4 판정 예시 + 2.5.7 추세일 재검증 표.
// 각 시나리오를 합성 틱 시계열 + 장전 컨텍스트로 재구성해 "실제 엔진(decide)"에 투입하고
// 스펙의 기대 판정과 대조한다. Phase 1 성공 기준: 특이도(횡보일을 횡보일로) 우선 (마스터 6장).

import { decide } from "./engine/decide";
import { buildSignalAlert } from "./alerts";
import type { DailyBar, IntradayTick, Judgment, PremarketContext } from "./types";

export type BacktestResult = {
  name: string;
  scenario: string;
  expected: string;
  actual: string;
  pass: boolean;
  detail: string;
  smsPreview: string | null; // 이 판정 시점에 발송됐을 문자 (판정 구간 아니거나 비대상이면 null)
};

// ── 픽스처 빌더 ─────────────────────────────────────────────

// 종가 배열 → 일봉 (마지막이 "전일". 과거 날짜 고정 — 오늘 봉 없음)
function makeDaily(closes: number[]): DailyBar[] {
  return closes.map((c, i) => {
    const prev = i > 0 ? closes[i - 1] : c;
    const open = prev;
    return {
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      open,
      high: Math.max(open, c) * 1.008,
      low: Math.min(open, c) * 0.992,
      close: c,
      volume: 5_000_000,
    };
  });
}

// 평탄한 일봉 20개 + 지정 등락률(%) 시퀀스 적용
function dailyWithMoves(base: number, movesPct: number[]): DailyBar[] {
  const closes: number[] = [];
  let px = base;
  for (let i = 0; i < 20; i++) closes.push(px);
  for (const m of movesPct) {
    px = px * (1 + m / 100);
    closes.push(px);
  }
  return makeDaily(closes);
}

// 구간별 선형 경로(전일 종가 대비 %) → 1분 틱 시계열
type Seg = { from: number; to: number; startPct: number; endPct: number }; // from/to = 분(minuteOfDay)
function makeTicks(segs: Seg[], opts: {
  futPrevClose: number;
  hynixPrevClose: number;
  nikkeiChg: number | null;
  twiiChg: number | null;
  hynixFrgn?: number | null;
  hynixInst?: number | null;
  breadth?: number | null;
}): IntradayTick[] {
  const ticks: IntradayTick[] = [];
  for (const s of segs) {
    for (let m = s.from; m < s.to; m++) {
      const t = (m - s.from) / Math.max(1, s.to - s.from);
      const pct = s.startPct + (s.endPct - s.startPct) * t;
      const futPx = opts.futPrevClose * (1 + pct / 100);
      const hynixPx = opts.hynixPrevClose * (1 + pct / 100);
      ticks.push({
        ts: new Date(Date.UTC(2026, 5, 30, Math.floor(m / 60) - 9, m % 60)).toISOString(),
        minuteOfDay: m,
        futPx, futChg: pct,
        k200Px: futPx - 1.2,
        hynixPx, hynixChg: pct,
        samsungPx: null, samsungChg: null,
        hynixFrgn: opts.hynixFrgn ?? null,
        samsungFrgn: null,
        hynixInst: opts.hynixInst ?? null,
        samsungInst: null,
        nikkeiChg: opts.nikkeiChg,
        twiiChg: opts.twiiChg,
        nqChg: null,
        breadth: opts.breadth ?? null,
        basis: 1.2,
      });
    }
  }
  return ticks;
}

function makeCtx(over: Partial<PremarketContext> & { hynixDaily: DailyBar[] }): PremarketContext {
  return {
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    events: [],
    rebalance: "중립",
    usdkrw: { level: 1450, changePercent: -0.1 },
    usRates: { changePp: -0.01, regime: "안정" },
    macroTrend: { rate5dPp: null, usdkrw5dPct: null },
    macroSurprise: null,
    overnight: { nasdaqPct: 0.5, soxPct: 0.8 },
    samsungDaily: over.hynixDaily,
    k200Daily: over.hynixDaily,
    frgn20dAvg: { hynix: 1_000_000, samsung: 800_000 },
    consensusIntact: null,
    causeNonEarnings: null,
    qualSource: "user", // 백테스트 픽스처의 정성 값은 확정 입력으로 취급
    ...over,
  };
}

// ── 시나리오 ─────────────────────────────────────────────

export function runBacktest(): BacktestResult[] {
  const results: BacktestResult[] = [];
  const check = (
    name: string, scenario: string, expected: string,
    j: Judgment, pass: boolean, actual: string, detail: string,
  ) => results.push({
    name, scenario, expected, actual, pass,
    detail: `${detail} · 판정 "${j.headline}"`,
    smsPreview: buildSignalAlert(j)?.text ?? null,
  });

  // ── 6/9 — 이틀 -16.9% 후 갭 +7.3% (V반등, 인버스 진입 시 대참사) — 실측: -9.9%·-7.7%, 종가 +15.9%
  {
    const daily = dailyWithMoves(2_900_000, [-9.9, -7.7]); // 이틀 누적 -16.9% (실측)
    const ctx = makeCtx({ hynixDaily: daily, causeNonEarnings: true, consensusIntact: true });
    const ticksEarly = makeTicks(
      [{ from: 540, to: 575, startPct: 7.3, endPct: 8.0 }],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 1.0, twiiChg: 0.8 },
    );
    const j0935 = decide(ctx, ticksEarly, 575, new Date().toISOString());
    const xs1 = j0935.setups.short.blocked.some((b) => b.includes("XS1"));
    const x1 = j0935.setups.long.blocked.some((b) => b.includes("X1"));
    check("6/9 (a) 시초", "이틀 -17% 후 갭 +7.3% 직후", "인버스 XS1 차단 + 롱 시초 추격 X1 차단",
      j0935, xs1 && x1 && j0935.dayType === "V반등후보",
      `dayType=${j0935.dayType}, XS1=${xs1}, X1=${x1}`,
      `crash=${j0935.crashContext.cumPct?.toFixed(1)}%`);

    const ticksLate = makeTicks(
      [{ from: 540, to: 615, startPct: 7.3, endPct: 14.5 }],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 1.0, twiiChg: 0.8, hynixFrgn: 300_000 },
    );
    const j1015 = decide(ctx, ticksLate, 615, new Date().toISOString());
    const xs1b = j1015.setups.short.blocked.some((b) => b.includes("XS1"));
    check("6/9 (b) 상승 지속", "갭 후 +14%대 상승 지속(10:15)", "인버스 계속 차단 + V반등 롱 경로 개방",
      j1015, xs1b && j1015.dayType === "V반등후보" && j1015.setups.long.blocked.length === 0 ||
        (xs1b && j1015.setups.long.verdict !== "차단"),
      `dayType=${j1015.dayType}, 롱=${j1015.setups.long.verdict}, XS1=${xs1b}`,
      `T=${j1015.trend?.score.toFixed(1)}/${j1015.trend?.maxAvailable}`);
  }

  // ── 페이드형 (가상 패턴) — 과열 갭 +8.6% 후 초반부터 일방향 하락
  // 주의: 원래 스펙 2.5.7이 6/12를 이 패턴으로 기록했으나 실측 결과 오기로 판명(스펙 정정 주석 참조).
  // 실제 6/12는 아래 "6/12 실측" 케이스. 이 시나리오는 '즉시 페이드' 패턴 자체의 규칙 검증으로 유지.
  {
    const daily = dailyWithMoves(2_400_000, [6, 5, 4]); // 3연속 상승 +15%대 (과열)
    const ctx = makeCtx({
      hynixDaily: daily,
      usdkrw: { level: 1490, changePercent: 0.5 },
      usRates: { changePp: 0.05, regime: "상승" },
      overnight: { nasdaqPct: -0.8, soxPct: -1.2 },
    });
    const ticks = makeTicks(
      [{ from: 540, to: 615, startPct: 8.6, endPct: 2.5 }], // 갭+8.6% 후 일방향 하락
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: -0.6, twiiChg: -0.5 },
    );
    const j = decide(ctx, ticks, 615, new Date().toISOString());
    check("페이드형(가상)", "과열 갭 +8.6% → 초반부터 하락 지속 (가상 패턴)", "추세일_하방 (인버스 추세추종)",
      j, j.dayType === "추세일_하방",
      `dayType=${j.dayType}`,
      `T=${j.trend?.score.toFixed(1)}/${j.trend?.maxAvailable} · DC1=${j.trend?.dc1 !== null && j.trend?.dc1 !== undefined ? (j.trend.dc1 * 100).toFixed(0) + "%" : "-"}`);
  }

  // ── 6/12 실측 — 갭 +8.6% 후 시가 부근 유지·등락, 막판(15시경) 급락 (일봉: 고가 +1.0%뿐, 저가 마감)
  // 진입 창 내 방향 미형성 → 시스템 정답은 "미진입" (막판 급락은 따라갈 수 없는 유형 — 특이도 검증)
  {
    const daily = dailyWithMoves(2_050_000, [-4, 2.6]); // 6/10 하락·6/11 소폭 상승 (실측 근사)
    const ctx = makeCtx({
      hynixDaily: daily,
      usdkrw: { level: 1480, changePercent: 0.2 },
      usRates: { changePp: 0.01, regime: "안정" },
      overnight: { nasdaqPct: 0.8, soxPct: 1.5 },
    });
    const ticks = makeTicks(
      [
        { from: 540, to: 570, startPct: 8.6, endPct: 8.9 },  // 갭 후 소폭 위
        { from: 570, to: 620, startPct: 8.9, endPct: 8.5 },  // 시가 부근 등락 유지
        { from: 620, to: 670, startPct: 8.5, endPct: 9.1 },
        { from: 670, to: 720, startPct: 9.1, endPct: 8.4 },
        { from: 720, to: 770, startPct: 8.4, endPct: 8.9 },
        { from: 770, to: 805, startPct: 8.9, endPct: 8.6 },  // 13:25 판정 시점까지 방향 없음 (급락은 15시 — 창 밖)
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 0.3, twiiChg: 0.4 },
    );
    const j = decide(ctx, ticks, 805, new Date().toISOString());
    const noEntry = (j.dayType === "대기" || j.dayType === "횡보일") &&
      j.setups.long.verdict !== "진입후보" && j.setups.long.verdict !== "강한신호" &&
      j.setups.short.verdict !== "진입후보";
    check("6/12 실측", "갭 +8.6% → 시가 부근 유지·등락 (막판 급락 전 13:25 판정)", "미진입 (대기/횡보일 — 안 하는 날)",
      j, noEntry,
      `dayType=${j.dayType}, 롱=${j.setups.long.verdict}, 숏=${j.setups.short.verdict}`,
      `방향 미형성 검증`);
  }

  // ── 6/23 — 5연속 상승 +28% 후 전쟁 악재, 초반부터 일방향 하락 (장중 -11.8%)
  {
    const daily = dailyWithMoves(2_200_000, [5, 5, 6, 5, 4]); // 5연속 상승
    const ctx = makeCtx({
      hynixDaily: daily,
      usdkrw: { level: 1500, changePercent: 0.8 },
      usRates: { changePp: 0.04, regime: "상승" },
      overnight: { nasdaqPct: -1.5, soxPct: -2.0 },
    });
    const ticks = makeTicks(
      [{ from: 540, to: 615, startPct: -0.7, endPct: -7.5 }],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: -1.8, twiiChg: -1.5, breadth: 0.15 },
    );
    const j = decide(ctx, ticks, 615, new Date().toISOString());
    check("6/23", "5연속 +28% 후 전쟁 악재 — 갭 -0.7% 일방향 하락", "추세일_하방 (인버스 교과서)",
      j, j.dayType === "추세일_하방",
      `dayType=${j.dayType}`,
      `T=${j.trend?.score.toFixed(1)}/${j.trend?.maxAvailable}`);
  }

  // ── 7/3 — 전일 -14.6% 폭락, 무갭(+0.5%) 출발 → 09:59 저점 -6.4% → V반전 후 종일 상승 (실측 분봉 경로)
  // 성공사례 원형: NFP 서프라이즈(easing) + 금리·환율 상승 추세 꺾임 + 과매도 + 비실적 낙폭
  {
    const daily = dailyWithMoves(2_650_000, [-3.4, -14.6]); // 7/1 -3.4%, 7/2 -14.6% (실측)
    const ctx = makeCtx({
      hynixDaily: daily,
      causeNonEarnings: true,
      consensusIntact: true,
      usdkrw: { level: 1440, changePercent: -0.4 },
      usRates: { changePp: -0.05, regime: "하락" },
      macroTrend: { rate5dPp: 0.12, usdkrw5dPct: 1.1 }, // 상승 추세였다가 전일 꺾임 (전환 감지)
      macroSurprise: "easing",                            // NFP 컨센 11만 vs 실제 5만대
      overnight: { nasdaqPct: 1.2, soxPct: 1.5 },
    });
    const ticks = makeTicks(
      [
        { from: 540, to: 559, startPct: 1.6, endPct: -3.3 },  // 초반 하락 (실측: 09:30 -3.3%)
        { from: 559, to: 600, startPct: -3.3, endPct: -6.4 }, // 09:59 저점 -6.4%
        { from: 600, to: 645, startPct: -6.4, endPct: 2.4 },  // V반전 (10:45 +2.4%)
        { from: 645, to: 720, startPct: 2.4, endPct: 4.4 },   // 상승 지속 (12:00 +4.4%)
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 1.0, twiiChg: 0.9, hynixFrgn: -200_000, hynixInst: 250_000 },
    );
    const j = decide(ctx, ticks, 720, new Date().toISOString());
    const longOk = j.setups.long.verdict === "진입후보" || j.setups.long.verdict === "강한신호";
    check("7/3 실측", "전일 -14.6% + 무갭 → 09:59 저점 -6.4% → V반전 상승 (12:00 판정)", "V반등후보 + 레버리지 진입 후보",
      j, j.dayType === "V반등후보" && longOk,
      `dayType=${j.dayType}, 롱=${j.setups.long.verdict}(가점 ${j.setups.long.bonus})`,
      `DC1=${j.trend?.dc1 !== null && j.trend?.dc1 !== undefined ? (j.trend.dc1 * 100).toFixed(0) + "%" : "-"}`);
  }

  // ── 7/3 조기 반전 — 저점(09:59 -6.4%) 직후 10:10 시점: 지속 확인 전이지만 Bias 강함 + 반등 시작
  // → 1/3 비중 선진입 신호 (사용자 실전: -5% 반전 초입 진입 → +24%. 늦으면 수익이 줄어드는 문제 대응)
  {
    const daily = dailyWithMoves(2_650_000, [-3.4, -14.6]);
    const ctx = makeCtx({
      hynixDaily: daily,
      causeNonEarnings: true,
      consensusIntact: true,
      usdkrw: { level: 1440, changePercent: -0.4 },
      usRates: { changePp: -0.05, regime: "하락" },
      macroTrend: { rate5dPp: 0.12, usdkrw5dPct: 1.1 },
      macroSurprise: "easing",
      overnight: { nasdaqPct: 1.2, soxPct: 1.5 },
    });
    const ticks = makeTicks(
      [
        { from: 540, to: 559, startPct: 1.6, endPct: -3.3 },
        { from: 559, to: 600, startPct: -3.3, endPct: -6.4 }, // 09:59 저점
        { from: 600, to: 610, startPct: -6.4, endPct: -4.0 }, // 반등 시작 (+2.4%p)
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 1.0, twiiChg: 0.9 },
    );
    const j = decide(ctx, ticks, 610, new Date().toISOString());
    check("7/3 조기", "저점 직후 10:10 — 반등 +2.4%p 시작, 지속 확인 전", "조기 반전 감지 → 1/3 선진입 신호",
      j, j.dayType === "V반등후보" && j.crashContext.earlyRebound === true &&
        j.setups.long.verdict !== "진입후보" && j.setups.long.verdict !== "강한신호",
      `dayType=${j.dayType}, 조기=${j.crashContext.earlyRebound}, 롱=${j.setups.long.verdict}`,
      `Bias ${j.bias.dir} 강도${j.bias.strength}`);
  }

  // ── 6/25 — 전전일 -12.5% 폭락 후 갭 +11% (XS1 필수 사례 — 직전 누적 최악 실측 -11.6%)
  // crashCumPct -12였다면 XS1 미발동 → 인버스 진입 → 대참사(종가 +13.1%). 임계값 -11 조정 검증.
  {
    const daily = dailyWithMoves(2_450_000, [-12.5, 1.0]); // 6/23 -12.5%, 6/24 +1.0% → 2일 누적 -11.6%
    const ctx = makeCtx({
      hynixDaily: daily,
      usdkrw: { level: 1470, changePercent: 0.1 },
      usRates: { changePp: 0.01, regime: "안정" },
      overnight: { nasdaqPct: 1.0, soxPct: 1.8 },
    });
    const ticks = makeTicks(
      [{ from: 540, to: 590, startPct: 11.0, endPct: 12.0 }],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 0.8, twiiChg: 0.6 },
    );
    const j = decide(ctx, ticks, 590, new Date().toISOString());
    const xs1 = j.setups.short.blocked.some((b) => b.includes("XS1"));
    check("6/25", "전전일 -12.5% 폭락(누적 -11.6%) 후 갭 +11%", "인버스 XS1 차단 (임계값 -11 검증)",
      j, xs1 && j.setups.short.verdict === "차단",
      `dayType=${j.dayType}, 숏=${j.setups.short.verdict}, XS1=${xs1}`,
      `crash=${j.crashContext.cumPct?.toFixed(1)}%`);
  }

  // ── 6/17 — 갭 -2.0% → 초반 상승 전환 후 유지, 저가=시가 (실측: 장중 +8.0%)
  {
    const daily = dailyWithMoves(2_500_000, [-1, 0.5]); // 평범한 전일
    const ctx = makeCtx({ hynixDaily: daily });
    const ticks = makeTicks(
      [
        { from: 540, to: 555, startPct: -2.0, endPct: -1.0 },
        { from: 555, to: 615, startPct: -1.0, endPct: 2.8 },
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 0.8, twiiChg: 0.6, breadth: 0.78, hynixFrgn: 150_000 },
    );
    const j = decide(ctx, ticks, 615, new Date().toISOString());
    check("6/17", "갭 -2.0% → 초반 상승 전환 후 유지 (실측)", "추세일_상방 (레버리지 추세추종)",
      j, j.dayType === "추세일_상방",
      `dayType=${j.dayType}`,
      `T=${j.trend?.score.toFixed(1)}/${j.trend?.maxAvailable} · DC1=${j.trend?.dc1 !== null && j.trend?.dc1 !== undefined ? (j.trend.dc1 * 100).toFixed(0) + "%" : "-"}`);
  }

  // ── 장중 형성 추세 — 초반 왕복(T6 위반) 후 11:00부터 일방향 상승 (지연 추세 감지)
  {
    const daily = dailyWithMoves(2_500_000, [0.5, -0.3]);
    const ctx = makeCtx({ hynixDaily: daily });
    const ticks = makeTicks(
      [
        { from: 540, to: 552, startPct: 0.1, endPct: 0.7 },   // 초반 왕복 (전환 4회)
        { from: 552, to: 564, startPct: 0.7, endPct: -0.3 },
        { from: 564, to: 576, startPct: -0.3, endPct: 0.5 },
        { from: 576, to: 588, startPct: 0.5, endPct: -0.2 },
        { from: 588, to: 660, startPct: -0.2, endPct: 0.1 },  // 10시~11시 무방향 표류
        { from: 660, to: 750, startPct: 0.1, endPct: 3.2 },   // 11:00~12:30 일방향 상승 (재형성)
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 0.7, twiiChg: 0.5, hynixFrgn: 120_000 },
    );
    const j = decide(ctx, ticks, 750, new Date().toISOString());
    const okType = j.dayType === "추세일_상방";
    check("장중형성", "초반 왕복(전환 4회) → 11:00부터 일방향 상승 (12:30 판정)", "횡보일 해제 + 추세일_상방 (지연 추세)",
      j, okType && (j.trend?.midday?.active ?? false),
      `dayType=${j.dayType}, 재형성=${j.trend?.midday?.active}, grade=${j.trend?.grade}`,
      `창 DC1=${j.trend?.midday?.dc1 !== null && j.trend?.midday?.dc1 !== undefined ? (j.trend.midday.dc1 * 100).toFixed(0) + "%" : "-"} · 이동 ${j.trend?.midday?.movePct?.toFixed(1)}%`);
  }

  // ── 횡보일 (특이도 검증 — 오탐 1회가 정탐 2회 이익을 상쇄, 마스터 6장)
  {
    const daily = dailyWithMoves(2_500_000, [0.3, -0.4]);
    const ctx = makeCtx({ hynixDaily: daily });
    const ticks = makeTicks(
      [
        { from: 540, to: 552, startPct: 0.0, endPct: 0.6 },
        { from: 552, to: 564, startPct: 0.6, endPct: -0.4 },
        { from: 564, to: 576, startPct: -0.4, endPct: 0.5 },
        { from: 576, to: 588, startPct: 0.5, endPct: -0.3 },
        { from: 588, to: 615, startPct: -0.3, endPct: 0.4 },
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 0.1, twiiChg: -0.1 },
    );
    const j = decide(ctx, ticks, 615, new Date().toISOString());
    check("횡보일", "방향 전환 4회+ 왕복 장세", "횡보일 선언 — 추세 매매 금지",
      j, j.dayType === "횡보일",
      `dayType=${j.dayType}, 전환 ${j.trend?.flips}회`,
      `T6 위반 여부 검증`);
  }

  return results;
}
