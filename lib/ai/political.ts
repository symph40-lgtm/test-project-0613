import { fetchNews, type NewsItem } from "@/lib/news/fetch";
import { getAiClient, hasAiKey, parseJsonLoose } from "./client";

// 미국 정치·정책·법안·지정학·트럼프 변수의 '증시 리스크' 평가 (뉴스 기반 AI)
// 정량 데이터가 없는 영역이라 AI/뉴스 기반 주관 평가임 — 점수와 근거 뉴스를 함께 투명 표기한다.
export type MacroSignal = {
  label: string;
  value: string;
  change: string;
  risk: "high" | "watch" | "low"; // high=증시 부담↑(유가·금리·기대인플레 상승)
};

export type PoliticalRisk = {
  score: number;                 // 0~100 종합 (뉴스 + 매크로)
  newsScore: number;             // 뉴스 기반 지정학·정치 점수
  macroScore: number;            // 데이터(유가·금리·기대인플레) 기반 점수
  direction: "부담" | "중립" | "우호";
  summary: string;               // 한두 줄 요지
  drivers: string[];             // 핵심 변수 (정책·법안·지정학 등)
  headlines: { title: string; source: string; link: string }[]; // 근거 뉴스
  macro: MacroSignal[];          // 전쟁→유가→인플레→금리 전이 데이터
  isFallback: boolean;
};

