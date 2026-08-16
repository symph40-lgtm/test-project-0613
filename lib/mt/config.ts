// MT 등록 상수 — 스펙 SPEC_MT_v04.md의 수치는 전부 여기 모은다.
// 변경은 §4.2 월간 재캘리브레이션 절차(1회 ≤30%·15일 섀도)로만. 임의 수정 금지.

// ⚠ 부품 구성 동결 v0.4.2 (발주자 판정 2026-08-16 §4): 부품·투표 자격·배선은 이 파일 상태로 고정.
//   이후 개선은 라이브 전진 검증만. 월간 재캘리브레이션(§4.2)은 라이브 축적분(mt_days.labels)으로만 가동 — 3년 소급 표본은 IC에 쓰지 않는다.
export const MT_ENGINE_VER = "mt-v0.4.2"; // 재설계 패키지(v0.4.1, docs/mt-redesign-prereg.md) + 안정성 진단 반영·동결

export const MT_CONFIG = {
  symbols: ["005930", "000660", "KOSPI200"] as const,

  // §1.1 국면 판별
  phase: {
    tau: 0.5,                 // softmax 온도
    slopeWindow: 20,
    rvShort: 20,
    rvLong: 60,
    posWindow: 60,
    priorWindow: 60,
    newExtremeLookback: 10,   // 최근 10일 내 20일 신고·신저 발생 여부
    squeezeIn: 0.85,
    squeezeOut: 1.20,
    zClip: 3,
  },

  // §1.4 투표 (전환 선언 전용 — 톤 값과 경로 분리)
  vote: {
    fillThreshold: 0.6,       // 발주자 보충 §1.4-1a
    byAvailable: { 4: 3, 3: 2, 2: 2 } as Record<number, number>, // 가용 ≤1 = 판정 유보
    // 후보 유지창: "후보 + 가격 확인"에서 둘이 같은 날일 필요는 없다 (발주서 §1.4는 동일일을 요구하지 않음).
    // 증거가 먼저 쌓이고 가격이 뒤늦게 확인하는 것이 정상 순서다. 동일일만 인정하면 3년 확정 4건으로
    // 사실상 작동 불능 — 2026-08-15 3년 소급 실측. 창 0 = 동일일 전용(원 구현).
    confirmWindow: 10,
  },

  // §3.1 톤 (연속 가중합 — 게이트·내성 판정용)
  tone: {
    inertia: { S1: 0, S2: 0.3, S3: 0, S4: -0.3 },
    evidence: { S1: 0.7, S2: 0.7, S3: -0.7, S4: 0.7 },
    strengthWeak: 0.2,
    strengthStrong: 0.5,
  },

  // §3.3 박스 — 2026-08-16 재설계 패키지 (docs/mt-redesign-prereg.md)
  //   R2 눈금 통일: 상·하단은 **종가** 기준 (비교 대상이 종가이므로)
  //   D1 폭 문턱: 고정 % → 변동성 상대값 (20일 폭 ≤ kBox × RV20의 20일 환산)
  //   R3 대체 순서: 20일 무효 → 20일 종가 고·저 (60일 박스는 표시 병기만 — 가격 확인 기준선에서 제외)
  box: {
    n20: { window: 20 },
    n60: { window: 60, maxWidth: 0.30 },   // 표시 전용
    kBox: 2.5,
    basis: "close" as const,
  },

  // R1 (H3) 가격 확인 방향 = 후보를 세운 패널이 정한다 (발주서 §1.4 원문 복원 — phase.top 의존 제거)
  confirm: { dirSource: "panel" as const },

  // R4 C3·C5·C7 배선 (재료 보강 — 부품 수 동결 유지)
  wire: {
    C3: { S2_3: 0.3, S3_4: 0.3 },                     // fill = 0.7×기존 + 0.3×CLV항
    C5: { streakMin: 3, bonus: 0.15 },                 // S1_2 매수 연속 / S3_2 매도 연속
    C7: { S1_4: { at: 0.9, mult: 1.2 }, S3_3: { at: 0.95, mult: 1.2 } },
  },

  // 발주자 승인 5건 (2026-08-16 부검 판정) — 투표 경로 반영
  approved: {
    c1GradesForVote: ["A", "B"] as const,              // C1 등급 A/B 한정 활성화 — 등급 C 날은 파생 4부품 결측
    c1Parts: ["S1_1", "S2_4", "S3_1", "S4_2"] as readonly string[],
    wolfParts: ["S1_1", "S1_3", "S3_1", "S4_2", "S4_3"] as readonly string[], // 늑대소년 — 단독 1표 자격 박탈 (0.5표)
    wolfVote: 0.5,
    // 반쪽 안정성 진단 (docs/mt-stability.md, 사전 등록 "한쪽만 lift>1 → 0.25표 추가 강등") — 부품별 투표 가중 확정값.
    // 미기재 = 기본(늑대소년 0.5 / 그 외 1). "1표인데 양쪽 미달" 4건(S1_2·S1_4·S2_1·S3_4)은 사전 등록 밖 범주라 상신만, 미반영.
    voteWeightOverride: { S1_3: 0.25, S4_2: 0.25, S2_2: 0.75, S2_3: 0.75, S2_4: 0.75 } as Record<string, number>,
    // "1표인데 양쪽 미달" 4건 — 발주자 판정 2026-08-16: 강등 보류, 1표 유지 + unstable 플래그(화면 "안정성 미검증").
    // 사유: 늑대소년과 달리 해로움 미증명 · S1_4는 눈금 교정 후 성적 부재. 최종심은 코스피200 전수 검증(MT-CS)으로 이송.
    unstableParts: ["S1_2", "S1_4", "S2_1", "S3_4"] as readonly string[],
  },

  // §2 C1 반응비대칭
  c1: {
    betaWindow: 60,           // β_SOX 롤링 회귀 표본
    betaMinN: 40,
    betaFloor: 0.3,
    betaCap: 3.0,
    betaFallback: { "005930": 1.0, "000660": 1.3, KOSPI200: 0.7 } as Record<string, number>,
    minJustifiedAbs: 0.3,     // |정당화 반응| < 0.3% = 재료 없는 날 (배율 발산 방지)
    ratioClip: 5,             // 반응배율 윈저화 ±5 — 분모가 작은 날의 극단값이 중앙값·표시를 흔들지 않게
    window: 10,               // 패널이 보는 최근 N일
    surpriseSens: 1.0,        // A등급 민감도 초기값 (컨센서스 입력 스키마 확정 시 갱신)
  },

  // §2 B등급 재료 방향 사전 (규칙 기반·재현 가능 — AI 호출 없음. 오분류율로 자기채점된다)
  lexicon: {
    good: ["둔화", "기대감", "개선", "호조", "강세", "완화", "서프라이즈", "사상 최대", "반등", "훈풍",
      "상향", "수주", "증설 수혜", "회복", "진정", "부재", "우세", "낙관"],
    bad: ["우려", "악화", "부진", "급락", "규제", "공급과잉", "경계", "리스크", "충격", "제재",
      "관세", "긴축", "매도", "하향", "위축", "불확실", "차익실현", "약세"],
  },

  // §1.2 패널 부품 파라미터
  panel: {
    volWindow: 10,            // 상승일·하락일 거래량 비교 창
    volWindowLong: 20,
    ftd: { minDay: 4, maxDay: 7, minGainPct: 1.5, lowWindow: 20 },
    gap: { window: 10, target: 2 },
    utad: { window: 20, returnDays: 2, target: 2 },
    sc: { volMult: 2.0, bodyPct: -2.0, reboundPct: 1.0, window: 10, reboundDays: 2 },
    peakout: { window: 10, dropRatio: 0.15 },
    breadthFloor: 0.45, breadthSpan: 0.20,
    rsFloor: -2, rsSpan: 6,
  },

  // §1.5 역신호
  reverse: {
    fakeBreakoutDays: 2,
    fakeFtdDays: 5,
    springDays: 3,
  },

  // §4.1 라벨
  label: {
    horizonDays: 5,
    flatBandPct: 0.5,         // |5일 수익률| < 0.5% = 무방향
  },

  // §4.2 재캘리브레이션 제약
  recal: {
    maxChangeRatio: 0.30,
    icFloor: 0.05,
    shadowDays: 15,
    pairCorrAlert: 0.7,       // 발주자 보충 §1.4-3 이중계상 감지
    pairCorrMonths: 2,
  },
} as const;

export const MT_NAME: Record<string, string> = {
  KOSPI200: "코스피200", "005930": "삼성전자", "000660": "하이닉스",
};

export const PART_NAMES: Record<string, string> = {
  S1_1: "악재 무반응", S1_2: "No Supply(하락일 거래량 고갈)", S1_3: "확인일 FTD", S1_4: "기반 상단 돌파",
  S2_1: "갭 전진 지속", S2_2: "눌림 거래량 수축", S2_3: "폭·주도 유지", S2_4: "호재 반응배율 ≥1",
  S3_1: "호재 냉담", S3_2: "Wyckoff 분산", S3_3: "상방 돌파 실패(UTAD)", S3_4: "주도주 이탈",
  S4_1: "셀링 클라이맥스", S4_2: "악재 반응배율 정점 통과", S4_3: "변동성 피크아웃",
};

export const PHASE_NAMES: Record<string, string> = {
  S1: "바닥권", S2: "상승 추세", S3: "천장권", S4: "하락 추세",
};
