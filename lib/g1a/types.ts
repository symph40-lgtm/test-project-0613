// G1A — 전일 갭 예측 모듈. 기획: SPEC_G1A_gap_forecast.md (v0.1)
// 로그 스키마는 스펙 §7과 키 이름을 맞춘다 (G1B·Q1 조인 대상).

export type G1ASymbol = "005930" | "000660";
export type Checkpoint = "T1" | "T2";
export type Direction = "UP" | "DOWN" | "FLAT" | "NEUTRAL";
export type Confidence = "High" | "Low" | null;
export type SizeBand = "S" | "M" | "L" | null;

// 각 피처의 방향 기여 s_i ∈ {-1, 0, +1}. null = 결측(조달 불가 또는 그날 데이터 없음).
export type FeatureSign = -1 | 0 | 1 | null;

export type G1AFeatures = {
  // A. 국내 당일 캐릭터
  F01_clv: number | null;          // 종가 위치 (C−L)/(H−L), 15:05 기준
  F02_dc1: number | null;          // 10분봉 동방향 지속률 −1~+1
  F03_n1: "NR7" | "NR4IB" | "inside" | null; // 변동성 압축 (크기 입력 전용)
  F04_o1: "OD_up" | "OD_down" | "OTD" | "OA" | null; // 시가 유형
  // B. 수급/구조
  F05_w1: number | null;           // 시장 폭 — 미조달
  F06_v1: boolean | null;          // VKOSPI 피크아웃 — 미조달
  F07_b1_z: number | null;         // 선물 베이시스 z — 미조달
  F08_frn_decel: number | null;    // 외인 감속률
  F09_c1: string | null;           // 레버리지 ETF 리밸런싱 — 미조달
  // C. 아시아 세션 글로벌
  F10_nq_asia: number | null;      // NQ 선물 아시아 세션 수익률 %
  F11_tsmc: number | null;         // TSMC 당일 %
  F12_asia_idx: number | null;     // 니케이·가권 평균 %
  F13_ust10y_bp: number | null;    // 미 10Y 간밤 변화 bp
  F14_usdkrw: number | null;       // 원/달러 장중 %
  // D. 이벤트/포지셔닝
  F15_event: string | null;        // 당일 밤 바이너리 이벤트
  F16_implied_move: number | null; // 미조달
  F17_pos_extreme: boolean | null; // 미조달
  // T2 추가
  F20_europe: number | null;
  F21_us_pre_semi: number | null;
  F23_nxt_after: number | null;
};

export type G1AVerdict = {
  direction: Direction;
  confidence: Confidence;
  size: "1/3" | "1/6" | "0";
  sizeBand: SizeBand;              // 갭 크기 예측 S/M/L
  abstainReason: string | null;
  gapScore: number;
  groups: { character: number; flow: number; global: number; positioning: number };
  missingCore: string[];
};

export type G1ALabels = { L1: number | null; L2: number | null; L3: number | null };

export type G1ALogRow = {
  date: string;
  checkpoint: Checkpoint;
  symbol: G1ASymbol;
  features: G1AFeatures;
  gap_score: number;
  verdict: G1AVerdict;
  report_sent_at: string | null;
  labels_posthoc: G1ALabels;
  outcome: { hit: boolean | null; luck_flag: boolean; postmortem: string };
};
