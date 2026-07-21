// 일봉 스윙 예측 — 공용 타입. 기획: docs/predict-daily-spec.md
// 기존 lib/signal·lib/predict와 완전 분리 — 서로 import하지 않는다.

export type Stance = "long" | "short" | "flat";

export type DailyBar = {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// 판정 시점에 아는 매크로 (간밤 미국장·전일 환율) — 표시용 + 게이트(10Y 급등·DXY 급등만 실측 통과)
export type MacroSnap = {
  sox: number | null; // 간밤 SOX %
  fxLevel: number | null; // 환율 레벨
  fxChg: number | null; // 전일 환율 %
  y10: number | null; // 미 10Y 레벨
  y10Chg: number | null; // 전일 미 10Y 변화 %p
  wti: number | null; // WTI 유가 레벨 (표시 전용 — 게이트 실측 기각: 종목 간 상반)
  wtiChg: number | null; // 간밤 WTI %
  dxy: number | null; // 달러인덱스 레벨
  dxyChg: number | null; // 간밤 DXY % (게이트: ≥+0.8% 급등 시 감산)
  newsRisk?: number | null; // 뉴스 위험도 0~10 (AI, 표시·라이브 채점 전용 — 게이트 아님)
  newsNote?: string | null; // 핵심 위험 요인 한 줄
};

export type DailyJudgment = {
  stance: Stance;
  baseExposure: number; // 사다리 기본 비율 0~1 (게이트 전)
  exposure: number; // 게이트 반영 후
  votes: number; // 타 모델 투표합 (돈치안·와일더·와인스타인·엘더, long=+1/short=-1)
  gates: string[]; // 적용된 감산 사유 (예: "10Y급등", "이벤트:FOMC")
  stopPx: number | null; // 손절가 (보유 비중 있을 때)
  stopPct: number; // 변동성 연동 손절폭 (2.5×ATR, 6~12% 클램프)
  closePx: number;
  modelStances: Record<string, Stance>; // 7모델 스냅샷
  stUp: boolean; // 수퍼트렌드(10,3) 상승 여부 — 단기 장세 표기·삼전 브레이크
  dd: number; // 52주 고점 대비 낙폭 (음수, 장세 표기)
  midVote: number; // 중장기 투표합 −3~+3 (와인스타인·골든크로스·엘더조류) — 표기·재진입 가속
};

export type PredictDailyRow = {
  date: string;
  symbol: string;
  stance: Stance;
  exposure: number;
  base_exposure: number;
  model_stances: Record<string, Stance> | null;
  macro: MacroSnap | null;
  flow: { date: string; frgn: number; inst: number }[] | null; // 최근 외인·기관 수급 (표시·기록용)
  gates: string[] | null;
  event: string | null;
  stop_px: number | null;
  close_px: number | null;
  revisions: { at: string; stance: Stance; exposure: number }[] | null;
  label_r1: number | null;
  label_r3: number | null;
  correct1: boolean | null;
  correct3: boolean | null;
  source: string;
};
