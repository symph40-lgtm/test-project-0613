// M7 신호 시스템 — 전 파라미터 단일 소스.
// 마스터 스펙 v2.4의 임계값 + 확장기획서 8.3 초기값. "고정 상수가 아니라 최적화 대상"(2.5.6)이므로
// 여기 값만 바꾸면 엔진 전체에 반영된다. 확장 모듈은 스펙 원칙대로 기본 OFF (A1 stop_mode만 fixed 기본).

export const SIGNAL_CONFIG = {
  // ── 세션 시간 (KST 분 단위, 09:00 = 540)
  session: {
    premarketMin: 8 * 60 + 30,   // 08:30 장전 브리핑
    openMin: 9 * 60,             // 09:00 개장
    observeEndMin: 9 * 60 + 30,  // 09:30 관찰 종료 (진입 금지 구간 끝)
    entryEndMin: 13 * 60 + 30,   // 13:30 신규 진입 마감 (L4 — 원 스펙 10:30에서 사용자 요청으로 연장)
    closeDecideMin: 14 * 60 + 50,// 14:50 C1 마감 증폭 판정
    exitMin: 15 * 60,            // 15:00 당일 청산 (R3)
    endMin: 15 * 60 + 30,        // 15:30 장 마감
  },

  // ── 2축 정렬·셋업 임계값
  // crashCumPct: 스펙 초기값 -12 → -11로 조정 (2026-07-04 실측 검증: XS1 필수 사례인 6/25의
  // 직전 1~3일 누적 최악이 -11.6%라 -12 기준으론 인버스 차단이 미발동. 스펙 7.2 튜닝 범위 -8~-15 내)
  crashCumPct: -11,        // L6/XS1 과대 낙폭 (직전 1~3일 누적)
  overheatCumPct: 15,      // S1 5일 누적 과열
  overheatDays: 2,         // S1 연속 상승일
  gapBigPct: 2,            // X1 갭상승 시초 추격 금지 기준
  usdkrwHigh: 1500,        // C3 환율 절대 수준 경계

  // ── L5 외인 수급 3요소 (종목 단위 대체 — plan.md 편차 2)
  foreign: {
    lookbackDays: 20,      // 일평균 산출 구간
    paceMaxRatio: 1.2,     // ③상대강도: 당일 매도 페이스 ≤ 20일 평균의 1.2배
    bufferPct: 10,         // 잠정치 오차 버퍼 ±10% (마스터 5장)
  },

  // ── 추세일 판별 (T-스코어)
  trend: {
    // 가중치 (마스터 4.3). T2는 VWAP 대신 TWAP 근사.
    // 2026-07-09 사용자 개정: T6(스윙 구조) 점수화 +2, T8(외인 현물·프로그램 흐름 재정의, "중요") 1→2
    weights: { T1: 3, T2: 2, T3: 1, T4: 3, T5: 1, T6: 2, T7: 2, T8: 2 } as Record<string, number>,
    fullMax: 16,
    confirmRatio: 8 / 13,  // 추세일 확정: 가용 만점 대비 이 비율 이상
    weakRatio: 5 / 13,     // 약한 추세 (1/3 비중, 트레일링 -2%)
    t2SideRatio: 0.8,      // TWAP 편측 시간 비율 ≥ 80%
    t3PullbackMax: 0.4,    // 되돌림 40% 미만
    t6MaxFlips: 2,         // (구) 5분봉 방향 전환 표시용 — 횡보 판정에는 더 이상 사용 안 함 (2026-07-09)
    orbMin: 30,            // Opening Range 구간 (분)
    t1HoldMin: 30,         // T1: 레인지 밖 연속 유지 시간 (장중 이탈도 포착)
    // ── T6 재정의 (2026-07-09 사용자 개정): 5분봉 전환 횟수 → 스윙 고점·저점(산·골) 연결선.
    // 고점2+저점2 연결선이 같은 방향이면 추세, 다르면 3점(부족하면 4점) 연결선의 지향 방향으로 판단.
    // 4점까지 봐도 불일치·평탄이면 횡보. 판단은 13:30(entryEndMin)까지 매 틱 재평가. "변동성의 추세".
    swing: {
      minAmpPct: 0.2,      // 지그재그 피벗 확정 최소 반전폭 (가격 대비 %)
      tolPct: 0.15,        // 고점선·저점선 '같은 높이(평탄)'로 볼 허용 오차 (가격 대비 % — 선물 호가 노이즈)
    },
    // T4·T8 수급 기울기 판정 (KIS 연동 2026-07-09) — 최근 30분 누적 순매수 변화 (억원)
    t4MinDelta30: 500,     // 외인 선물: 30분 ±500억 이상이면 방향 인정
    t8MinDelta30: 150,     // 외인 현물·프로그램: 30분 ±150억 이상이면 개선/악화
    // 장중 재형성(지연) 추세 — 초반 횡보 후 중반부터 방향이 형성되는 날 감지 (사용자 요청)
    midday: {
      windowMin: 90,       // 롤링 재평가 창
      dc1Theta: 0.6,       // 창 내 DC1 기준 (전일 기준보다 높게 — 5분봉 전환에 맞춰 0.65→0.60 보정)
      minMovePct: 1.0,     // 창 내 순이동 최소 % — 미세 드리프트 오탐 방지
      minBars: 12,         // 창 내 봉 최소 개수 (5분봉 12개 = 60분 데이터 확보)
    },
  },

  // ── DC (방향 지속률) — θ·봉 주기는 최적화 대상 파라미터 (스펙 2.5.6 그리드: 55/60/65/70% × 5/10/15분)
  // 2026-07-05 사용자 결정: 10분봉 → 5분봉 (판정 확정 최소 대기 30분 → 15분).
  // 봉이 잘아지면 노이즈 봉 비율이 늘어 같은 추세일도 DC1·DC2가 낮게 나오므로 임계값 비례 보정
  // (10분봉 60%/0.30 → 5분봉 55%/0.25). 실데이터 축적 후 Stage 3에서 재탐색.
  dc: {
    barMin: 5,             // 5분봉
    dc1Theta: 0.55,        // DC1 55%
    dc2Min: 0.25,          // 효율비 0.25
  },
  // ── DC 라벨링 (학습 데이터 구분 전용 — 장후 배치의 day_label 확정에만 사용)
  // 사용자 결정(2026-07-05): 판정 보조는 5분봉, "추세일이었는가"의 학습 라벨은 스펙 원값(10분봉 60%) 유지.
  // 라벨 기준을 흔들지 않아야 과거·미래 데이터가 같은 잣대로 비교된다.
  dcLabel: {
    barMin: 10,            // 10분봉
    dc1Theta: 0.6,         // DC1 60%
    dc2Min: 0.3,           // 효율비 0.30
  },

  // ── 스코어 컷 (마스터 4.1·4.2)
  // 2026-07-09 사용자 개정: L8(이익 컨센서스) 가점 제거 → 롱 만점 11→9,
  // S5(디커플링) 가점 제거 → 숏 만점 5→3. (컨센서스는 XS2 차단 판단에는 계속 사용)
  score: {
    longBonusMax: 9,
    longCandidate: 5,      // 진입 후보 (1/3 비중)
    longStrong: 8,         // 강한 신호
    shortBonusMax: 3,
    shortCandidate: 2,
  },

  // ── 리스크 (R1~R8)
  risk: {
    stopPct: 3,            // R1 고정 스탑 -3%
    trailPct: 4,           // R2 트레일링 -4% (설정 변경 가능)
    weakTrailPct: 2,       // 약한 추세일 타이트 트레일링
    inverseMaxPct: 5,      // R5 인버스 총자산 상한 (고확신 10)
    inverseHighConvPct: 10,
    dailyLossLimitPct: 1,  // R6 계좌 -1%
  },

  // ── 확장 모듈 (확장기획서 8.3 — 기본 전부 OFF, 값은 매일 기록)
  ext: {
    n1: { enabled: false, lookback: 7, nr4Lookback: 4, requireBoth: false },
    o1: { enabled: false, driveMin: 0.004, testMax: 0.003, crossLimit: 3, windowMin: 30 },
    b1: { enabled: false, zThreshold: 1.0, lookbackDays: 20, expiryBlackoutDays: 3, smoothMin: 3 },
    w1: { enabled: false, trendTh: 0.7, distortionBand: [0.45, 0.55] as [number, number], discount: 0.5 },
    v1: { enabled: false, peakoutDrop: 0.05, holdMin: 30, crashPrereq: -0.03 },
    a1: { stopMode: "fixed" as "fixed" | "atr", k: 0.7, kTrail: 0.9, minStop: 0.03, maxStop: 0.08 },
    c1: { enabled: false, dc1Min: 0.55, indexMoveMin: 0.03, extendTo: "15:15" }, // dc1Min은 dc.dc1Theta와 동조
    bonusCapRatio: 0.3,    // 8.5 확장 가점 합산 ≤ T-스코어 총점의 30%
  },

  // ── 장중 급변 알림 (당일 등락률 단계 돌파 시 문자+이메일, 단계별 1일 1회. 장중 전체 감시)
  moveAlert: {
    stockLevels: [3, 5, 7, 10],  // 하닉·삼전 ±% (전일 종가 대비 절대 등락률)
    // 코스피200 선물 ±% — 0.7 등간격, 폭락일 대비 9.8까지 연장 (2026-07-07 -4.2 이후 -8.7까지
    // 무알림이었던 문제 수정 — 사용자 피드백 2026-07-08)
    futLevels: [0.7, 1.4, 2.1, 2.8, 3.5, 4.2, 4.9, 5.6, 6.3, 7.0, 7.7, 8.4, 9.1, 9.8],
    // 장중 반락·반등(스윙) 알림 — 당일 극값 대비 스텝 등간격, '극값이 갱신되면 재무장'(에피소드 리셋).
    // 2026-07-08 사용자 피드백: 저점이 깊어진 뒤의 새 반등에 낮은 단계가 이미 소진돼 알림이 늦었음
    // (저점 -8.7 → -5.8에서야 문자). 이제 저점이 스텝 이상 갱신될 때마다 반등 단계가 다시 열린다.
    futSwingStep: 0.7,    // 선물: 저점(고점) 대비 0.7%p마다
    stockSwingStep: 1.5,  // 하닉·삼전: 1.5%p마다 (사용자 확정 — 하닉 반등 1.5%p에 1차 문자)
    // 반전으로 인정할 반대편 극값 최소치(%) — 고점이 이보다 낮으면 단순 일방향 하락(절대 단계가 커버)
    swingMinExtreme: 0.3,
  },

  // ── 외인·프로그램 수급 반전 알림 (사용자 지정 2026-07-09) — 코스피 외국인 현물·프로그램 누적
  // 순매수(KIS, 억원)가 당일 극값 대비 스텝 이상 되돌아오면 문자. 순매도 중이라도 감속(반등)이면
  // 매수기회, 순매수 중이라도 감속(반락)이면 매도기회 관찰. 스윙 알림과 같은 에피소드 재무장 방식.
  //
  // 임계값 이원 구조 (사용자 지정 2026-07-09 2차): 아래 정적 값은 실측 표본이 모이기 전의
  // 폴백이고, 표본이 calib.minDays 이상 쌓이면 flowCalib이 매일 아침 실측 분포로 자동 보정한다
  // (T4·T8 기울기 = |Δ30분| 상위 분위수, 반전 스텝 = 당일 진폭 중앙값 × 비율).
  // 민감도는 낮추되(작은 반전도 감지) 대량 발송은 상한·쿨다운이 차단한다.
  flowAlert: {
    frgnStep: 800,    // 외인 코스피 현물: 극값 대비 800억 반전마다 (폴백)
    prgmStep: 800,    // 프로그램 (차익+비차익): 800억 (폴백)
    minSpan: 300,     // 반전으로 인정할 선행 되돌림 최소치 (억원) — 미세 등락 오탐 방지
    maxPerSeriesPerDay: 4, // 시리즈(외인·프로그램)별 1일 문자 상한 — 대량 발송 방지
    cooldownMin: 15,       // 같은 시리즈 연속 문자 최소 간격 (분)
    calib: {
      lookbackDays: 20,    // 실측 분포 산출 구간 (거래일)
      minDays: 5,          // 이 일수 미만이면 폴백 값 사용
      minTicksPerDay: 60,  // 하루를 표본으로 인정할 최소 틱 수
      deltaQuantile: 0.75, // T4·T8 기울기 기준 = |Δ30분| 분포의 상위 25% 경계
      stepSpanRatio: 0.2,  // 반전 스텝 = 당일 진폭(고-저) 중앙값 × 0.2
      t4Clamp: [200, 2000] as [number, number],  // 보정값 안전 범위 (억원)
      t8Clamp: [80, 800] as [number, number],
      stepClamp: [300, 2000] as [number, number],
    },
  },

  // ── 거래량 급증 알람 (사용자 지정 2026-07-08) — 하닉 5분봉 거래량이 당일 평균의 ratio배 이상이면 문자.
  // 30분 창 안에서 연속 발생 시 최대 maxPerWindow건까지만 (최초 + 1건 추가).
  volumeAlert: {
    ratio: 1.3,
    minBars: 3,       // 당일 평균을 낼 최소 완성 5분봉 수 (개장 직후 오탐 방지)
    windowMin: 30,
    maxPerWindow: 2,
  },

  // ── 장중 진입 브리핑 (사용자 지정 2026-07-10) — 개장 후 고정 체크포인트 8회, 이후 추세
  // 전환·감속·판정 변경 시 즉시 + 없어도 60분마다 정기. 판정·수급 + 지표 9종(미2Y·10Y·환율·
  // WTI·K200선물·닛케이·SOXX·나스닥선물·S&P선물)을 직전 브리핑 값 대비 변화율과 함께 장문(LMS).
  // 기울기 기준 시계열은 K200 선물 등락률(FKS200). 스펙 부록 B 2026-07-10.
  entryBrief: {
    checkpoints: [1, 3, 5, 10, 15, 20, 30, 50], // 개장(09:00) 후 분
    checkpointGraceMin: 10, // 유예 — 수집이 늦게 시작되면 지난 체크포인트는 건너뛰고 최신 것만
    hourlyMin: 60,          // 정기 발송: 직전 브리핑 후 경과 분
    changeCooldownMin: 15,  // 전환·감속 브리핑의 직전 브리핑 대비 최소 간격 (분)
    slopeWindowMin: 30,     // 추세 기울기 창 — 최근 30분 등락률 변화 (%p)
    minSlopePct: 0.15,      // 전환 인정 최소 기울기 (양쪽 모두)
    decelBasePct: 0.3,      // 감속 판정 — 직전 브리핑 기울기 최소치
    decelRatio: 0.5,        // 현재 기울기가 직전의 이 비율 이하면 감속
  },

  // ── RV1 하닉 분봉 모멘텀 판정 (사용자 지정 2026-07-07 — 조건 성립 시 즉시 진입신호 문자)
  // 추세·반전 여부와 무관하게, 아래 중 하나라도 성립하면 그 방향으로 판정 (사용자 확정 3차:
  // "계속 변동하는 상황에서 추세를 조건으로 하는 것은 제약"). 상승=레버리지 / 하락=인버스.
  // 임계값 %p (전일 종가 대비 등락률 차).
  reversal: {
    m1Single: 0.8,  // 1) 1분봉 1개 ≥ 0.8%
    m1Sum3: 1.0,    // 2) 1분봉 3개 합 ≥ 1.0%
    m1Sum5: 1.5,    // 3) 1분봉 5개 합 ≥ 1.5%
    m5Single: 1.0,  // 4) 5분봉 1개 ≥ 1.0%
    m5Sum3: 2.2,    // 5) 5분봉 3개 합 ≥ 2.2%
    m5Sum5: 2.7,    // 6) 5분봉 5개 합 ≥ 2.7%
    m5Sum7: 3.2,    // 7) 5분봉 7개 합 ≥ 3.2%
    trendLookbackMin: 30, // 직전 흐름 표기용 (문자의 "직전 ±x%p" — 판정엔 미사용)
    // 발송 정책 (사용자 확정 2026-07-07): 같은 방향(추세)은 하루 최대 3회(최초 + 추가 2회).
    // 반복 사이 최소 간격(분) — [1차→2차, 2차→3차] 순. 조건은 수 분간 연속 성립하므로
    // 간격 없이는 1분 연속 3통이 됨. (사용자 확정: 10분 → 5분)
    maxPerDirPerDay: 3,
    repeatCooldownMins: [10, 5],
  },

  // ── 대상 종목·상품 배수
  symbols: {
    hynix: "000660",
    samsung: "005930",
    leverageMultiple: 2,   // 국내 2배 ETP 기준 (A1 스탑 계산)
  },
} as const;

