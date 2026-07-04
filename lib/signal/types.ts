// M7 신호 시스템 — 공용 타입. 엔진(lib/signal/engine/*)은 이 타입만 입력받는 순수 함수로 구성해
// 실시간(data.ts)과 백테스트(backtest.ts)가 같은 판정 코드를 공유한다.

// ── 일봉
export type DailyBar = {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// ── 장중 틱 (signal_ticks 1행)
export type IntradayTick = {
  ts: string;                 // ISO
  minuteOfDay: number;        // KST 분 (09:00 = 540)
  futPx: number | null;
  futChg: number | null;
  k200Px: number | null;
  hynixPx: number | null;
  hynixChg: number | null;
  samsungPx: number | null;
  samsungChg: number | null;
  hynixFrgn: number | null;   // 외인 잠정 순매매량(주)
  samsungFrgn: number | null;
  hynixInst: number | null;   // 기관 잠정 순매매량 (L9)
  samsungInst: number | null;
  nikkeiChg: number | null;
  twiiChg: number | null;
  nqChg: number | null;
  breadth: number | null;
  basis: number | null;
};

// ── 장전 컨텍스트 (08:30 시점에 알 수 있는 것)
export type PremarketContext = {
  date: string;
  events: { label: string; binary: boolean; when: "당일" | "익일" }[]; // C1
  rebalance: "순풍" | "역풍" | "중립";                                  // C2
  usdkrw: { level: number | null; changePercent: number | null };       // C3
  usRates: { t10yChangePct: number | null; regime: "상승" | "안정" | "하락" | null }; // C4
  overnight: { nasdaqPct: number | null; soxPct: number | null };       // C5
  hynixDaily: DailyBar[];      // 최신이 마지막. NR7·ATR·누적낙폭·갭 계산용
  samsungDaily: DailyBar[];
  k200Daily: DailyBar[];       // KPI200 지수 (선물 일봉 프록시)
  frgn20dAvg: { hynix: number | null; samsung: number | null }; // 외인 20일 평균 순매매량(절대값)
  // 정성 판단 (daily_features에서 로드 — AI 자동 분석 또는 사용자 입력)
  consensusIntact: boolean | null;   // L8
  causeNonEarnings: boolean | null;  // L7
  qualSource: "ai" | "user" | null;  // 정성 판단 출처 (사용자 입력이 항상 우선)
};

// ── 축1 Bias
export type BiasResult = {
  dir: "상방" | "하방" | "중립";
  strength: 0 | 1 | 2 | 3;
  factors: { code: string; label: string; dir: "상방" | "하방" | "중립" | "미상"; detail: string }[];
};

// ── T-신호 개별 결과
export type TSignal = {
  code: string;            // T1~T8
  label: string;
  available: boolean;      // 데이터 부재 시 false (스코어 만점에서 제외)
  pass: boolean;
  dir: "UP" | "DOWN" | null; // 방향성 신호일 때
  weight: number;
  detail: string;
};

export type TrendResult = {
  signals: TSignal[];
  score: number;           // 충족 가중치 합
  maxAvailable: number;    // 가용 신호 가중치 합
  normalized: number;      // score / maxAvailable (0~1)
  grade: "추세일" | "약한추세" | "비추세" | "횡보일선언"; // T6 위반 = 횡보일선언 (장중 재형성 시 해제)
  dir: "UP" | "DOWN" | null;
  flips: number;           // T6 방향 전환 횟수 (09:00~10:00)
  // 장중 재형성(지연) 추세 — 최근 롤링 창(기본 90분) 기준. 초반 횡보 후 중반 형성 추세 감지.
  midday: { active: boolean; dir: "UP" | "DOWN" | null; dc1: number | null; movePct: number | null; flips: number | null } | null;
  dc1: number | null;      // 실시간 DC1 (10분봉)
  dc2: number | null;
  openType: "drive" | "test_drive" | "auction" | "undetermined" | null; // O1 (기록)
  openCrossCount: number | null;
  openMaxAdverse: number | null;
  extBonus: number;        // 확장 모듈 가점 (캡 적용 후)
  extNotes: string[];
};

// ── 정합성 (D1~D4)
export type DivergenceResult = {
  d1: { ok: boolean | null; detail: string };  // 니케이
  d2: { detail: string };                       // 나스닥 (기록만)
  d3: { ok: boolean | null; detail: string };  // 대만
  status: "정합" | "이탈" | "미상";
  routing: "추세유지" | "역발상검토" | null;   // D4 (원인 유무는 수동 주석 참조)
};

// ── 셋업 체크 항목
export type CheckItem = {
  code: string;
  label: string;
  kind: "필수" | "가점" | "금지";
  pass: boolean | null;    // null = 판정 불가(데이터 없음/수동 미입력)
  points: number;          // 가점 항목의 점수
  detail: string;
};

export type SetupResult = {
  long: { items: CheckItem[]; requiredOk: boolean; bonus: number; blocked: string[]; verdict: "차단" | "대기" | "진입후보" | "강한신호" };
  short: { items: CheckItem[]; requiredOk: boolean; bonus: number; blocked: string[]; verdict: "차단" | "대기" | "진입후보" };
};

// ── 리스크 수치 (R + A1)
export type RiskResult = {
  stopFixedPct: number;        // R1 -3
  stopAtrPct: number | null;   // A1: k×ATR14×배수 clamp (하닉 기준)
  atr14Pct: number | null;
  stopMode: "fixed" | "atr";
  trailPct: number;            // R2
  sizeGuide: string;           // R5·R7 비중 문구
  biasStrength: number;
  inverseCapPct: number;
  dailyLossLimitPct: number;
  closeExtendSuggested: boolean; // C1 (기록·표시 전용)
  notes: string[];
};

// ── 확장 모듈 기록값
export type ExtRecord = {
  nr7: boolean | null;
  nr4Ib: boolean | null;
  nr7Fut: boolean | null;      // KPI200 프록시
  breadth: number | null;
  breadthDivergence: number | null;
  distortionTag: boolean | null;
  basisZ: number | null;
  basisSlope: number | null;
  basisBlackout: boolean;      // 만기 주간 제외
  vkospiPeak: number | null;   // 소스 부재 — null
};

// ── 통합 판정
export type DayType =
  | "추세일_상방" | "추세일_하방" | "횡보일" | "V반등후보"
  | "역발상검토" | "이벤트보수" | "대기" | "관찰" | "마감";

export type Judgment = {
  date: string;
  ts: string;
  phase: "장전" | "관찰" | "판정" | "관리" | "마감";
  dayType: DayType;
  headline: string;            // 한 줄 요약
  action: string;              // 권장 행동
  bias: BiasResult;
  trend: TrendResult | null;   // 장전에는 null
  divergence: DivergenceResult | null;
  setups: SetupResult;
  risk: RiskResult;
  ext: ExtRecord;
  crashContext: { active: boolean; cumPct: number | null; detail: string }; // 분기1 (XS1 근거)
  dataNotes: string[];         // 미산출 신호 목록 등
};

// ── daily_features 행 (읽기용 부분 타입)
export type DailyFeatureRow = {
  date: string;
  dc1: number | null;
  dc2: number | null;
  day_return: number | null;
  gap: number | null;
  day_label: string | null;
  judgment_0930: string | null;
  judgment_1030: string | null;
  nr7_flag: boolean | null;
  open_type: string | null;
  breadth_10am: number | null;
  atr14_pct: number | null;
  stop_pct_used: number | null;
  cause_tag: string | null;
  cause_note: string | null;
  consensus_intact: boolean | null;
  cause_non_earnings: boolean | null;
  annotation_source: "ai" | "user" | null;
  ai_analyzed_at: string | null;
};
