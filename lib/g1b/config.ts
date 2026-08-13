// G1B 라이브 설정 — 정본 {SPEC_G1B v0.3 + SPEC_G1_OPT v0.2 + A1}. 충돌 시 A1 우선.
// pack_v1.0 (g1br/param_pack_v1.json, 커밋 d5da542)의 라이브 탑재본. 수동 변경 금지 (운영 수칙 §6).

export type G1BSymbol = "005930" | "000660";
export const G1B_SYMBOLS: G1BSymbol[] = ["000660", "005930"];

export const G1B_CONFIG = {
  // A1-2 챔피언 구조: 지수 I0 / 고유 S1 / β_mkt Huber. 초기 계수 = 오프라인 최종 추정치
  // (출처: WEEK2·3 인샘플 NW 표 + Huber 최근값 — 칼만이 매일 갱신하므로 출발값이다)
  init: {
    idx: { alpha: 0, b1_spx: 0.70 },
    idio: {
      "000660": { c_soxx: 0.256, c_peer: 0.120 },
      "005930": { c_soxx: 0.132, c_peer: 0.086 },
    },
    betaMkt: { "000660": 1.517, "005930": 1.316 },
  },
  // A1-3 라이브 출발 가중 (발주자 하향 보정: 삼전 reg 0.4 / 하닉 reg 0.6)
  // A1-5: 삼전 B1(SOXX 단독) 4번째 전문가 정식 편입 — 초기 0.1 (Hedge가 매일 재배분, 구현 재량 명시)
  hedgeInit: {
    "000660": { reg: 0.6, gx: 0.4 },
    "005930": { reg: 0.4, gdr: 0.4, gx: 0.1, b1: 0.1 },
  } as Record<G1BSymbol, Record<string, number>>,
  // A1-4 σ 체계: 확정 σ_base(%) + 이중 체계 (중심=σ배수 / 꼬리=경험 분위수)
  sigmaBase: {
    "000660": { normal: 2.359, event: 2.761, bigmove: 4.142 },
    "005930": { normal: 1.915, event: 1.887, bigmove: 2.830 },
  } as Record<G1BSymbol, Record<string, number>>,
  // G1-OPT §4 일간 학습 (상한은 헌법 계층)
  learn: {
    kalmanQ: 0.001,          // β 표류 분산 (파라미터 계층 — 월간 최적화 대상)
    kalmanClampSe: 0.5,      // 일일 β 변화 ≤ 정상 표준오차 0.5배 (헌법)
    ewmaLambda: 0.94,        // λ_σ (하한 0.90 헌법)
    biasLambda: 0.94,
    biasClampSigma: 0.3,     // |bias| ≤ 0.3σ (헌법)
    hedgeEta: 0.10,          // η_H (상한 고정)
    hedgeMaxW: 0.7,          // 단일 전문가 상한 (헌법)
    quantileWindow: 60,      // 꼬리 경험 분위수 롤링 창
  },
  // §4.2 σ 배수 임계 (v0.3)
  thresholds: {
    r1RemainHigh: 0.8, r1Wrong: -0.5, r2NoSignal: 0.7, r2Fire: 1.2, layer2Conflict: 1.5,
  },
  // 절단 시각 (KST) — 라이브판 룩어헤드 방지 (§1: 절단 후 도착 = late_arrival, 당일 사용 금지)
  cutoff: { r1: "07:15", r2: "08:52" },
  windows: {
    nightStart: "06:00", r1Publish: "07:20",
    morningStart: "08:00", r2Publish: "08:56",
    labelStart: "09:35", labelEnd: "10:30",
  },
  // 바스켓 (시간외 — 스펙 §3.2 v2 항, 시간외 SPY 대비 초과)
  ahBasket: {
    "000660": { MU: 0.5, NVDA: 0.5 },
    "005930": { NVDA: 0.34, MU: 0.33, AMD: 0.33 },
  } as Record<G1BSymbol, Record<string, number>>,
  regClose: { "000660": null, "005930": null } as Record<G1BSymbol, number | null>,
  // ZT 감시 (인프라 존치 — A1-1)
  ztMonitorMin: 0.90,
  // 드라이런 (T5): 연속 3영업일 정시 발행·치명 0·절단 위반 0 → D+0
  dryRunDays: 3,
} as const;
