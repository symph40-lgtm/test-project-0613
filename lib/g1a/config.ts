// G1A 설정 — 스펙 §3(라벨), §5.1(가중), §5.2(판정 테이블), §5.3(판정 보류).
// 초기값은 전부 "60일 로그로 전면 재조정 전제"라고 스펙에 명시돼 있다. 실측 전까지 손대지 않는다.

export const G1A_CONFIG = {
  // §3 라벨 — FLAT 밴드 ±0.3%는 초기값 (스펙 §10-1: 갭 분포 실측 후 조정)
  label: { flatBand: 0.3, sizeS: 0.3, sizeM: 0.8, sizeL: 1.5 },

  // §5.1 그룹별 합산 상한
  caps: { character: 3, flow: 2, global: 3, positioning: 1 },

  // 피처별 임계 (s_i를 −1/0/+1로 이산화하는 값)
  thresh: {
    clvHigh: 0.7, clvLow: 0.3,      // F01
    dc1: 0.2,                        // F02 동방향 지속률
    nqAsia: 0.3,                     // F10 %
    tsmc: 1.0,                       // F11 %
    asiaIdx: 0.5,                    // F12 %
    ust10yBp: 4,                     // F13 bp (상승=기술주 역풍)
    usdkrw: 0.3,                     // F14 % (원화 약세=역풍)
    frnDecel: 0.5,                   // F08 20일 평균 대비 비율
  },

  // §5.2 판정 테이블
  verdict: { highAbs: 4, lowAbs: 2 },

  // §5.3-5 데이터 결측 판정 보류의 '핵심 피처'
  // 스펙은 "핵심 피처 2개 이상"이라고만 하고 목록을 정하지 않았다. 조달 가능한 것 중
  // 당일 캐릭터 2개 + 글로벌 2개를 핵심으로 둔다 (미조달 F16·F17을 넣으면 전일 보류가 된다).
  coreFeatures: ["F01_clv", "F02_dc1", "F10_nq_asia", "F11_tsmc"] as const,

  // §5.3-4 서킷브레이커 프록시 — KOSPI 일중 낙폭 기준 (실제 CB는 지수 8%·1분 지속)
  circuitBreakerPct: -8,
} as const;

// 미조달 피처 — 백테스트·라이브 모두 null. 소스 확보 시 여기서 지운다.
export const G1A_UNAVAILABLE = {
  F05_w1: "KOSPI 상승/하락 종목수 히스토리 소스 없음",
  F06_v1: "VKOSPI — 네이버 fchart 미지원(빈 응답 확인)",
  F07_b1_z: "KOSPI200 선물 베이시스 히스토리 소스 없음",
  F09_c1: "레버리지 ETF 리밸런싱 방향 — 추정 프록시만 가능, 미채택",
  F16_implied_move: "미국 옵션 체인 접근 경로 미확정 (스펙 §10-2 미해결)",
  F17_pos_extreme: "PB 익스포저 백분위·옵션 스큐 소스 없음",
} as const;
