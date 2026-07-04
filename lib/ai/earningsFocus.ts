// 실적 발표 기업별 '핵심 관전 포인트' 추출 — 뉴스 + 컨센서스 데이터를 근거로
// "이번 실적에서 시장이 가장 주목하는 단일 지표"와 그 예상치를 AI가 뽑는다(없으면 비움).
import { fetchNews } from "@/lib/news/fetch";
import { getAiClient, hasAiKey, parseJsonLoose } from "./client";
import type { EarningsFundamentals } from "@/lib/market/earnings";

export type EarningsKeyPoint = {
  metric: string;          // 핵심 관전 포인트 (예: "영업이익률·HBM 매출 비중")
  estimate: string | null; // 예상치(컨센서스/가이던스) — 불확실하면 null(빈칸)
  why: string;             // 왜 가장 중요한지 한 줄
};

const SYSTEM = `당신은 반도체·AI 업종 전문 실적 애널리스트입니다. 개별 기업의 분기 실적 발표에서 시장이 가장 주목하는 '단일 핵심 지표'를 뉴스 근거로 짚습니다.
규칙:
1. 매출·EPS는 기본이고, 그보다 주가를 좌우하는 '진짜 관전 포인트'를 1개만 고른다. 예: 마이크론=영업이익률·HBM 매출 비중·DRAM ASP, 엔비디아=데이터센터 매출·다음 분기 가이던스, TSMC=AI/HPC 매출 비중·CAPEX.
2. 예상치(estimate)는 '제공된 컨센서스 데이터' 또는 '뉴스에 명시된 수치'에서만 가져온다. 불확실하면 절대 지어내지 말고 null.
3. 한국어. 간결하게. JSON만 출력.`;

// 경제지표(예: PCE·CPI·고용)의 시장 컨센서스/예측 종합을 뉴스에서 추출.
export type IndicatorConsensus = {
  headline: string | null;  // 핵심 수치(전체) 컨센서스 (예: "PCE 전월 +0.1% / 전년 +2.3%")
  core: string | null;      // 근원(Core) 컨센서스 (예: "근원 PCE 전월 +0.2% / 전년 +2.6%")
  forecast: string | null;  // 예측 종합(서프라이즈 방향 등)
  note: string | null;      // 한 줄 코멘트
};
export async function fetchIndicatorConsensus(name: string, date: string): Promise<IndicatorConsensus | null> {
  if (!hasAiKey()) return null;
  const isPce = /pce|개인소비|개인소득/i.test(name);
  const q = isPce
    ? "Core PCE forecast consensus estimate OR 근원 PCE 물가 컨센서스 예상"
    : `${name} forecast consensus estimate OR ${name} 컨센서스 예상치`;
  const news = await fetchNews(q, 6).then((n) => n.slice(0, 6)).catch(() => []);
  if (news.length === 0) return null;
  const heads = news.map((n) => `- ${n.title} (${n.source})`).join("\n");
  const prompt = `미국 '${name}' 지표가 ${date}에 발표됩니다. 아래 최신 뉴스를 근거로 '시장 컨센서스(예상치)'와 '예측 종합'을 정리하십시오.
${name.includes("PCE") || name.includes("개인") ? "특히 연준이 중시하는 '근원(Core) PCE'의 전월대비·전년대비 컨센서스를 우선으로 찾으십시오." : ""}

${heads}

JSON으로만:
{
  "headline": "전체 지표 컨센서스 수치(뉴스에 명시된 경우만, 없으면 null)",
  "core": "근원(Core) 컨센서스 수치(있으면, 없으면 null)",
  "forecast": "예측 종합·서프라이즈 방향(있으면, 없으면 null)",
  "note": "한 줄 코멘트"
}
수치는 뉴스에 명확히 적힌 것만 사용하고, 불확실하면 null로 비우십시오. 절대 지어내지 마십시오.`;
  try {
    const client = getAiClient();
    const msg = await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const p = parseJsonLoose<IndicatorConsensus>(text);
    const clean = (v: unknown): string | null => {
      const s = v == null ? "" : String(v).trim();
      return !s || /모름|미상|n\/?a|unknown|null/i.test(s) ? null : s.slice(0, 80);
    };
    const r = { headline: clean(p.headline), core: clean(p.core), forecast: clean(p.forecast), note: clean(p.note) };
    return r.headline || r.core || r.forecast ? r : null;
  } catch {
    return null;
  }
}

// events: 예정 실적 기업 목록(가까운 순). fundamentals: 종목별 컨센서스(예상 매출·EPS·영업이익률).
export async function fetchEarningsKeyPoints(
  events: { symbol: string; name: string; dateKst: string }[],
  fundamentals: Record<string, EarningsFundamentals | null>,
  maxItems = 5,
): Promise<Record<string, EarningsKeyPoint>> {
  const out: Record<string, EarningsKeyPoint> = {};
  if (!hasAiKey() || events.length === 0) return out;
  const targets = events.slice(0, maxItems);

  // 기업별 최신 실적 프리뷰 뉴스 수집(병렬)
  const newsBySym = await Promise.all(
    targets.map((e) =>
      fetchNews(`${e.name} ${e.symbol} earnings OR 실적 OR 가이던스`, 4)
        .then((n) => n.slice(0, 4))
        .catch(() => []),
    ),
  );

  const blocks = targets.map((e, i) => {
    const f = fundamentals[e.symbol];
    const cons = f
      ? [
          f.revenueEst != null ? `예상매출 $${(f.revenueEst / 1e9).toFixed(1)}B` : null,
          f.epsEst != null ? `예상EPS ${f.epsEst.toFixed(2)}` : null,
          f.opMargin != null ? `영업이익률(컨센) ${(f.opMargin * 100).toFixed(1)}%` : null,
        ].filter(Boolean).join(" · ")
      : "컨센서스 데이터 없음";
    const heads = newsBySym[i].map((n) => `   - ${n.title} (${n.source})`).join("\n") || "   - (관련 뉴스 없음)";
    return `${i + 1}. ${e.name}(${e.symbol}) — ${e.dateKst}\n   컨센서스: ${cons}\n   뉴스:\n${heads}`;
  }).join("\n\n");

  const prompt = `다음 기업들의 다가오는 실적 발표에서, 각 기업별로 '이번 실적의 가장 중요한 단일 관전 포인트'와 그 예상치를 뽑으십시오.

${blocks}

각 기업에 대해 JSON 배열로만 응답:
[
  { "symbol": "MU", "metric": "가장 중요한 관전 포인트(1개)", "estimate": "예상치(컨센서스/뉴스 명시 수치만, 불확실하면 null)", "why": "왜 가장 중요한지 한 줄" }
]
estimate는 제공된 컨센서스나 뉴스에 명확한 수치가 있을 때만 채우고, 없으면 null로 비우십시오. 숫자를 추정/창작하지 마십시오.`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const arr = parseJsonLoose<Array<{ symbol: string; metric: string; estimate: string | null; why: string }>>(text);
    if (Array.isArray(arr)) {
      for (const x of arr) {
        const sym = String(x.symbol ?? "").trim();
        if (!sym) continue;
        const est = x.estimate == null || String(x.estimate).trim() === "" || /모름|미상|n\/?a|unknown/i.test(String(x.estimate))
          ? null
          : String(x.estimate).slice(0, 60);
        out[sym] = {
          metric: String(x.metric ?? "").slice(0, 80),
          estimate: est,
          why: String(x.why ?? "").slice(0, 120),
        };
      }
    }
  } catch {
    return out;
  }
  return out;
}
