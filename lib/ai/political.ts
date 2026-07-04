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
  headlines: { title: string; source: string; link: string; pubDate?: string }[]; // 근거 뉴스(날짜 포함)
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
4. 반도체 영향은 '실제 수요 구조'로 가중하라: 현재 한국 반도체(삼성전자·SK하이닉스)의 핵심 동력은 AI 데이터센터향 HBM·고성능 메모리 수요다. 따라서 (a) 첨단 칩·HBM·반도체 장비에 대한 '직접적 수출통제(미 BIS 등)'와 (b) 빅테크 AI 캡엑스(투자) 둔화는 직접적·구조적 리스크로 무겁게 보되, (c) 소비가전·로봇·범용 수요나 AI 데이터센터와 무관한 중국발 규제처럼 '연관성이 약한 사안'을 '반도체 구조적 압박'으로 과대평가하지 마라. 연결고리가 약하면 영향이 '제한적'이라고 명시하라.
5. 출력은 JSON만. 코드블록 금지.`;

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

export async function assessPoliticalRisk(market?: LiveMarket, maxAgeHours = 24): Promise<PoliticalRisk> {
  // 지정학(전쟁) 우선 + 미국 정책 보조 + 매크로 데이터(유가·금리·인플레)를 병렬 수집
  const [geo, policy, macro] = await Promise.all([
    fetchNews(GEO_QUERY, 10),
    fetchNews(POLICY_QUERY, 8),
    fetchMacroPressure(market),
  ]);
  // 당일(최근 maxAgeHours) 기사만 — 며칠 지난 옛 기사를 근거로 쓰지 않게. 최신순 정렬.
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const fresh = (n: NewsItem): boolean => {
    const ts = n.pubDate ? new Date(n.pubDate).getTime() : NaN;
    return !isNaN(ts) && ts >= cutoff;
  };
  const seen = new Set<string>();
  const headlines = [...geo, ...policy]
    .filter((n: NewsItem) => {
      const key = n.title.trim();
      if (!key || seen.has(key) || !fresh(n)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.pubDate < b.pubDate ? 1 : a.pubDate > b.pubDate ? -1 : 0))
    .slice(0, 10)
    .map((n) => ({ title: n.title, source: n.source, link: n.link, pubDate: n.pubDate }));

  if (!hasAiKey() || headlines.length === 0) return fallback(headlines, macro);

  // 실제 시세를 함께 제공 — 뉴스 서사가 실데이터와 모순되지 않게(예: 전쟁 뉴스만 보고 '유가 상승' 단정 금지)
  const macroLine = macro.signals.map((s) => `${s.label} ${s.value}(${s.change})`).join(" · ") || "데이터 없음";
  const fmtDate = (iso?: string) => {
    if (!iso) return "날짜미상";
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const prompt = `다음은 '최근 ${maxAgeHours}시간 이내' 세계 정세(지정학·전쟁)와 미국 정치·정책 헤드라인입니다(최신순).

${headlines.map((h, i) => `${i + 1}. [${fmtDate(h.pubDate)}] ${h.title} (${h.source})`).join("\n")}

## 실시간 시장 데이터 (반드시 우선)
${macroLine}

## 분석 규칙 (엄수)
- 뉴스 서사가 위 '실시간 시장 데이터'와 모순되면 안 됩니다. 예: 지정학 긴장 기사가 있어도 **실제 유가가 하락 중(당일 마이너스)이면 '유가 상승'·'상승 압력'·'상승 추세'라고 쓰지 마십시오.** 그 경우 "긴장에도 시장이 공급 차질을 가격에 반영하지 않는다(유가 하락)"로 해석하십시오.
- 유가·금리 '방향'은 뉴스가 아니라 위 당일 실제 등락률을 근거로 기술하십시오.
- 오래된 사건을 현재 진행형으로 단정하지 말고, 위 헤드라인 날짜 기준으로 평가하십시오.
- **영향도 필터링**: 각 헤드라인이 한국 증시(특히 반도체·코스피·나스닥)에 주는 실제 영향도를 high/medium/low로 판정하십시오. 현재 한국 반도체 수요는 AI 데이터센터向 HBM·고성능 메모리에 집중돼 있으므로, 소비가전·로봇·범용 수요나 AI와 무관한 중국발 규제처럼 '연결고리가 약한' 사안은 low로 분류하십시오. summary·drivers는 high/medium 사안만 근거로 삼고, low 사안은 언급하지 마십시오.

이 상황이 현재 증시(코스피·반도체·나스닥)에 주는 리스크를 평가해 JSON으로만 응답하십시오. 급박한 군사·지정학 분쟁은 무겁게 보되, 유가 방향은 실데이터와 일치시키십시오:
{
  "score": 0~100 정수 (높을수록 증시에 부담),
  "direction": "부담 | 중립 | 우호",
  "summary": "현재 정치·정책發 증시 리스크 한두 문장 (high/medium 사안만, 유가 방향은 실데이터와 일치)",
  "drivers": ["핵심 변수 1", "핵심 변수 2", "핵심 변수 3"],
  "material": [영향도 high/medium인 헤드라인 번호만 배열로 (예: [1,3,4]). low(연관성 약함)는 제외]
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
    const p = parseJsonLoose<{ score: number; direction: PoliticalRisk["direction"]; summary: string; drivers: string[]; material?: number[] }>(text);
    const newsScore = Math.max(0, Math.min(100, Math.round(Number(p.score ?? 50))));
    const { score, direction } = combine(newsScore, macro.score);
    // 영향도 high/medium으로 판정된 헤드라인만 근거로 노출(연관성 약한 기사 제외).
    // 단, 너무 적게 남으면(0~1개) 신뢰도 우려로 원본 상위를 유지.
    const idx = Array.isArray(p.material)
      ? p.material.map((n) => Math.round(Number(n)) - 1).filter((i) => i >= 0 && i < headlines.length)
      : [];
    const filtered = idx.length >= 2 ? Array.from(new Set(idx)).map((i) => headlines[i]) : headlines;
    return {
      score,
      newsScore,
      macroScore: macro.score,
      direction,
      summary: String(p.summary ?? "").slice(0, 300),
      drivers: (p.drivers ?? []).slice(0, 5).map((d) => String(d).slice(0, 120)),
      headlines: filtered,
      macro: macro.signals,
      isFallback: false,
    };
  } catch {
    return fallback(headlines, macro);
  }
}
