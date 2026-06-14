import type { MarketData } from "../market/types";

export type AlertTrigger = {
  trigger_key: "low" | "drop5" | "futures" | "rebound";
  ticker: string | null;
  severity: "high" | "medium" | "low";
  reason: string;
};

export type PositionForAlert = {
  ticker: string;
  is_leverage: boolean;
  sector: string | null;
};

function hasLeveragePosition(positions: PositionForAlert[]): boolean {
  return positions.some((p) => p.is_leverage);
}

function upgradeSeverity(s: "high" | "medium" | "low"): "high" | "medium" | "low" {
  if (s === "medium") return "high";
  return s;
}

export function evaluateAlertTriggers(
  market: MarketData,
  positions: PositionForAlert[],
  enabledLines: string[]
): AlertTrigger[] {
  const triggers: AlertTrigger[] = [];
  const hasLeverage = hasLeveragePosition(positions);

  // low: KOSPI 또는 SOX -2% 이하
  if (enabledLines.includes("low")) {
    const kospiDrop =
      market.kospi.changePercent !== null && market.kospi.changePercent < -2;
    const soxDrop =
      market.sox.changePercent !== null && market.sox.changePercent < -2;

    if (kospiDrop || soxDrop) {
      let sev: AlertTrigger["severity"] = "medium";
      if (hasLeverage) sev = upgradeSeverity(sev);
      triggers.push({
        trigger_key: "low",
        ticker: null,
        severity: sev,
        reason:
          kospiDrop && soxDrop
            ? `코스피 ${market.kospi.changePercent?.toFixed(1)}%, SOX ${market.sox.changePercent?.toFixed(1)}% 동반 하락`
            : kospiDrop
              ? `코스피 ${market.kospi.changePercent?.toFixed(1)}% 하락`
              : `SOX(반도체 지수) ${market.sox.changePercent?.toFixed(1)}% 하락`,
      });
    }
  }

  // drop5: 나스닥 또는 SOX -5% 이하
  if (enabledLines.includes("drop5")) {
    const nasdaqDrop5 =
      market.nasdaq.changePercent !== null && market.nasdaq.changePercent < -5;
    const soxDrop5 =
      market.sox.changePercent !== null && market.sox.changePercent < -5;

    if (nasdaqDrop5 || soxDrop5) {
      let sev: AlertTrigger["severity"] = "high";
      if (hasLeverage) sev = "high"; // 이미 최고 강도
      triggers.push({
        trigger_key: "drop5",
        ticker: null,
        severity: sev,
        reason:
          nasdaqDrop5 && soxDrop5
            ? `나스닥 ${market.nasdaq.changePercent?.toFixed(1)}%, SOX ${market.sox.changePercent?.toFixed(1)}% 급락`
            : nasdaqDrop5
              ? `나스닥 ${market.nasdaq.changePercent?.toFixed(1)}% 급락`
              : `SOX(반도체 지수) ${market.sox.changePercent?.toFixed(1)}% 급락`,
      });
    }
  }

  // futures: 나스닥 -3% 이하 AND 10Y 금리 당일 상승
  if (enabledLines.includes("futures")) {
    const nasdaqDrop3 =
      market.nasdaq.changePercent !== null && market.nasdaq.changePercent < -3;
    const rateRising =
      market.treasury10y.changePercent !== null && market.treasury10y.changePercent > 0;

    if (nasdaqDrop3 && rateRising) {
      let sev: AlertTrigger["severity"] = "high";
      if (hasLeverage) sev = "high";
      triggers.push({
        trigger_key: "futures",
        ticker: null,
        severity: sev,
        reason: `나스닥 ${market.nasdaq.changePercent?.toFixed(1)}% 하락 + 미국 10년물 금리 ${market.treasury10y.changePercent?.toFixed(2)}% 상승 동시 발생`,
      });
    }
  }

  // rebound: 나스닥 +1% 이상이지만 SOX 하락 (반등 실패 시그널)
  if (enabledLines.includes("rebound")) {
    const nasdaqUp =
      market.nasdaq.changePercent !== null && market.nasdaq.changePercent > 1;
    const soxDown =
      market.sox.changePercent !== null && market.sox.changePercent < 0;

    if (nasdaqUp && soxDown) {
      let sev: AlertTrigger["severity"] = "medium";
      if (hasLeverage) sev = upgradeSeverity(sev);
      triggers.push({
        trigger_key: "rebound",
        ticker: null,
        severity: sev,
        reason: `나스닥 반등(${market.nasdaq.changePercent?.toFixed(1)}%)에도 반도체 지수 하락(${market.sox.changePercent?.toFixed(1)}%) — 반등 실패 가능성`,
      });
    }
  }

  // dedup: 같은 trigger_key는 첫 번째만 유지
  const seen = new Set<string>();
  return triggers.filter((t) => {
    if (seen.has(t.trigger_key)) return false;
    seen.add(t.trigger_key);
    return true;
  });
}
