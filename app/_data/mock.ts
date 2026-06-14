// 스탁가드 목업 더미 데이터 — 모든 화면 공통 샘플.
// 실제 시세·점수·뉴스가 아니며 화면 검증용 고정 값이다.

export const TODAY = "2026-06-14";

export type Position = {
  ticker: string;
  weight: number;
  pnl: number;
  leverage: boolean;
  sector: string;
  risk: "취약" | "주의" | "안정";
};

export const positions: Position[] = [
  { ticker: "삼성전자", weight: 30, pnl: -4, leverage: false, sector: "반도체", risk: "주의" },
  { ticker: "SOXL", weight: 20, pnl: -11, leverage: true, sector: "반도체", risk: "취약" },
  { ticker: "SK하이닉스", weight: 15, pnl: 8, leverage: false, sector: "반도체", risk: "주의" },
];

export const briefing = {
  verdict: "오늘은 방어 우선입니다",
  stage: "변동장 3단계",
  riskScore: 78,
  dos: ["레버리지 비중 축소 검토", "반도체 비중 신규 확대 보류"],
  donts: ["손실 만회성 추가 매수 금지", "장초반 반등만 보고 추격 매수 금지"],
  buffett:
    "좋은 기업을 싸게 살 준비는 하되, 레버리지로 변동성을 버틸 구간은 아닙니다.",
};

export const evidenceScores = [
  { label: "금리 위험", score: 82, note: "높음" },
  { label: "환율 위험", score: 71, note: "높음" },
  { label: "유가 위험", score: 68, note: "주의" },
  { label: "반도체 섹터", score: 84, note: "취약" },
  { label: "수급 위험", score: 76, note: "외국인 매도 우위" },
  { label: "채권 이동", score: 72, note: "방어 자금 유입" },
];

export const supply = [
  "코스피 외국인: 순매도 확대",
  "기관: 방어 업종 매수 / 성장주 매도",
  "개인: 거래량 증가, 저가 매수 유입",
  "채권: 가격 상승 + 거래량 증가 (방어 신호)",
];

export const coreIssues = [
  "미국 기술주 약세",
  "금리 변동성 확대",
  "반도체 지수 시장 대비 부진",
];

export const principles = [
  { id: "lev", label: "하락장 2단계 이상에서는 레버리지 신규 매수 금지", on: true, active: true },
  { id: "avg", label: "급락 첫날에는 물타기 금지", on: true, active: false },
  { id: "loan", label: "손실 만회 목적의 대출 매수 금지", on: true, active: false },
  { id: "gap", label: "장마감 전 갭하락 위험 확인", on: false, active: false },
];

export const riskLines = [
  { id: "low", label: "전저점 이탈", on: true },
  { id: "drop5", label: "장중 -5% 급락", on: true },
  { id: "futures", label: "나스닥 선물 급락 + 금리 상승", on: false },
  { id: "rebound", label: "반등 실패 후 재하락", on: false },
];

export const preCloseScenarios = [
  { result: "상회", impact: "금리 압력 → 기술주·레버리지 부담 확대" },
  { result: "부합", impact: "기존 장세 유지 가능" },
  { result: "하회", impact: "경기 둔화 우려 → 단기 반등과 침체 구분 필요" },
  { result: "실적 부진", impact: "반도체 섹터 갭하락 위험" },
];

export const perStockCalls = [
  { ticker: "삼성전자", call: "유지 가능, 신규 매수 보류" },
  { ticker: "SOXL", call: "축소 우선" },
  { ticker: "SK하이닉스", call: "반도체 약세 주의" },
];

export const applications = [
  {
    name: "홍길동",
    email: "hong@example.com",
    phone: "010-1234-5678",
    date: "06-14",
    experience: "3년 / 국내·미국장",
    motive: "변동장 대응이 어려워서",
    status: "대기" as const,
  },
  {
    name: "김투자",
    email: "kim@example.com",
    phone: "010-2222-3333",
    date: "06-14",
    experience: "5년 / 국내장",
    motive: "레버리지 ETF 위험 관리",
    status: "대기" as const,
  },
  {
    name: "이방어",
    email: "lee@example.com",
    phone: "010-4444-5555",
    date: "06-13",
    experience: "1년 / 미국장",
    motive: "손절 원칙을 못 지켜서",
    status: "승인" as const,
  },
];

export const gapReport = {
  total: 20,
  followed: 9,
  partial: 4,
  ignored: 7,
  winDespiteIgnore: 3,
  lossDespiteIgnore: 4,
  pattern: "변동장 3단계에서 반등을 추세 전환으로 판단하는 경향이 있습니다.",
};

export const similarCase = {
  overlaps: ["변동장 3단계", "레버리지 20% 이상", "금리 재상승 가능성", "반도체 지수 약세"],
  date: "2026-05-21",
  guide: "레버리지 축소",
  action: "SOXL 유지",
  result: "다음날 -6.8% · 3거래일 -9.4%",
  missed: "장중 반등 뒤 나스닥 선물이 꺾였고 금리가 다시 상승했습니다.",
  takeaway: "반등이 나와도 선물·금리 재상승 확인 전까지 추가 진입은 보류 구간입니다.",
};

export const misjudgment = {
  verdict: "방어 완화 가능, 일부 유지 가능",
  result: "SOXL 다음날 -6.8% · SK하이닉스 -3.1%",
  basisThen: ["10년물 금리 하락", "나스닥 선물 반등", "반도체 저가 매수 유입"],
  changed: ["금리 재상승", "나스닥 선물 반락", "외국인 순매도 확대"],
  cause: "금리 하락을 지속 신호로 봤지만 일시적 완화에 가까웠습니다.",
  nextApply: "금리 하락만으로 방어 완화를 낮추지 않고, 선물 방향·수급 확인을 함께 요구합니다.",
};

export const insights = {
  strong: "반도체 섹터 단기 반등은 사용자의 판단이 3건 중 2건 맞았습니다.",
  weak: "레버리지 ETF는 하락장 2단계 이상에서 유지 후 손실이 반복됐습니다.",
  reinforce: ["변동장 3단계 + 레버리지 20% 이상", "반등 실패 + 금리 상승 동시 발생"],
};
