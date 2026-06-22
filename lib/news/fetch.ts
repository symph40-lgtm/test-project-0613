// Google News RSS 기반 뉴스 수집 (API 키 불필요)
// https://news.google.com/rss/search?q=<query>&hl=ko&gl=KR&ceid=KR:ko

export type NewsItem = {
  title: string;
  link: string;
  source: string;
  pubDate: string; // ISO
};

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

// RSS XML 파싱 (의존성 없이 정규식 기반)
function parseRss(xml: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  const itemBlocks = xml.split(/<item>/).slice(1);

  for (const block of itemBlocks) {
    if (items.length >= limit) break;

    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);

    if (!titleMatch) continue;

    const rawTitle = stripCdata(titleMatch[1]);
    // Google News 제목은 "제목 - 언론사" 형태가 많음
    const title = decodeEntities(rawTitle).replace(/\s-\s[^-]+$/, "").trim();

    const pubDate = dateMatch ? new Date(dateMatch[1].trim()).toISOString() : "";

    items.push({
      title: title || decodeEntities(rawTitle),
      link: linkMatch ? linkMatch[1].trim() : "",
      source: sourceMatch ? decodeEntities(stripCdata(sourceMatch[1])) : "Google News",
      pubDate,
    });
  }

  return items;
}

export async function fetchNews(query: string, limit = 6): Promise<NewsItem[]> {
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=ko&gl=KR&ceid=KR:ko`;

  try {
    const res = await fetch(url, {
      next: { revalidate: 600 }, // 10분 캐시
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StockguardBot/1.0)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, limit);
  } catch {
    return [];
  }
}

// 시장 전반 뉴스
export async function fetchMarketNews(limit = 6): Promise<NewsItem[]> {
  return fetchNews("코스피 OR 증시 OR 반도체 OR 환율 OR 금리", limit);
}

// 보유 종목 관련 뉴스 (상위 몇 개 종목 기준)
export async function fetchPositionNews(
  tickers: string[],
  limit = 6,
): Promise<NewsItem[]> {
  if (tickers.length === 0) return fetchMarketNews(limit);
  const query = tickers.slice(0, 4).map((t) => `"${t}"`).join(" OR ");
  return fetchNews(query, limit);
}

// 반도체 섹터에 영향 주는 뉴스를 '골고루' — 보유 종목 + 섹터 토픽을 각각 검색 후
// 유사 기사(같은 사건 중복) 제거 + 토픽 라운드로빈으로 다양성 확보 (최대 limit개)
const SEMI_TOPICS = [
  "반도체 업황",
  "HBM 메모리",
  "D램 낸드 가격",
  "AI 반도체",
  "엔비디아 실적",
  "마이크론 반도체",
  "반도체 수출 한국",
  "반도체 규제 트럼프",
  "TSMC 파운드리",
  "필라델피아 반도체지수",
];

function tokenizeTitle(title: string): Set<string> {
  const cleaned = title.replace(/[^0-9A-Za-z가-힣 ]/g, " ");
  return new Set(
    cleaned
      .split(/\s+/)
      .map((w) => w.replace(/(은|는|이|가|을|를|에|의|로|와|과|도|만|까지|부터|제치고|제쳤)$/, ""))
      .filter((w) => w.length >= 2),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

export async function fetchSemiSectorNews(tickers: string[], limit = 15, maxAgeHours = 24): Promise<NewsItem[]> {
  const holdingQueries = tickers.slice(0, 5).map((t) => `"${t}"`);
  const queries = [...holdingQueries, ...SEMI_TOPICS];
  const perQuery = 8;
  const results = await Promise.all(queries.map((q) => fetchNews(q, perQuery)));

  // 당일(최근 maxAgeHours) 뉴스만 — 너무 오래된 기사 제외
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const fresh = (n: NewsItem): boolean => {
    const ts = n.pubDate ? new Date(n.pubDate).getTime() : NaN;
    return !isNaN(ts) && ts >= cutoff;
  };

  // 토픽 라운드로빈으로 펼침 → 한 사건이 목록을 독점하지 않게
  const flat: NewsItem[] = [];
  const maxLen = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < maxLen; i++) for (const r of results) if (r[i]) flat.push(r[i]);

  const seenLink = new Set<string>();
  const kept: { item: NewsItem; tokens: Set<string> }[] = [];
  for (const item of flat) {
    if (kept.length >= limit) break;
    if (!item.title || !item.link || seenLink.has(item.link)) continue;
    if (/google 뉴스/i.test(item.title)) continue;
    if (!fresh(item)) continue; // 오래된/날짜불명 기사 제외
    const tokens = tokenizeTitle(item.title);
    if (tokens.size === 0) continue;
    // 같은 사건(유사 제목) 중복 제거 — 제목 토큰 자카드 유사도 0.45 이상이면 스킵
    if (kept.some((k) => jaccard(k.tokens, tokens) >= 0.45)) continue;
    seenLink.add(item.link);
    kept.push({ item, tokens });
  }
  // 최신순 정렬
  return kept
    .map((k) => k.item)
    .sort((a, b) => (a.pubDate < b.pubDate ? 1 : a.pubDate > b.pubDate ? -1 : 0));
}
