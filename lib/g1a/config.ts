// G1A v0.3 설정 — specs/SPEC_G1A_gap_forecast.md §4~5. 초기값은 전부 log-only 60일 재조정 전제.
// BiasGate·그룹 캡·s_i 표준화는 v0.2 §5.1 원 정의 (2026-08-09 복원본 확보 — specs/SPEC_G1A_gap_forecast_v0.2.md).

import type { G1ASymbol } from "./types";

export const G1A_CONFIG = {
  // §3 라벨 방향 분류 (L1' 기준)
  label: { flatBand: 0.3 },

  // §4.1 잔여갭 중심 식 — 바스켓 가중과 β_pm 초기값
  // β_pm 초기 = "정규장 β 준용" (스펙). 실측 근거: 밤 정보→시가 회귀계수 b (2026-08-08 실측,
  // factor-quant 세션 — SOX→하닉 0.97·삼전 0.77)를 준용한다. G1B-R에서 재추정 예정.
  basket: {
    "000660": { weights: { MU: 0.5, NVDA: 0.3, SOXL: 0.2 }, soxlDiv: 3, betaPm: 0.97 },
    "005930": { weights: { NVDA: 1 / 3, MU: 1 / 3, AMD: 1 / 3 }, soxlDiv: 3, betaPm: 0.77 },
  } as Record<G1ASymbol, { weights: Record<string, number>; soxlDiv: number; betaPm: number }>,

  // §4.2 방향 판정 피처 가중치 (스펙 표 그대로)
  weights: {
    F21: 2.0, F22: 1.0, F20: 0.5, F11p: 0.5,          // L1 근접대리
    F01: 0.75, F02: 0.5, F04: 0.25, F09: -0.25,        // L2 당일 캐릭터
    F08: 0.5, F05: 0.25, F07: 0.25,                    // L3 수급
    F13: 0.5, F14: 0.5,                                // L4 매크로 (합산 캡 아래)
    F24cap: 1.0,                                       // 저녁 뉴스 상한 ±1 (수동)
  },

  // s_i 표준화 (v0.2 §5.1.1): 연속 피처는 20일 z-score → tanh, [−1,+1].
  // 로그 20일 축적 전에는 아래 σ 상수를 분모로 쓴다(사전 신념) — 축적 후 롤링 z로 전환 예정.
  scales: {
    basketPct: 0.7,      // 프리마켓 바스켓 % 1σ 근사
    usfutPct: 0.3,
    europePct: 0.5,
    tsmcResidPct: 0.8,
    tsmcRawPct: 1.0,     // T1용 원수익률
    nqAsiaPct: 0.4,      // T1용
    clvHalfWidth: 0.35,  // s = (CLV−0.5)/0.35 → 0.85≈+1
    dc1: 0.5,
    frnDecel: 1.0,
  },
  // 크기 유의성 임계 (§5.1-3 트리거 조건용 — 표준화와 별개)
  thresh: { basketPct: 0.5 },

  // BiasGate (v0.2 §5.1.1 원 정의): 매크로 사슬 합성(F13+F14 감쇠 z 합, 갭 방향 기준)이
  // 가산부 Σ와 일치 ×1.25 / |합성 z| < 0.5 중립 ×1.0 / 충돌 ×0.5.
  // "매크로 필터가 인트라데이 시그널에 우선"의 점수화 — Gate 0.5면 High 등급 구조적 불가(의도).
  biasGate: { agree: 1.25, neutral: 1.0, conflict: 0.5, neutralBand: 0.5 },

  // 그룹 캡 (v0.2 §5.1.2 — 이중계상 차단)
  caps: { l1T2: 3.5, l1T1: 2.5, l2: 2.0, l3: 1.5, l4: 1.0 },

  // T1 스냅샷 가상 GapScore 가중 (v0.2 §5.1.2 T1 열 — 기록 전용, §7)
  weightsT1: { F11_raw: 1.5, F10_nq: 1.0, F01: 1.0, F02: 0.75, F04: 0.5, F09: -0.25, F08: 0.75, F05: 0.5, F07: 0.5, F13: 0.5, F14: 0.5 },

  // §5.3 시간 가변 임계값 θ(t) — KST 시각 경계
  theta: [
    { until: "18:30", high: 6.0, low: 3.0 },
    { until: "19:20", high: 5.5, low: 2.75 },
    { until: "19:40", high: 5.0, low: 2.5 },
  ],

  // §5.1 조기 트리거 조건
  trigger: {
    minPmObsMin: 30,          // 프리마켓 관측 ≥30분
    minEuObsMin: 30,          // 유럽 개장 ≥30분
    minDcPm: 0.6,             // DC-PM ≥60%
    minBasketAbs: 0.5,        // |r_basket| ≥0.5%
    minEconomicsPct: 0.3,     // 예상잔여갭 − 왕복비용 ≥ +0.3%
  },

  // §5.1-6 경제성 — 왕복비용 구성 (%). 스프레드 실측 전 기본값 사용 (§5.4 실측 재조정 전제)
  cost: {
    feesRoundTrip: 0.02,      // 국장 수수료 0.01%×2 (기존 매매 수수료 원칙)
    sellTax: 0.15,            // 증권거래세(코스피 현물 매도)
    slippageBuffer: 0.1,
    defaultSpread: 0.1,       // 스프레드 미측정 시 보수 기본값
  },

  // §5.4 NXT 유동성 게이트 (스프레드 %)
  liquidity: { normalMax: 0.10, downgradeMax: 0.20 },

  // §5.5 반전 감시
  reversal: { dcPmCollapse: 0.4, watchUntil: "19:55" },

  // §5.2 최종 판정 시각·감시 창
  windows: {
    t1Start: "15:05", t1End: "15:25",
    t2Start: "16:30", t2Final: "19:40", t2End: "19:55",
    labelStart: "09:05", labelEnd: "10:30",
    slotMinutes: 10,          // T2 평가 격자
  },

  // §5.6 판정 보류 — 캘린더류 (자동 판정 가능분)
  abstain: {
    circuitBreakerPct: -8,    // KOSPI 일중 프록시 (v0.1 실측 검증됨 — 반사실 검정 통과 유일 규칙)
    // 미 휴장·반일장 (2026 잔여 + 2027 초입 — 연 1회 갱신, eventCalendar 유지보수 원칙과 동일)
    usHolidays: ["2026-09-07", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18"],
    usHalfDays: ["2026-11-27", "2026-12-24"],
    // 한국 공휴일 (연휴 전일 판정용, 2026 잔여 — 주말 제외 평일만)
    krHolidays: ["2026-09-24", "2026-09-25", "2026-10-05", "2026-10-09", "2026-12-25"],
    // MSCI 분기 리뷰 효력일 (추정 — 8월/11월 마지막 영업일 기준, 확정 공시 시 갱신)
    msciRebalance: ["2026-08-31", "2026-11-30"],
  },

  // §5.6-7 핵심 피처 (결측 2개 이상 → abstain)
  coreFeatures: ["F21_basket", "F22_usfut", "F01_clv", "F02_dc1"] as const,

  // §5.3 사이징 — 삼전+하닉 동시 신호 시 합산 상한 1/3 (신규 신호를 1/6로 강등)
  jointExposureCap: true,

  // TSMC 잔차 β (당일 TSMC ~ 전일밤 SOXX) 초기값
  tsmcBetaSoxx: 1.0,
} as const;

// 미조달 피처 — 소스 확보 시 제거 (스펙 §8 데이터 가용성 감사와 연동)
export const G1A_UNAVAILABLE_V03 = {
  F05_w1: "시장 폭 히스토리·실시간 소스 없음",
  F07_b1_z: "KOSPI200 선물 베이시스 소스 없음 (KIS 야간선물 시세는 있으나 z 산출용 이력 없음)",
  F09_c1: "레버리지 ETF 리밸런싱 방향 — 추정 프록시 미채택",
  F16_implied_move: "미 옵션 체인 접근 경로 미확정 (스펙 §8)",
  F17_pos_extreme: "포지셔닝 극단 소스 없음",
  spread: "NXT 호가 API 미구현 (KIS 래퍼에 호가 함수 없음) — 스프레드 결측 기록, §5.4 게이트는 'unknown'",
} as const;
