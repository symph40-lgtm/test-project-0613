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
