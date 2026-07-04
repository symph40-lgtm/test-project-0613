// AI 빅테크發 반도체 급등락 긴급 감지
// 메타·MS·구글·아마존 등 빅테크의 AI 수요·투자 뉴스가 '나오고' + 삼성전자·SK하이닉스가 당일 급등락하면
// 그 뉴스를 원인으로 보고 긴급 알람을 띄운다. (기획: docs/urgent-bigtech-alert.md)
//
// 관련성 우선순위: 한국 증시 + 미 나스닥에 영향을 주는 뉴스, 그중에서도 AI·메모리(HBM·D램)에
// 직결되는 뉴스를 최우선으로 본다. 뉴스는 '당일'(한국시간)만 사용하되, 장 시작 전이면 전일 야간~
// 당일 새벽 미국 뉴스까지 포함한다.
import { fetchNews, type NewsItem } from "@/lib/news/fetch";

export type UrgentNews = {
  title: string;
  source: string;
  link: string;
  pubDate?: string;
  tier: 1 | 2; // 1=나스닥·빅테크 영향, 2=AI·메모리 직결(최우선)
};

export type UrgentAlert = {
  active: boolean;
  direction: "급등" | "급락" | "혼조" | null; // 한국식 색상: 급등=빨강, 급락=파랑
  grade: 1 | 2 | 3;                            // 1=경계, 2=심각, 3=위급 (색 농도 그레이드)
  level: "경계" | "심각" | "위급" | null;
  movers: { ticker: string; changePercent: number }[]; // 트리거된 삼성·하이닉스
  headline: string; // 한 줄 경고
  detail: string;   // 원인 → 취약 종목 → 가능한 결과 → 확인할 지표 (FR-013)
  news: UrgentNews[]; // 원인으로 지목된 긴급뉴스 (AI·메모리 우선 정렬)
  generatedAt: string;
};

// 빅테크 주체 — AI 인프라 캡엑스·수요를 좌우하는 큰손 (소문자 비교)
const BIGTECH = [
  "메타", "meta", "마이크로소프트", "마소", "microsoft", "구글", "알파벳", "google",
  "아마존", "amazon", "엔비디아", "nvidia", "브로드컴", "broadcom", "tsmc", "오픈ai", "openai",
  "하이퍼스케일러", "빅테크", "마이크론", "micron", "amd",
];
// AI 수요·투자·밸류에이션 내러티브 (급등락을 부르는 서사)
const NARRATIVE = [
  "ai 수요", "ai 투자", "ai 반도체", "capex", "캐펙스", "설비투자", "데이터센터",
  "피크아웃", "peak", "버블", "거품", "고점", "과잉투자", "수요 둔화", "둔화", "감산",
  "가이던스", "서프라이즈", "쇼크", "차익실현", "고평가", "밸류에이션",
];
// AI·메모리 직결 — 한국 반도체(삼성·SK하이닉스)에 가장 직접적으로 파급되는 핵심 키워드
const MEMORY_AI = [
  "hbm", "고대역폭", "d램", "dram", "낸드", "nand", "메모리",
  "ai 반도체", "ai 메모리", "ai 가속기", "ai 수요", "고성능 메모리",
];
// 한국 증시 연결고리 — 국내 반도체 종목/섹터 직접 언급
const KR_SEMI = ["삼성전자", "하이닉스", "반도체", "코스피"];

// 뉴스 제목의 관련성 등급 — 0=무관, 1=나스닥·빅테크 영향, 2=AI·메모리 직결(최우선)
// 2등급: AI·메모리 키워드가 있고 + 빅테크/서사/국내 반도체와 연결돼야 함(단순 '메모리' 오탐 방지).
export function newsRelevanceTier(title: string): 0 | 1 | 2 {
  const t = title.toLowerCase();
  const hasEntity = BIGTECH.some((k) => t.includes(k));
  const hasNarrative = NARRATIVE.some((k) => t.includes(k));
  const hasMemoryAi = MEMORY_AI.some((k) => t.includes(k));
  const hasKr = KR_SEMI.some((k) => t.includes(k));
  if (hasMemoryAi && (hasEntity || hasNarrative || hasKr)) return 2;
  if (hasEntity && hasNarrative) return 1;
  return 0;
}

// 제목이 '긴급뉴스'감인지 (관련성 1등급 이상) — 뉴스 목록 뱃지용
export function isBigtechAiNews(title: string): boolean {
  return newsRelevanceTier(title) > 0;
}

// '오늘 장'과 관련된 뉴스 창의 시작 시각(ms, epoch). 한국시간(KST=UTC+9) 기준.
// - 장 시작(09:00 KST) 이후: 오늘 00:00 KST부터 → 당일 뉴스만.
// - 장 시작 전(00:00~09:00 KST): 전일 18:00 KST부터 → 전일 야간~당일 새벽 미국 뉴스 포함.
export function newsWindowStart(now: Date = new Date()): number {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const h = kst.getUTCHours();
  // 오늘 00:00 KST의 실제 UTC epoch (KST 자정 = UTC 전날 15:00)
  const todayMidnightKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600 * 1000;
  // 장 시작 전이면 전일 18:00 KST(=오늘 00:00 KST − 6h)까지 넓혀 간밤 미국 뉴스를 포함
  return h >= 9 ? todayMidnightKst : todayMidnightKst - 6 * 3600 * 1000;
}

// 빅테크 AI 수요·투자 뉴스 전용 수집 (섹터 뉴스만으론 '메타 캡엑스 피크아웃' 류가 누락되므로 별도 쿼리)
const BIGTECH_QUERIES = [
  "메타 OR 마이크로소프트 OR 구글 OR 아마존 AI 투자 OR capex OR 데이터센터",
  "엔비디아 OR 브로드컴 OR TSMC AI 수요 OR 실적 OR 가이던스",
  "AI 버블 OR AI 피크아웃 OR AI 수요 둔화 OR 반도체 고점 OR HBM 수요",
  "삼성전자 OR SK하이닉스 AI 반도체 급락 OR 급등",
];

