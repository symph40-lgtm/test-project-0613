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

// 판정 시점에 아는 매크로 (간밤 미국장·전일 환율) — 표시용 + 10Y 게이트
export type MacroSnap = {
  sox: number | null; // 간밤 SOX %
  fxLevel: number | null; // 환율 레벨
  fxChg: number | null; // 전일 환율 %
  y10: number | null; // 미 10Y 레벨
  y10Chg: number | null; // 전일 미 10Y 변화 %p
};

export type DailyJudgment = {
  stance: Stance;
  baseExposure: number; // 게이트 전 주식화 비율 0~1
  exposure: number; // 게이트 반영 후
  gates: string[]; // 적용된 감산 사유 (예: "10Y급등", "이벤트:FOMC")
  stopPx: number | null; // 손절가 (매수 시)
  closePx: number;
  modelStances: Record<string, Stance>; // 7모델 스냅샷
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
