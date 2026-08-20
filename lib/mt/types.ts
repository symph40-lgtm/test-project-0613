// MT (시장 톤/에너지) 타입 — 기획: specs/SPEC_MT_v04.md
// 로그 스키마는 스펙 §7과 키를 맞춘다. null = 결측(소스 미조달 또는 시점상 미가용).

export type MtSymbol = "KOSPI200" | "005930" | "000660";
export type PhaseKey = "S1" | "S2" | "S3" | "S4";

export type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

// ── 국면 판별층 (스펙 §1.1)
export type PhaseInputs = {
  slope20: number | null; z: number | null; flat: number | null;
  squeeze: number | null; hh10: 0 | 1 | null; ll10: 0 | 1 | null;
  pos60: number | null; r60: number | null; rv20: number | null; rv60: number | null;
};
export type PhaseState = {
  P: Record<PhaseKey, number>;   // 확률 (합 1) — 단정 금지, 항상 확률 표기
  top: PhaseKey;
  inputs: PhaseInputs;
};

// ── 패널 (스펙 §1.2) — 부품은 0~1 연속 충족도 (발주자 보충 §1.4-1a)
export type PartFill = {
  key: string;                 // S1_1 …
  name: string;                // 화면 표기명
  fill: number | null;         // 0~1 (null = 가용 불가)
  available: boolean;
  detail: string;              // 산출 근거 한 줄 (화면 병기용)
};
export type PanelState = {
  parts: PartFill[];
  vote: number;                // fill ≥ 0.6 인 부품 수
  threshold: number | null;    // 결측 축소 규칙 반영 (null = 판정 유보)
  candidate: boolean;          // 전환 후보
  fillAvg: number | null;      // 연속 가중합 경로 (톤 값 전용 — 투표와 분리)
};

// ── 상시 부품 (스펙 §1.3)
export type C1Grade = "A" | "B" | "C" | null;
export type C1Day = {
  date: string;
  grade: C1Grade;
  materialDir: -1 | 0 | 1;     // 재료 방향
  justified: number | null;    // 정당화 반응 %
  actual: number | null;       // 실반응 %
  ratio: number | null;        // 반응배율 (윈저화 ±ratioClip 적용값)
  raw: number | null;          // 윈저화 전 원값 (발주자 8/20 밤 §3ⓐ — 클리핑 밤 원시값 보존·표시)
  clipped: boolean;            // 윈저화 발동 여부
  excluded: boolean;           // |정당화| < 0.3% → 재료 없는 날
  note: string;
};
export type CommonParts = {
  C1: { ratio: number | null; grade: C1Grade; materialDir: -1 | 0 | 1; justified: number | null; excluded: boolean; beta: number | null; raw?: number | null; clipped?: boolean };
  C2_vol_asym: number | null;
  C3_clv20: number | null;
  C4_breadth_or_rs: number | null;
  C5_flow: { streak: number | null; decel: number | null } | null;
  C6_squeeze: number | null;
  C6_peakout: number | null;
  C7_high52: number | null;
  c4_source: "breadth" | "rs" | null;   // AUDIT §3 — 어느 쪽으로 산출했는지 기록
};

// ── 박스 (스펙 §3.3)
export type BoxSide = { high: number; low: number; valid: boolean; widthPct: number };
export type BoxState = { n20: BoxSide; n60: BoxSide; primary: 20 | 60 | null; positionPct: number | null };

// ── 톤 (스펙 §3.1)
export type ToneState = {
  mt: number;                  // [-1, +1]
  direction: "상승 에너지" | "하락 에너지" | "중립";
  strength: "약" | "중" | "강";
  byPhase: Record<PhaseKey, number>;
};

// ── 전환·역신호 (스펙 §1.4·§1.5)
export type ReverseEvent = { date: string; kind: "가짜돌파" | "가짜확인일" | "Spring"; detail: string };
export type TransitionState = {
  candidate: PhaseKey | null;
  confirmed: boolean;
  from: PhaseKey | null;
  to: PhaseKey | null;
  priceConfirm: string | null;
  /** 오늘 가격 확인(상단 돌파/하단 이탈)이 성립했는가 — 후보 유지창 적용의 입력 */
  priceOk: boolean;
  /** 오늘 성립한 가격 확인의 방향들 (R1: 후보 패널이 자기 방향을 고른다 — 유지창은 여기서 방향을 읽는다) */
  priceUp: boolean;
  priceDown: boolean;
  /** 후보+가격확인까지 갔으나 역신호(가짜 돌파)로 확정이 막힌 날 — §5.2 "역신호가 오탐을 몇 건 걸렀는지"의 원천 */
  blockedByReverse: boolean;
  reverseLog: ReverseEvent[];
  votesAdjust: Partial<Record<PhaseKey, number>>; // 역신호가 가산한 표
};

export type MtLabels = {
  dir5d: { mt_sign: number; ret5d: number | null; hit: boolean | null } | null;
  gate: { t2_dir: string | null; agree: boolean | null; hit: boolean | null } | null;
  resilience: { event: string | null; abs_gap: number | null; mt_sign: number } | null;
};

export type MtDay = {
  date: string;
  symbol: MtSymbol;
  phase: PhaseState;
  panels: Record<PhaseKey, PanelState>;
  common: CommonParts;
  box: BoxState;
  tone: ToneState;
  transition: TransitionState;
  labels: MtLabels | null;
  meta: { engine_ver: string; mode: "live" | "backfill" | "retro"; missing: string[] };
};
