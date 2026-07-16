// 대가 방법론 예측 모델 — 파라미터. 근거는 docs/predict-models-spec.md 각 절.

export const PREDICT_CONFIG = {
  symbol: "000660", // SK하이닉스 본주 (레버리지/인버스 ETF의 기초)
  // 확정 판정 창 끝 (v1.4, 2026-07-16): 10:30 → 14:00. 220일 실측 피셔 64.3%(방향 62.2%)로
  // 10:30(52.7%/57.9%)보다 우수, 14:00→종가 경제성도 +13.0%p 흑자. M7 판정 확정 14:00과 정렬.
  judgeHour: "140000",
  // 체크포인트 판정 스케줄 (사용자 지정 2026-07-16): 08:30 첫 판정 → 30분마다 → 14:00 확정.
  // 사이 구간은 모니터링 — 판정 변경 시 revisions 기록 + 문자.
  schedule: {
    checkpoints: ["08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00"],
    earlyModelBefore: "09:30", // 이전 체크포인트는 user(RV1+T6)가 판정자 — 프리마켓 유일 유효 신호 (피셔는 0회)
    preWindowBefore: "10:30", // 이전 체크포인트는 08:00(NXT 프리마켓) 창, 이후는 09:00 창 (실측 최적)
  },
  sms: { enabled: true }, // 판정 변경 문자 — dispatch 공용 경로 (일시정지·조용일 정책 자동 적용)
  // 판정 모드 (사용자 확정 2026-07-16): 220일×3종목 검증에서 앙상블(균등·리프트 가중 모두)이
  // 피셔 단독을 넘지 못해 최종 판정은 피셔 단독. 나머지 4개 모델은 대조군으로 계속 채점만.
  judgeMode: "fisher" as "fisher" | "ensemble",
  primaryModel: "fisher" as const,
  label: {
    trendMinPct: 1.2, // 시가→종가 최소 등락
    posUp: 0.65, // 종가 위치 — 상승 추세일은 고가권 마감
    posDown: 0.35,
  },
  crabel: {
    stretchLookback: 10,
    baseConf: 0.55,
    nr7Bonus: 0.15,
    nr4ibBonus: 0.1,
    earlyBonus: 0.1, // 09:30 이전 돌파
    earlyCutoff: "09:30",
    maxConf: 0.9,
  },
  raschke: {
    gapAtrRatio: 0.4, // |갭| ≥ 0.4×ATR14%
    openPosMax: 0.25, // E3: 시가가 아침 레인지 하위 25%
    lastPosMin: 0.75,
    pullbackMax: 0.4, // E4: 되돌림 ≤ 아침 레인지 40%
    minScore: 2,
    narrowRangeAtrRatio: 0.5, // 아침 레인지 < 0.5×ATR → 횡보 증거
  },
  fisher: {
    orMinutes: 15, // 시초 레인지 09:00~09:15
    offsetRangeRatio: 0.15, // 오프셋 = 0.15 × 10일 평균 일중폭
    confirmMinutes: 8, // A 확인: OR의 절반
    reversalMinutes: 5, // C 철회
    earlyConfirmBy: "09:45",
  },
  dalton: {
    vaBinWon: 500, // 하닉 호가 단위
    vaPct: 0.7, // 가치영역 70%
    driveMinPct: 0.4, // O1 규칙 재사용 (ext-modules 2.2)
    testMaxPct: 0.3,
    auctionCrosses: 3,
    openTypeWindowEnd: "09:30",
    acceptCheck: "10:00", // VA 밖 수용 확인 시각
  },
  grimes: {
    smaLen: 20,
    slopeDays: 5,
    pullbackMinDaysFromHigh: 2,
    pullbackAtrDist: 1.0, // 전일 종가가 SMA20 ± 1×ATR 이내
    highLookback: 10,
  },
} as const;
