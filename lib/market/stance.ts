// 10단계 매매 스탠스 스케일 (애널리스트 레이팅 형식)
// 10=적극매수 … 1=적극매도. 숫자가 클수록 매수 우호, 작을수록 매도 우호.
// 명령이 아니라 '신호 등급' 표기이며 투자 권유가 아니다.
// (타입/상수 이름은 기존 호환을 위해 Stance7/STANCE7_META를 유지하되 값은 1~10이다.)

export type Stance7 = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const STANCE7_META: Record<Stance7, { label: string; tone: "buy" | "hold" | "sell" }> = {
  10: { label: "적극 매수", tone: "buy" },
  9: { label: "매수", tone: "buy" },
  8: { label: "분할 매수", tone: "buy" },
  7: { label: "비중 확대", tone: "buy" },
  6: { label: "중립(매수 우위)", tone: "hold" },
  5: { label: "중립(매도 우위)", tone: "hold" },
  4: { label: "비중 축소", tone: "sell" },
  3: { label: "분할 매도", tone: "sell" },
  2: { label: "매도", tone: "sell" },
  1: { label: "적극 매도", tone: "sell" },
};

// 내부 점수(양수=매수, 음수=매도)를 10단계로 환산 (0=중립 상단 6)
export function scoreToStance7(score: number): Stance7 {
  if (score >= 4) return 10;
  if (score === 3) return 9;
  if (score === 2) return 8;
  if (score === 1) return 7;
  if (score === 0) return 6;
  if (score === -1) return 5;
  if (score === -2) return 4;
  if (score === -3) return 3;
  if (score === -4) return 2;
  return 1;
}

export function stanceLabel(s: Stance7): string {
  return STANCE7_META[s].label;
}
export function stanceTone(s: Stance7): "buy" | "hold" | "sell" {
  return STANCE7_META[s].tone;
}

// 1~10 범위로 안전 클램프
export function clampStance(n: number): Stance7 {
  return Math.max(1, Math.min(10, Math.round(n))) as Stance7;
}

// AI Q&A 답변을 10단계로 구조화한 결과 (저장·표시·엔진 반영에 공용)
export type AnswerStance = {
  overall: {
    stance: Stance7;                 // 전체 시장/포트폴리오 스탠스 (1~10)
    risk: "낮음" | "보통" | "높음";  // 위험도
    summary: string;                 // 한 줄 요지
    bull: string[];                  // 강세 요인
    bear: string[];                  // 약세 요인
    risks: string[];                 // 핵심 리스크
  };
  tickers: { ticker: string; stance: Stance7; reason: string }[]; // 답변에 언급된 종목별
};

// 스탠스(1~10)를 엔진 바이어스(-2..+2)로 환산 — 중립(5~6)=0, 한정 폭 클램프
export function stanceToBias(stance: Stance7): number {
  if (stance >= 9) return 2;
  if (stance >= 7) return 1;
  if (stance >= 5) return 0;
  if (stance >= 3) return -1;
  return -2;
}
