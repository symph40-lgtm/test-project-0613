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
  // 판정 변경 문자 — dispatch 공용 경로 (일시정지·조용일 정책 자동 적용).
  // ruleReminder: 실투자 초기 규칙 환기 문구 동봉 (사용자 지정 2026-07-17 "당분간" — 몸에 배면 false로)
  sms: { enabled: true, ruleReminder: true },
  // 애프터장 판정 (사용자 지정 2026-07-20) — NXT 애프터마켓 15:30~20:00, 하닉 "본주 전용"
  // (레버리지·인버스 ETF 미운영). 판정자 피셔 단독. 상수는 세션 스케일 초기값 — 미검증,
  // 라이브 채점으로 보정 예정. 오프셋 = offsetDayRangeRatio × 당일 정규장 레인지.
  after: {
    checkpoints: ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30"],
    finalCp: "19:30", // 확정 (세션 종료 20:00 전 30분 여유)
    offsetDayRangeRatio: 0.15,
    label: { trendMinPct: 0.6, posUp: 0.65, posDown: 0.35 }, // 정규장(±1.2%)의 절반 스케일
  },
  // 체크포인트 시각별 방향적중 사전값 (%) — 220일 백테스트 실측 기반 (스펙 3.1·3.2절).
  // "그 시각의 판정은 그 시각의 적중률로" (사용자 지정 2026-07-20) — 라이브 슬롯 표본이
  // 20회 이상 쌓이면 라이브 값이 이 사전값을 대체한다. 08:30은 판정 희소로 미상(—).
  // 11:00~13:30은 측정점(10:30 58 · 12:00 57 · 14:00 62) 사이 보간 근사.
  checkpointPriors: {
    "08:30": null, "09:00": 44, "09:30": 49, "10:00": 50, "10:30": 58,
    "11:00": 57, "11:30": 57, "12:00": 57, "12:30": 58, "13:00": 59, "13:30": 60, "14:00": 62,
  } as Record<string, number | null>,
  // 시초 레인지(OR 09:00~09:15) 폭별 피셔 방향적중 — 220일 실측 (14:00 창 기준, 사용자 지정 2026-07-20
  // "유사한 기존 사례 기준 정확도 표기"). ≥4%는 저신뢰 구간 경고 대상 (발생 11/220일, 적중 43%).
  orBuckets: {
    wideMinPct: 4, // 이 이상이면 광폭 레인지 경고
    hit: { calm: 62, mid: 68, wide: 43 }, // <2% / 2~4% / ≥4%
  },
  // 신호별 권장 스탑 (220일 실측, 2026-07-16 사용자 확정 — 스펙 3.2절):
  // 선행형(산·골 시가 진입)은 타이트 스탑이 노이즈컷 유발(21/32회) → ATR 0.7배.
  // 확인형(피셔)은 역행 자체가 확인 실패 증거 → 고정 ETF -3%가 최적 (+18.5→+43.6%p).
  stops: {
    earlySwing: { mode: "atr" as const, k: 0.7, minPct: 1.5, maxPct: 4 }, // 본주 % 기준
    fisher: { mode: "fixed" as const, etfPct: 3 }, // ETF 기준 -3% (본주 -1.5%)
  },
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
