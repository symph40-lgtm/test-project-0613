export type RiskLineKey = "low" | "drop5" | "futures" | "rebound";

export const RISK_LINE_LABELS: Record<RiskLineKey, string> = {
  low: "전저점 이탈",
  drop5: "장중 -5% 급락",
  futures: "나스닥 선물 급락 + 금리 상승",
  rebound: "반등 실패 후 재하락",
};

export const RISK_LINE_KEYS: RiskLineKey[] = ["low", "drop5", "futures", "rebound"];

export type RiskLineRow = {
  trigger_key: RiskLineKey;
  label: string;
  is_on: boolean;
  recommended: boolean;
};
