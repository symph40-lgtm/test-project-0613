// 뉴스 위험도 (0~10) — 비정형 이슈(전쟁·정치 발언·규제 등)를 AI로 점수화해 표기.
// ⚠ 표시·기록 전용, 판정 감산 아님 — 과거 백테스트 불가하므로 60일 라이브 채점 후 게이트 승격 검토
//   (predict_daily_days.macro.newsRisk에 매일 저장되므로 label_r1·r3과 상관 분석 가능).
// 기획: docs/predict-daily-spec.md 6장. 하루 1회만 AI 호출 (당일 행에 캐시).

import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";
import { fetchNews } from "@/lib/news/fetch";

export type NewsRisk = { score: number; note: string };

const QUERIES = [
  "삼성전자 SK하이닉스",
  "반도체 수출 규제",
  "미국 금리 연준",
  "전쟁 지정학 위기",
  "관세 무역 갈등",
  "코스피 급락",
];

export async function assessNewsRisk(): Promise<NewsRisk | null> {
  if (!hasAiKey()) return null;
  try {
    const batches = await Promise.all(QUERIES.map((q) => fetchNews(q, 5).catch(() => [])));
    const cutoff = Date.now() - 24 * 3600e3;
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const n of batches.flat()) {
      if (!n.pubDate || new Date(n.pubDate).getTime() < cutoff) continue;
      const k = n.title.slice(0, 30);
      if (seen.has(k)) continue;
      seen.add(k);
      titles.push(`- ${n.title} (${n.source})`);
      if (titles.length >= 30) break;
    }
    if (titles.length === 0) return { score: 0, note: "특이 뉴스 없음" };

    const prompt = `너는 한국 반도체 대형주(삼성전자·SK하이닉스)를 2~5일 보유하는 스윙 트레이더의 리스크 애널리스트다.
아래 최근 24시간 헤드라인을 보고, 향후 1~3거래일 한국 증시(특히 두 종목)의 "하방 위험"을 0~10 정수로 평가하라.

기준: 0~2 평온 / 3~4 통상 잡음 / 5~6 경계(정책·지정학 불확실성이 구체화) / 7~8 위험(전쟁·급격한 정책 충격 임박, 대형 규제 발표) / 9~10 위기(개전·금융 시스템 위기).
주의: 호재는 무시하라(하방 위험 척도다). 헤드라인의 상투적 공포 표현("폭락 공포" 따위)에 끌려가지 말고 실체적 사건·발언·일정 중심으로 평가하라. 이미 시장에 다 반영된 오래된 이슈는 가중하지 말라.

JSON만 출력: {"score": 정수, "note": "가장 중요한 위험 요인 한 줄(15자 이내, 없으면 '특이사항 없음')"}

헤드라인:
${titles.join("\n")}`;

    const res = await getAiClient().messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    const j = parseJsonLoose<{ score?: number; note?: string }>(text);
    const score = Math.max(0, Math.min(10, Math.round(Number(j.score ?? 0))));
    const note = String(j.note ?? "").slice(0, 20) || "특이사항 없음";
    return { score, note };
  } catch {
    return null; // 실패 시 표기 생략 — 판정에는 영향 없음
  }
}