export async function fetchBigtechAiNews(limit = 12, now: Date = new Date()): Promise<NewsItem[]> {
  const results = await Promise.all(BIGTECH_QUERIES.map((q) => fetchNews(q, 6)));
  const cutoff = newsWindowStart(now); // 당일(장전이면 간밤 미국 포함) 뉴스만
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of results.flat()) {
    if (out.length >= limit) break;
    if (!item.title || !item.link || seen.has(item.link)) continue;
    const ts = item.pubDate ? Date.parse(item.pubDate) : NaN;
    if (isNaN(ts) || ts < cutoff) continue;
    seen.add(item.link);
    out.push(item);
  }
  return out.sort((a, b) => (a.pubDate < b.pubDate ? 1 : a.pubDate > b.pubDate ? -1 : 0));
}

// 삼성·하이닉스로 한정 (SEMI_COMPARE 등에서 넘어온 목록에서 골라냄)
function pickKoreaSemis(
  semis: { ticker: string; changePercent: number | null }[],
): { ticker: string; changePercent: number | null }[] {
  return semis.filter((s) => /삼성전자|하이닉스/.test(s.ticker));
}

function cleanTicker(t: string): string {
  return t.replace(/\s*\(.*\)\s*$/, "").trim();
}

// 긴급 판정 — 가격 트리거(±threshold) AND 뉴스 트리거(빅테크 AI·메모리 서사)
export function detectUrgentBigtechAlert(input: {
  semis: { ticker: string; changePercent: number | null }[];
  news: NewsItem[];
  threshold?: number; // 급등락 기준 %, 기본 3
  now?: Date;
}): UrgentAlert {
  const threshold = input.threshold ?? 3;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const movers = pickKoreaSemis(input.semis)
    .filter((s) => typeof s.changePercent === "number" && Math.abs(s.changePercent) >= threshold)
    .map((s) => ({ ticker: cleanTicker(s.ticker), changePercent: s.changePercent as number }));

  // 당일(장전이면 간밤 미국 포함) 뉴스 중 관련성 1등급 이상만, AI·메모리(2등급) 우선 정렬
  const cutoff = newsWindowStart(now);
  const seen = new Set<string>();
  const cands: (UrgentNews & { ts: number })[] = [];
  for (const n of input.news) {
    if (!n.title || seen.has(n.title)) continue;
    const ts = n.pubDate ? Date.parse(n.pubDate) : NaN;
    if (isNaN(ts) || ts < cutoff) continue;
    const tier = newsRelevanceTier(n.title);
    if (tier === 0) continue;
    seen.add(n.title);
    cands.push({ title: n.title, source: n.source, link: n.link, pubDate: n.pubDate, tier, ts });
  }
  cands.sort((a, b) => b.tier - a.tier || b.ts - a.ts); // AI·메모리 우선 → 그다음 최신
  const urgentNews: UrgentNews[] = cands.slice(0, 6).map(({ ts: _ts, ...rest }) => rest);

  const active = movers.length > 0 && urgentNews.length > 0;
  if (!active) {
    return { active: false, direction: null, grade: 1, level: null, movers, headline: "", detail: "", news: urgentNews, generatedAt: nowIso };
  }

  const allUp = movers.every((m) => m.changePercent > 0);
  const allDown = movers.every((m) => m.changePercent < 0);
  const direction: UrgentAlert["direction"] = allUp ? "급등" : allDown ? "급락" : "혼조";

  // 등급(색 그레이드): 급등락 강도 기준, AI·메모리 직결 뉴스가 있으면 파급력이 커 한 단계 상향(최대 3)
  const maxMove = Math.max(...movers.map((m) => Math.abs(m.changePercent)));
  let grade: 1 | 2 | 3 = maxMove >= 8 ? 3 : maxMove >= 5 ? 2 : 1;
  const hasTopRelevance = urgentNews.some((n) => n.tier === 2);
  if (hasTopRelevance && grade < 3) grade = (grade + 1) as 1 | 2 | 3;
  const level: UrgentAlert["level"] = grade === 3 ? "위급" : grade === 2 ? "심각" : "경계";

  const moversStr = movers
    .map((m) => `${m.ticker} ${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(1)}%`)
    .join(" · ");
  const dirWord = direction === "급등" ? "급등" : direction === "급락" ? "급락" : "급변";
  const headline = `AI 빅테크發 반도체 ${dirWord} 감지 — ${moversStr}`;

  const resultLine =
    direction === "급락"
      ? "AI 메모리(HBM·D램) 수요 눈높이가 낮아지면 반도체주 변동성이 더 커질 수 있습니다."
      : direction === "급등"
        ? "AI 투자·수요 기대가 반영된 반등일 수 있으나, 되돌림 변동성에 유의가 필요합니다."
        : "수급이 엇갈려 방향이 불확실하니 추격 매매보다 확인이 안전합니다.";

  const detail =
    `원인: AI 빅테크(메타 등)의 AI 수요·투자 관련 이슈가 부각됐습니다. → ` +
    `취약 종목: ${moversStr} 로 당일 ${dirWord} 중입니다. → ` +
    `가능한 결과: ${resultLine} → ` +
    `확인할 지표: 필라델피아 반도체지수(SOX)·엔비디아 등 빅테크 주가·미국 선물 흐름을 함께 보세요.`;

  return { active: true, direction, grade, level, movers, headline, detail, news: urgentNews, generatedAt: nowIso };
}