// C1 이벤트 캘린더 — 월 1회 수동 갱신 (YYYY-MM-DD). 마스터 5장 "수동 월 1회 입력" 방식.
export const EVENT_CALENDAR: { date: string; label: string; binary: boolean }[] = [
  { date: "2026-07-03", label: "NFP 고용보고서", binary: true },
  { date: "2026-07-09", label: "선물옵션 만기(쿼드러플위칭 아님)", binary: false },
  { date: "2026-07-14", label: "미 CPI", binary: true },
  { date: "2026-07-28", label: "FOMC (7/28~29)", binary: true },
  { date: "2026-07-29", label: "FOMC 결과 발표", binary: true },
  { date: "2026-07-30", label: "삼성전자 2분기 실적(확정)", binary: true },
];

// C2 리밸런싱 월 판정 (마스터 2.1)
export function rebalanceMonthBias(month: number): "순풍" | "역풍" | "중립" {
  if ([1, 4, 7, 10].includes(month)) return "순풍";   // 분기 첫째 달
  if ([2, 5, 8, 11].includes(month)) return "역풍";   // MSCI 리밸런싱 월
  if ([3, 6, 9, 12].includes(month)) return "역풍";   // 분기말
  return "중립";
}

// B1 만기 주간 판정 — 선물옵션 만기(매월 둘째 목요일) D-3 이내면 베이시스 판정 제외
export function isExpiryBlackout(date: Date, blackoutDays = 3): boolean {
  const y = date.getFullYear();
  const m = date.getMonth();
  // 둘째 목요일 계산
  const first = new Date(y, m, 1).getDay(); // 0일~6토
  const firstThu = 1 + ((4 - first + 7) % 7);
  const secondThu = new Date(y, m, firstThu + 7);
  const diff = (secondThu.getTime() - date.getTime()) / 86400000;
  return diff >= 0 && diff <= blackoutDays;
}
