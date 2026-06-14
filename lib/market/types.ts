export type QuoteData = {
  symbol: string;
  price: number | null;
  previousClose: number | null;
  changePercent: number | null; // % change from previous close
};

export type MarketData = {
  sp500: QuoteData;       // ^GSPC
  nasdaq: QuoteData;      // ^NDX
  sox: QuoteData;         // ^SOX  반도체 지수
  kospi: QuoteData;       // ^KS11
  usdkrw: QuoteData;      // USDKRW=X 달러/원
  oil: QuoteData;         // CL=F   WTI 유가
  treasury10y: QuoteData; // ^TNX   10년물 금리
  fetchedAt: string;      // ISO timestamp
};

export type RiskScores = {
  rate: number;        // 금리 위험 0~100
  forex: number;       // 환율 위험 0~100
  oil: number;         // 유가 위험 0~100
  semiconductor: number; // 반도체 섹터 0~100
  supply: number;      // 수급 위험 0~100
  bond: number;        // 채권 이동 0~100 (역방향 신호)
};

export type EvidenceScore = {
  label: string;
  score: number; // 0~100
  note: string;
};

export type BriefingSnapshot = {
  id: string;
  user_id: string;
  date: string;
  market_data: MarketData | null;
  risk_scores: RiskScores | null;
  risk_score: number | null;
  stage: string | null;
  ai_output: AiBriefingOutput | null;
  is_fallback: boolean;
  created_at: string;
  updated_at: string;
};

export type AiBriefingOutput = {
  verdict: string;
  stage: string;
  dos: string[];
  donts: string[];
  buffett: string;
  coreIssues: string[];
  supplyNotes: string[];
  pressureLevel: number;   // 0~1 큰 장세 압력
  situationLevel: number;  // 0~1 오늘 상황 (0=완화, 1=악화)
  issuesDuration: { issue: string; duration: "하루" | "며칠" | "이상" }[];
};

export type AiPrecloseOutput = {
  todaySummary: string;
  nightEvents: { event: string; expectedTime: string }[];
  perStockCalls: { ticker: string; call: string }[];
  scenarios: { result: string; impact: string }[];
};
