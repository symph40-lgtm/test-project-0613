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
