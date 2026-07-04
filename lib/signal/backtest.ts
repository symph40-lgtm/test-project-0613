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
    usRates: { t10yChangePct: -0.3, regime: "안정" },
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

  // ── 6/9 — 이틀 -17% 후 갭 +7.3% (V반등, 인버스 진입 시 대참사)
  {
    const daily = dailyWithMoves(2_900_000, [-9, -8.8]); // 이틀 누적 약 -17%
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

  // ── 6/12 — 반등 랠리 후 갭 +8.6% → 초반부터 하락 (페이드 → 인버스)
  {
    const daily = dailyWithMoves(2_400_000, [6, 5, 4]); // 3연속 상승 +15%대 (과열)
    const ctx = makeCtx({
      hynixDaily: daily,
      usdkrw: { level: 1490, changePercent: 0.5 },
      usRates: { t10yChangePct: 1.2, regime: "상승" },
      overnight: { nasdaqPct: -0.8, soxPct: -1.2 },
    });
    const ticks = makeTicks(
      [{ from: 540, to: 615, startPct: 8.6, endPct: 2.5 }], // 갭+8.6% 후 일방향 하락
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: -0.6, twiiChg: -0.5 },
    );
    const j = decide(ctx, ticks, 615, new Date().toISOString());
    check("6/12", "과열 랠리 후 갭 +8.6% → 초반부터 하락 지속", "추세일_하방 (인버스 추세추종)",
      j, j.dayType === "추세일_하방",
      `dayType=${j.dayType}`,
      `T=${j.trend?.score.toFixed(1)}/${j.trend?.maxAvailable} · DC1=${j.trend?.dc1 !== null && j.trend?.dc1 !== undefined ? (j.trend.dc1 * 100).toFixed(0) + "%" : "-"}`);
  }

  // ── 6/23 — 5연속 상승 +28% 후 전쟁 악재, 초반부터 일방향 하락 (장중 -11.8%)
  {
    const daily = dailyWithMoves(2_200_000, [5, 5, 6, 5, 4]); // 5연속 상승
    const ctx = makeCtx({
      hynixDaily: daily,
      usdkrw: { level: 1500, changePercent: 0.8 },
      usRates: { t10yChangePct: 0.9, regime: "상승" },
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

  // ── 7/3 — 전일 폭락, 갭 -2.8% → 초반 추가 하락 후 반전 상승 지속 (성공사례 원형)
  {
    const daily = dailyWithMoves(2_800_000, [-4, -10]); // 직전 누적 약 -14%
    const ctx = makeCtx({
      hynixDaily: daily,
      causeNonEarnings: true,
      consensusIntact: true,
      usdkrw: { level: 1440, changePercent: -0.4 },
      usRates: { t10yChangePct: -1.5, regime: "하락" },
      overnight: { nasdaqPct: 1.2, soxPct: 1.5 },
    });
    const ticks = makeTicks(
      [
        { from: 540, to: 572, startPct: -2.8, endPct: -5.2 }, // 초반 추가 눌림
        { from: 572, to: 630, startPct: -5.2, endPct: 3.5 },  // 반전 후 일방향 상승
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 1.0, twiiChg: 0.9, hynixFrgn: -200_000, hynixInst: 250_000 },
    );
    const j = decide(ctx, ticks, 628, new Date().toISOString());
    const longOk = j.setups.long.verdict === "진입후보" || j.setups.long.verdict === "강한신호";
    check("7/3", "전일 폭락 + 갭 -2.8% → 반전 후 상승 지속(10:28)", "V반등후보 + 레버리지 진입 후보",
      j, j.dayType === "V반등후보" && longOk,
      `dayType=${j.dayType}, 롱=${j.setups.long.verdict}(가점 ${j.setups.long.bonus})`,
      `DC1=${j.trend?.dc1 !== null && j.trend?.dc1 !== undefined ? (j.trend.dc1 * 100).toFixed(0) + "%" : "-"}`);
  }

  // ── 6/17 — 갭 소폭 하락 → 초반 상승 전환 후 유지 (상승 추세일)
  {
    const daily = dailyWithMoves(2_500_000, [-1, 0.5]); // 평범한 전일
    const ctx = makeCtx({ hynixDaily: daily });
    const ticks = makeTicks(
      [
        { from: 540, to: 555, startPct: -0.5, endPct: 0.3 },
        { from: 555, to: 615, startPct: 0.3, endPct: 3.8 },
      ],
      { futPrevClose: 400, hynixPrevClose: daily[daily.length - 1].close, nikkeiChg: 0.8, twiiChg: 0.6, breadth: 0.78, hynixFrgn: 150_000 },
    );
    const j = decide(ctx, ticks, 615, new Date().toISOString());
    check("6/17", "갭 소폭 하락 → 초반 상승 전환 후 유지", "추세일_상방 (레버리지 추세추종)",
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
