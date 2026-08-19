// G1A v0.3 — 저녁 갭 판정 모듈 타입. 기획: specs/SPEC_G1A_gap_forecast.md v0.3 (T2 중심 재편)
// v0.1 타입은 전면 교체됨 (발주자 지시 2026-08-09). 로그 스키마는 스펙 §10과 키를 맞춘다.

export type G1ASymbol = "005930" | "000660";
export type Direction = "UP" | "DOWN" | "NEUTRAL";
export type Confidence = "High" | "Low" | null;

// T2 피처 (스펙 §4.2 계층 구조). null = 결측(소스 미조달 또는 시점상 미가용).
export type T2Features = {
  // L1 근접대리
  F21_basket: number | null;       // 미 프리마켓 바스켓 수익률 %
  F21_dcpm: number | null;         // DC-PM 동방향 비율 0~1 (F21 확인 조건)
  F21_obs_min: number | null;      // 프리마켓 관측 경과(분)
  F22_usfut: number | null;        // 미 선물 16:00 KST 이후 변화 %
  F20_europe: number | null;       // 유럽 개장 후 변화 %
  F20_obs_min: number | null;      // 유럽 개장 경과(분)
  F11p_tsmc_resid: number | null;  // TSMC 잔차 (당일 수익률 − β·전일밤 SOXX) %
  // L2 당일 캐릭터
  F01_clv: number | null;
  F02_dc1: number | null;
  F04_o1: "OD_up" | "OD_down" | "OTD" | "OA" | null;
  F09_c1: number | null;           // 미조달 → null
  // L3 수급
  F08_frn_decel: number | null;    // 외인 감속률 (마감 확정치)
  F05_w1: number | null;           // 미조달
  F07_b1_z: number | null;         // 미조달
  // L4 매크로 (합산 캡 ±1.0)
  F13_rate_z: number | null;       // 미 2Y/10Y 선물(글로벡스) 당일 Δ z (금리↑=역풍)
  F14_fx_z: number | null;         // 원/달러 당일 Δ z (원화 약세=역풍)
  F24_news: number | null;         // 수동 입력 전용 — 자동 파이프라인은 null
  // 잔여갭·실행 요소 (§4.1·§5.4)
  r_nxt: number | null;            // 당일 NXT 애프터에서 이미 반영된 수익률 % (차감항)
  nxt_last_px: number | null;      // NXT 최근 체결가 (가상 진입가 원천)
  spread_pct: number | null;       // NXT 스프레드 % — KIS 호가 API 부재로 현재 결측 (스펙 §8 미확정)
};

export type AbstainCheck = { reason: string | null; detail?: string };

export type T2Verdict = {
  direction: Direction;
  confidence: Confidence;
  size: "1/3" | "1/6" | "1/12" | "0";   // 1/12 = E-Low (헌법 개정 발효 2026-08-20)
  abstain_reason: string | null;
  gap_score: number;
  bias_gate: number;               // ×0.5 / ×1.0 / ×1.25
  theta_applied: number | null;    // 트리거 시점 θ
  dc_pm: number | null;
  r_basket: number | null;
  r_nxt_pre_entry: number | null;
  expected_residual_gap: number | null; // 예상잔여갭 − 비용 반영 전 원값 %
  economics_pass: boolean | null;  // §5.1-6
  three_way_agree: boolean | null; // §5.1-4
  liquidity: "normal" | "downgrade" | "hold" | "unknown";
  // 이벤트 밤 4등급제 (헌법 발효 2026-08-20)
  event_night?: string | null;
  e_grade?: "E-Low" | "E-Lean" | "E-Flat" | "E-Hold" | null;
  e_low_checks?: { theta5: boolean; im_lt_1_5x: boolean | null; positioning_ok: boolean | null } | null;
};

export type T2State = {
  trigger_type: "E" | "F" | null;  // E=조기, F=19:40 최종
  trigger_time: string | null;     // HH:MM:SS KST
  entry_px_virtual: number | null; // log-only: 트리거 시점 NXT 최근가
  verdict: T2Verdict | null;
  reversal_watch: { fired: boolean; time: string | null; action: string | null };
  evals: { time: string; gap_score: number; blocked_by: string | null }[]; // 10분 슬롯별 평가 궤적
  report_r1: string | null;        // T2 리포트 텍스트 (발송은 로그만 — sms_pause·NM_ONLY)
};

export type T1Snapshot = {
  taken_at: string;
  gap_score_virtual: number | null;
  features: Record<string, number | string | boolean | null>;
};

export type G1ALabels = {
  L1p: number | null;              // 주 라벨: 진입가→D+1 KRX 시가 %
  L1: number | null;               // 종가→시가 %
  L2: number | null;               // 진입가→NXT 프리 첫 체결 %
  L3: number | null;               // 시가→시가+30분 %
  capture_ratio: number | null;    // L1'/L1
};

export type G1ARow = {
  date: string;                    // 판정일 (저녁 D — 라벨은 D+1)
  symbol: G1ASymbol;
  t1_snapshot: T1Snapshot | null;
  t2: T2State | null;
  labels: G1ALabels | null;
  outcome: { hit: boolean | null; luck_flag: boolean; postmortem: string } | null;
};
