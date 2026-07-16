// 대가 방법론 예측 모델 — 공용 타입. 기획: docs/predict-models-spec.md (v1.0)
// 기존 M7(lib/signal)과 완전 분리 — 여기서 lib/signal을 import하지 않는다.

export type Verdict = "leverage" | "inverse" | "none";

export const MODEL_IDS = ["crabel", "raschke", "fisher", "dalton", "grimes", "user"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const MODEL_LABELS: Record<ModelId, string> = {
  crabel: "크레이블 (수축+시가돌파)",
  raschke: "라쉬케 (추세일 증거)",
  fisher: "피셔 (ACD A·C지점)",
  dalton: "달튼 (가치영역+시가유형)",
  grimes: "그라임스 (레짐+풀백)",
  user: "사용자 (RV1+T6)",
};

export type PredictDailyBar = {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// 완성된 1분봉. time은 봉 시작 시각 "HH:MM" (KIS stck_cntg_hour 규칙 — "09:00" 봉은 09:01에 완성)
export type MinuteBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// 모델 입력 — 미래 정보 차단: 일봉은 전일까지, 분봉은 판정 시각(10:30) 직전 완성봉까지
export type DayInput = {
  date: string;
  dailyHistory: PredictDailyBar[]; // 오래된 → 최신(전일). 최소 60개 권장
  openPx: number; // 당일 공식 시가
  morning: MinuteBar[]; // 09:00~10:29 완성봉, 시간순
  prevDayMinutes: MinuteBar[] | null; // 전일 전체 1분봉 (달튼 가치영역). 없으면 해당 모델이 보수 판정
};

export type ModelOutput = {
  model: ModelId;
  verdict: Verdict;
  confidence: number; // 0~1
  reason: string;
};

export type DayLabelResult = {
  label: Verdict;
  rOC: number; // 시가→종가 %
  pos: number; // 종가의 레인지 내 위치 0~1
};

// 채점된 날들의 성적 + 분포 — 리프트(우연 대비 초과) 가중치 산출에 분포가 필요
export type AccuracyStat = {
  correct: number;
  total: number;
  verdicts: Record<Verdict, number>; // 모델의 판정 분포
  labels: Record<Verdict, number>; // 같은 날들의 실제 라벨 분포
};

export function emptyStat(): AccuracyStat {
  return {
    correct: 0,
    total: 0,
    verdicts: { leverage: 0, inverse: 0, none: 0 },
    labels: { leverage: 0, inverse: 0, none: 0 },
  };
}

export type EnsembleResult = {
  finalVerdict: Verdict;
  strengthPct: number; // 최종 판정의 점수 비중 %
  scores: Record<Verdict, number>;
  weights: Record<ModelId, number>; // 사용된 평활 정확도
};
