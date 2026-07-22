// 뉴스 위험도 (0~10) — 비정형 이슈(전쟁·정치 발언·규제 등)를 AI로 점수화해 표기.
// ⚠ 표시·기록 전용, 판정 감산 아님 — 과거 백테스트 불가하므로 60일 라이브 채점 후 게이트 승격 검토
//   (predict_daily_days.macro.newsRisk에 매일 저장되므로 label_r1·r3과 상관 분석 가능).
// 기획: docs/predict-daily-spec.md 6장. 하루 1회만 AI 호출 (당일 행에 캐시).

import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";
import { fetchNews } from "@/lib/news/fetch";

export type NewsRisk = {
  score: number;
  note: string;
  detail?: { t: string; s: number }[]; // 개별 뉴스별 삼전 영향도 상위 3건 (기록용 — DB macro.newsDetail)
};

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

    const prompt = `너는 삼성전자를 기준으로 2~5일 보유하는 스윙 트레이더의 리스크 애널리스트다.
아래 최근 24시간 헤드라인 각각이 삼성전자 주가에 미칠 영향을 평가한 뒤(악재만 — 호재·무관은 0점),
향후 1~3거래일 "하방 위험" 종합 점수를 0~10 정수로 매겨라.

종합 기준: 0~2 평온 / 3~4 통상 잡음 / 5~6 경계(정책·지정학 불확실성 구체화) / 7~8 위험(전쟁·급격한 정책 충격 임박, 대형 규제 발표) / 9~10 위기(개전·금융 시스템 위기).
주의: 상투적 공포 표현("폭락 공포" 따위)에 끌려가지 말고 실체적 사건·발언·일정 중심. 이미 시장에 반영된 오래된 이슈는 가중하지 말 것.

JSON만 출력:
{"score": 종합 정수, "note": "핵심 악재 한 줄 요약(공백 포함 25자 이내, 잘리지 않는 완결 문구, 없으면 '특이사항 없음')", "top": [{"t": "뉴스 요약(20자 이내)", "s": 삼전 악재영향 0~10}, ...상위 3건]}

헤드라인:
${titles.join("\n")}`;

    const res = await getAiClient().messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    const j = parseJsonLoose<{ score?: number; note?: string; top?: { t?: string; s?: number }[] }>(text);
    const score = Math.max(0, Math.min(10, Math.round(Number(j.score ?? 0))));
    const note = String(j.note ?? "").slice(0, 28) || "특이사항 없음";
    const detail = Array.isArray(j.top)
      ? j.top.slice(0, 3).map((x) => ({ t: String(x.t ?? "").slice(0, 24), s: Math.max(0, Math.min(10, Math.round(Number(x.s ?? 0)))) }))
      : undefined;
    return { score, note, detail };
  } catch {
    return null; // 실패 시 표기 생략 — 판정에는 영향 없음
  }
}
