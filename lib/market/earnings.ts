import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance();

// 미국 반도체·AI 핵심 종목 워치리스트
const SEMI_AI_WATCHLIST: { symbol: string; name: string }[] = [
  { symbol: "NVDA", name: "엔비디아" },
  { symbol: "AMD", name: "AMD" },
  { symbol: "AVGO", name: "브로드컴" },
  { symbol: "MU", name: "마이크론" },
  { symbol: "TSM", name: "TSMC" },
  { symbol: "ASML", name: "ASML" },
  { symbol: "QCOM", name: "퀄컴" },
  { symbol: "INTC", name: "인텔" },
  { symbol: "ARM", name: "ARM" },
  { symbol: "SMCI", name: "슈퍼마이크로" },
  { symbol: "MSFT", name: "마이크로소프트" },
  { symbol: "GOOGL", name: "알파벳(구글)" },
  { symbol: "META", name: "메타" },
  { symbol: "AMZN", name: "아마존" },
  { symbol: "PLTR", name: "팔란티어" },
];

export type EarningsEvent = {
  symbol: string;
  name: string;
  date: string;       // YYYY-MM-DD (미국 발표일 기준)
  dateKst: string;    // 한국시간 표기 (대개 장 마감 후 = 한국 다음날 새벽)
  epsForward: number | null;
};

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v * (v < 1e12 ? 1000 : 1));
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// 향후 N일 내 미국 반도체·AI 기업 실적 발표 일정 (가까운 순 상위 10건)
export async function fetchSemiAiEarnings(withinDays = 120): Promise<EarningsEvent[]> {
  const symbols = SEMI_AI_WATCHLIST.map((w) => w.symbol);
  let quotes: Record<string, unknown>[];
  try {
    const res = await yf.quote(symbols);
    quotes = (Array.isArray(res) ? res : [res]) as Record<string, unknown>[];
  } catch {
    return [];
  }

  const nameMap = new Map(SEMI_AI_WATCHLIST.map((w) => [w.symbol, w.name]));
  const now = Date.now();
  const limit = now + withinDays * 24 * 3600 * 1000;
  const events: EarningsEvent[] = [];

  for (const q of quotes) {
    const symbol = String(q.symbol ?? "");
    const d = toDate(q.earningsTimestamp ?? q.earningsTimestampStart);
    if (!d) continue;
    const t = d.getTime();
    if (t < now || t > limit) continue; // 과거 또는 너무 먼 미래 제외

    const eps = typeof q.epsForward === "number" ? q.epsForward : null;
    events.push({
      symbol,
      name: nameMap.get(symbol) ?? symbol,
      date: d.toISOString().slice(0, 10),
      dateKst: d.toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      epsForward: eps,
    });
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events.slice(0, 10);
}

// 실적 발표 전 펀더멘털·컨센서스·거버넌스 (Yahoo quoteSummary)
export type EarningsFundamentals = {
  revenueEst: number | null;   // 다음 분기 예상 매출 (컨센서스 평균)
  epsEst: number | null;       // 예상 EPS (컨센서스 평균)
  epsLow: number | null;
  epsHigh: number | null;
  opMargin: number | null;     // 영업이익률
  opIncomeEst: number | null;  // 추정 영업이익 = 예상매출 × 영업이익률
  roe: number | null;
  forwardPE: number | null;
  trailingPE: number | null;
  pbr: number | null;
  peg: number | null;
  recKey: string | null;       // strong_buy | buy | hold | underperform | sell
  recMean: number | null;      // 1(적극매수)~5(매도)
  analysts: number | null;
  targetMean: number | null;
  currentPrice: number | null;
  vsTargetPct: number | null;  // 현재가가 목표주가 대비 (양수=목표가 상회)
  gov: { overall: number | null; board: number | null; audit: number | null; comp: number | null; shareholder: number | null };
};

export async function fetchEarningsFundamentals(symbol: string): Promise<EarningsFundamentals | null> {
  const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
  // 중첩 경로 안전 탐색 (yahoo-finance2 모듈 타입 우회)
  const pick = (o: unknown, ...keys: string[]): unknown =>
    keys.reduce<unknown>(
      (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
      o,
    );
  try {
    const r = (await yf.quoteSummary(symbol, {
      modules: ["financialData", "defaultKeyStatistics", "summaryDetail", "earningsTrend", "assetProfile"],
    })) as Record<string, unknown>;

    const fd = (r.financialData ?? {}) as Record<string, unknown>;
    const ks = (r.defaultKeyStatistics ?? {}) as Record<string, unknown>;
    const sd = (r.summaryDetail ?? {}) as Record<string, unknown>;
    const ap = (r.assetProfile ?? {}) as Record<string, unknown>;
    const trend = (pick(r, "earningsTrend", "trend") ?? []) as Array<Record<string, unknown>>;
    const et = trend.find((t) => t.period === "0q") ?? trend[0];

    const revenueEst = num(pick(et, "revenueEstimate", "avg"));
    const opMargin = num(fd.operatingMargins);
    const target = num(fd.targetMeanPrice);
    const cur = num(fd.currentPrice);

    return {
      revenueEst,
      epsEst: num(pick(et, "earningsEstimate", "avg")),
      epsLow: num(pick(et, "earningsEstimate", "low")),
      epsHigh: num(pick(et, "earningsEstimate", "high")),
      opMargin,
      opIncomeEst: revenueEst !== null && opMargin !== null ? revenueEst * opMargin : null,
      roe: num(fd.returnOnEquity),
      forwardPE: num(sd.forwardPE),
      trailingPE: num(sd.trailingPE),
      pbr: num(ks.priceToBook),
      peg: num(ks.pegRatio),
      recKey: typeof fd.recommendationKey === "string" ? fd.recommendationKey : null,
      recMean: num(fd.recommendationMean),
      analysts: num(fd.numberOfAnalystOpinions),
      targetMean: target,
      currentPrice: cur,
      vsTargetPct: target && cur ? ((cur - target) / target) * 100 : null,
      gov: {
        overall: num(ap.overallRisk),
        board: num(ap.boardRisk),
        audit: num(ap.auditRisk),
        comp: num(ap.compensationRisk),
        shareholder: num(ap.shareHolderRightsRisk),
      },
    };
  } catch {
    return null;
  }
}