// FRED 시리즈 최근값 + 5영업일 변화
async function fredRecent(id: string): Promise<{ cur: number; chg: number } | null> {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=8`,
      { next: { revalidate: 3 * 3600 } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { observations?: { value: string }[] };
    const v = (j.observations ?? []).map((o) => parseFloat(o.value)).filter((n) => !isNaN(n));
    if (v.length < 2) return null;
    return { cur: v[0], chg: v[0] - v[Math.min(5, v.length - 1)] };
  } catch {
    return null;
  }
}

// 유가·금리는 실시간 시세(Yahoo) 우선 — FRED는 며칠 지연돼 급변기에 부정확하므로.
export type LiveMarket = {
  oil?: { price: number | null; changePercent: number | null };
  treasury10y?: { price: number | null; changePercent: number | null };
};

// 전쟁→유가→인플레→금리 전이를 실데이터로 평가 → 매크로 점수(0~100) + 신호
async function fetchMacroPressure(market?: LiveMarket): Promise<{ score: number; signals: MacroSignal[] }> {
  const bei = await fredRecent("T10YIE"); // 10년 기대인플레 — 실시간 소스 없어 FRED 사용
  let score = 40; // 중립 기준
  const signals: MacroSignal[] = [];

  // 유가(WTI) — 실시간 당일 변화
  if (market?.oil?.price != null) {
    const cur = market.oil.price;
    const pct = market.oil.changePercent ?? 0;
    const risk = pct > 3 ? "high" : pct > 1 ? "watch" : "low";
    score += pct > 3 ? 25 : pct > 1 ? 12 : pct < -1.5 ? -10 : 0;
    signals.push({ label: "유가(WTI)", value: `$${cur.toFixed(1)}`, change: `당일 ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, risk });
  } else {
    // 폴백: FRED(지연)
    const oil = await fredRecent("DCOILWTICO");
    if (oil) signals.push({ label: "유가(WTI)", value: `$${oil.cur.toFixed(1)}`, change: "지연값", risk: "low" });
  }

  // 미 10년물 금리 — 실시간 당일 변화(%)
  if (market?.treasury10y?.price != null) {
    const cur = market.treasury10y.price;
    const pct = market.treasury10y.changePercent ?? 0;
    const risk = pct > 1.5 ? "high" : pct > 0.5 ? "watch" : "low";
    score += pct > 1.5 ? 12 : pct > 0.5 ? 5 : pct < -1 ? -8 : 0;
    signals.push({ label: "미 10년물 금리", value: `${cur.toFixed(2)}%`, change: `당일 ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, risk });
  }

  // 기대인플레(10Y BEI) — FRED 5일 변화
  if (bei) {
    const risk = bei.chg > 0.05 ? "high" : bei.chg > 0.02 ? "watch" : "low";
    score += bei.chg > 0.05 ? 12 : bei.chg > 0.02 ? 5 : bei.chg < -0.05 ? -8 : 0;
    signals.push({ label: "기대인플레(10Y BEI)", value: `${bei.cur.toFixed(2)}%`, change: `5일 ${bei.chg >= 0 ? "+" : ""}${bei.chg.toFixed(2)}%p`, risk });
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), signals };
}

// 지정학/전쟁(이란·이스라엘·중동·유가·호르무즈)을 우선 쿼리로, 미국 정책/트럼프를 보조 쿼리로 분리.
// 단일 쿼리로는 반도체 규제·무역 뉴스에 밀려 급박한 전쟁 리스크가 누락되므로 둘을 합친다.
const GEO_QUERY =
  "이란 OR 이스라엘 OR 레바논 OR 중동 전쟁 OR 호르무즈 OR 미국 이란 OR 트럼프 이란 OR 지정학 유가";
const POLICY_QUERY =
  "트럼프 OR 미국 관세 OR 연준 OR 미국 정책 OR 미국 법안 OR 무역분쟁 OR 반도체 규제";

const SYSTEM = `당신은 한국 투자자를 위한 매크로·지정학 리스크 애널리스트입니다.
미국 정치·정책·법안·세계 정세·트럼프 변수가 '증시(특히 코스피·반도체·나스닥)'에 주는 리스크를 평가합니다.
중요 규칙:
1. 급박한 지정학·군사 분쟁(중동 전쟁, 미·이란 충돌, 이스라엘-레바논, 호르무즈 봉쇄, 유가 공급 충격)은 위험회피·유가 급등을 통해 증시에 가장 큰 충격을 주므로 점수에 가장 무겁게 반영한다.
2. 주어진 뉴스 헤드라인 근거로만 판단하고, 없는 사실을 지어내지 않는다.
3. 단정 금지, 가능성 표현 사용. 강세·약세 요인을 균형 있게 본다.
4. 출력은 JSON만. 코드블록 금지.`;

// 뉴스(지정학)와 매크로(유가·금리·인플레)를 합쳐 종합 점수·방향 산출
function combine(newsScore: number, macroScore: number): { score: number; direction: PoliticalRisk["direction"] } {
  const score = Math.max(0, Math.min(100, Math.round(0.5 * newsScore + 0.5 * macroScore)));
  const direction = score >= 58 ? "부담" : score <= 42 ? "우호" : "중립";
  return { score, direction };
}

function fallback(
  headlines: PoliticalRisk["headlines"],
  macro: { score: number; signals: MacroSignal[] },
): PoliticalRisk {
  const { score, direction } = combine(50, macro.score);
  return {
    score,
    newsScore: 50,
    macroScore: macro.score,
    direction,
    summary: "정치·지정학 뉴스 신호가 부족해 뉴스는 중립으로 두고, 유가·금리·기대인플레 데이터로만 평가했습니다.",
    drivers: [],
    headlines,
    macro: macro.signals,
    isFallback: true,
  };
}

export async function assessPoliticalRisk(market?: LiveMarket): Promise<PoliticalRisk> {
  // 지정학(전쟁) 우선 + 미국 정책 보조 + 매크로 데이터(유가·금리·인플레)를 병렬 수집
  const [geo, policy, macro] = await Promise.all([
    fetchNews(GEO_QUERY, 6),
    fetchNews(POLICY_QUERY, 5),
    fetchMacroPressure(market),
  ]);
  const seen = new Set<string>();
  const headlines = [...geo, ...policy]
    .filter((n: NewsItem) => {
      const key = n.title.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10)
    .map((n) => ({ title: n.title, source: n.source, link: n.link }));

  if (!hasAiKey() || headlines.length === 0) return fallback(headlines, macro);

  const prompt = `다음은 세계 정세(지정학·전쟁)와 미국 정치·정책 관련 최신 헤드라인입니다(앞쪽이 지정학).

${headlines.map((h, i) => `${i + 1}. ${h.title} (${h.source})`).join("\n")}

이 상황이 현재 증시(코스피·반도체·나스닥)에 주는 리스크를 평가해 JSON으로만 응답하십시오. 급박한 군사·지정학 분쟁과 유가 충격은 가장 무겁게 반영하십시오:
{
  "score": 0~100 정수 (높을수록 증시에 부담),
  "direction": "부담 | 중립 | 우호",
  "summary": "현재 정치·정책發 증시 리스크 한두 문장",
  "drivers": ["핵심 변수 1", "핵심 변수 2", "핵심 변수 3"]
}`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const p = parseJsonLoose<{ score: number; direction: PoliticalRisk["direction"]; summary: string; drivers: string[] }>(text);
    const newsScore = Math.max(0, Math.min(100, Math.round(Number(p.score ?? 50))));
    const { score, direction } = combine(newsScore, macro.score);
    return {
      score,
      newsScore,
      macroScore: macro.score,
      direction,
      summary: String(p.summary ?? "").slice(0, 300),
      drivers: (p.drivers ?? []).slice(0, 5).map((d) => String(d).slice(0, 120)),
      headlines,
      macro: macro.signals,
      isFallback: false,
    };
  } catch {
    return fallback(headlines, macro);
  }
}
