// 전일 이슈 브리핑 (사용자 지시 2026-07-29 아침): ①전날 발표 이벤트·실적과 그 영향 중 비중 큰 것
// ②전날 주요 정책·정치(지정학 — 이란 전쟁 등) 변화를 모아 아침 브리핑 문자로.
// 뉴스 수집(newsRisk와 동일 인프라) → AI가 '비중 큰 것만' 3~5개 선별·1줄 요약.
// 비중 큰 이슈가 없으면 null(문자 생략 — 소음 방지, 사용자 문자 정책과 일치).

import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";
import { fetchNews } from "@/lib/news/fetch";

const QUERIES = [
  "삼성전자 SK하이닉스 실적 발표",
  "미국 빅테크 반도체 실적",
  "연준 FOMC 금리 결정",
  "반도체 수출 규제 정책",
  "이란 중동 전쟁 지정학",
  "관세 무역 협상 정책",
  "정부 증시 부양 정책",
];

export async function buildIssueBriefSms(): Promise<string | null> {
  if (!hasAiKey()) return null;
  try {
    const batches = await Promise.all(QUERIES.map((q) => fetchNews(q, 6).catch(() => [])));
    const cutoff = Date.now() - 26 * 3600e3; // 전일 아침 브리핑 이후 ~26시간
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const n of batches.flat()) {
      if (!n.pubDate || new Date(n.pubDate).getTime() < cutoff) continue;
      const k = n.title.slice(0, 30);
      if (seen.has(k)) continue;
      seen.add(k);
      titles.push(`- ${n.title} (${n.source})`);
      if (titles.length >= 40) break;
    }
    if (titles.length < 3) return null;

    const prompt = `너는 삼성전자·SK하이닉스·반도체 지수를 매매하는 트레이더의 아침 브리핑 작성자다.
아래는 지난 24시간 헤드라인이다. 이 중 오늘 국장·미장 반도체에 영향 비중이 큰 것만 골라라:
① 전날 발표된 실적·이벤트(기업 실적, FOMC·CPI 등 지표 발표 결과)와 그 영향
② 전날의 주요 정책·정치 변화(정부 정책, 규제, 전쟁·지정학)

규칙: 비중 큰 것만 최대 5개. 이미 여러 날 지난 이슈·상투적 시황 기사·예고성 기사(발표 예정)는 제외.
각 항목은 "사실 + 시장 영향 방향"을 40자 이내 한 줄로.

JSON만 출력:
{"items":[{"t":"한 줄 요약(40자 이내)","kind":"실적" 또는 "이벤트" 또는 "정책" 또는 "지정학","impact":"호재" 또는 "악재" 또는 "중립"}],"empty":비중 큰 이슈가 하나도 없으면 true}

헤드라인:
${titles.join("\n")}`;

    const res = await getAiClient().messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    const j = parseJsonLoose<{ items?: { t?: string; kind?: string; impact?: string }[]; empty?: boolean }>(text);
    if (j.empty || !Array.isArray(j.items) || j.items.length === 0) return null;
    const mark = (im: string) => (im === "호재" ? "▲" : im === "악재" ? "▼" : "·");
    const evt = j.items.filter((x) => x.kind === "실적" || x.kind === "이벤트").slice(0, 4);
    const pol = j.items.filter((x) => x.kind === "정책" || x.kind === "지정학").slice(0, 4);
    if (evt.length + pol.length === 0) return null;
    const md = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 10).replace("-", "/");
    const lines: string[] = [`[전일 이슈 ${md}]`];
    if (evt.length) lines.push(`■실적·이벤트`, ...evt.map((x) => ` ${mark(String(x.impact))} ${String(x.t).slice(0, 44)}`));
    if (pol.length) lines.push(`■정책·지정학`, ...pol.map((x) => ` ${mark(String(x.impact))} ${String(x.t).slice(0, 44)}`));
    lines.push(`(▲호재 ▼악재 — AI 선별, 비중 큰 것만)`);
    return lines.join("\n");
  } catch {
    return null; // 실패 시 본 브리핑만 발송
  }
}
