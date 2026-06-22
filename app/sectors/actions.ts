"use server";

import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";
import type { SectorFlow } from "@/lib/market/sectors";

export type SectorPick = {
  sector: string;
  etf: string;
  score: number;        // 0~100 주도 섹터 점수
  verdict: string;      // 판정 (주도 가능성/단기주도/테마)
  reason: string;       // 근거
  checklist: { label: string; ok: boolean }[]; // 5대 필수조건 충족 여부
  buyTiming: string;    // 매수 타이밍 (조건형)
  watch: string;        // 모니터링 포인트
};

export type SectorReco = {
  overview: string;
  picks: SectorPick[];
  isFallback: boolean;
};

// 사용자 프레임워크 반영: 단기 테마가 아니라 '구조적 주도 섹터'인지 판별
const SYSTEM = `당신은 한국 증시 섹터 로테이션 전략가입니다. '반도체 외 새로운 주도 섹터'를 발굴하되, 단기 테마와 구조적 주도 섹터를 엄격히 구분합니다.

[판단 철학]
주가가 오른 뒤에도 실적 전망이 계속 오르고, 외국인·기관이 동시에 사며, 거래대금이 업종 전체로 확산되면 '주도 섹터 후보'. 주가만 올랐는데 실적 전망 그대로·개인만 매수·대장주 1~2개만 오르면 '단기 테마'.

[100점 점수표]
- 실적 전망 상향 20 · 기관·외국인 수급 20 · 거래대금 증가 15 · 글로벌 동조화 10 · 정책·산업 모멘텀 10 · 차트 정배열·신고가 10 · 업종 내 확산 10 · 밸류에이션 정당화 5
판정: 80+ 반도체 대안 주도 가능성 높음 / 65~79 단기 주도 가능·추적 / 50~64 테마성 반등 / 50미만 주도 아님.

[5대 필수조건(동시 충족이 핵심)]
1) 최근 5일 거래대금 급증 2) 기관·외국인 동시 순매수 3) 올해·내년 영업이익 전망 상향 4) 업종 ETF가 코스피보다 강함(상대강도) 5) 대장주→2등주·ETF로 확산

규칙: 제공된 수치 신호(수급·거래대금·상대강도·정배열)는 그대로 반영하고, 실적 전망·정책·글로벌·확산·밸류는 당신의 지식으로 보수적으로 평가(없는 수치는 지어내지 말 것). 단정·투자권유 금지, 코칭 표현. JSON만 반환.`;

export async function recommendSectors(sectors: SectorFlow[]): Promise<SectorReco> {
  const top = sectors.slice(0, 8);
  if (!hasAiKey() || top.length === 0) {
    return {
      overview: "수급·거래대금·상대강도 신호 상위 섹터입니다(AI 미사용).",
      picks: top.slice(0, 2).map((s) => ({
        sector: s.sector,
        etf: s.etf,
        score: Math.min(100, s.dataScore + 20),
        verdict: s.dataScore >= 45 ? "단기 주도 가능 (추적 필요)" : "테마성 반등 가능성",
        reason: `외국인·기관 동시 순매수 ${s.bothBuying ? "O" : "X"} · 거래대금 ${s.tradingValueEok ?? "?"}억 · 상대강도 ${s.relStrength ?? "?"} · ${s.maAligned ? "정배열" : "비정배열"}`,
        checklist: [],
        buyTiming: "외국인·기관 동시 순매수 지속 + 20일선 지지 확인 후 분할 접근 검토.",
        watch: "수급 방향 전환·거래대금 위축 시 경계.",
      })),
      isFallback: true,
    };
  }

  const lines = top
    .map(
      (s) =>
        `- ${s.sector}(${s.etf}): 당일 ${s.changePercent?.toFixed(2) ?? "N/A"}% · 외인5일 ${s.foreign5d?.toLocaleString("ko-KR") ?? "N/A"}주/기관5일 ${s.inst5d?.toLocaleString("ko-KR") ?? "N/A"}주(동시순매수 ${s.bothBuying ? "O" : "X"}) · 거래대금 ${s.tradingValueEok ?? "N/A"}억 · 거래량배수 ${s.volRatio ?? "N/A"} · 상대강도(코스피대비) ${s.relStrength ?? "N/A"}%p · ${s.maAligned ? "정배열" : "비정배열"} · 52주위치 ${s.pos52w ?? "N/A"}%${s.near52wHigh ? "(신고가근접)" : ""} · 신호점수 ${s.dataScore}/55`,
    )
    .join("\n");

  const prompt = `다음은 반도체 외 섹터 ETF의 수급·거래대금·상대강도·차트 신호입니다(신호점수 높은 순).

${lines}

위 프레임워크와 데이터로 각 후보를 100점 만점 채점하고, '반도체 대안 주도 섹터' 후보 1~2개를 선정해 JSON으로만 응답하십시오:
{
  "overview": "현재 섹터 로테이션 흐름 한 줄 (어디로 자금이 도는지)",
  "picks": [
    {
      "sector": "섹터명",
      "etf": "대표 ETF명",
      "score": 0~100 정수,
      "verdict": "80+ 주도 가능성 높음 | 65~79 단기 주도 가능 | 50~64 테마성 | 50미만 주도 아님 중 해당 문구",
      "reason": "왜 주도(또는 테마)인지 1~2문장 (실적·수급·거래대금·상대강도 근거)",
      "checklist": [
        {"label":"5일 거래대금 급증","ok":true/false},
        {"label":"기관·외국인 동시 순매수","ok":true/false},
        {"label":"영업이익 전망 상향","ok":true/false},
        {"label":"코스피 대비 상대강도 우위","ok":true/false},
        {"label":"대장주→2등주·ETF 확산","ok":true/false}
      ],
      "buyTiming": "매수 타이밍 — 어떤 조건(예: 20일선 지지·외국인 순매수 지속·눌림)에서 분할 접근할지 (코칭)",
      "watch": "지속 모니터링 포인트 1문장"
    }
  ]
}`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const p = parseJsonLoose<{ overview: string; picks: SectorPick[] }>(text);
    return {
      overview: String(p.overview ?? "").slice(0, 200),
      picks: (p.picks ?? []).slice(0, 2).map((x) => ({
        sector: String(x.sector ?? "").slice(0, 30),
        etf: String(x.etf ?? "").slice(0, 40),
        score: Math.max(0, Math.min(100, Math.round(Number(x.score ?? 50)))),
        verdict: String(x.verdict ?? "").slice(0, 60),
        reason: String(x.reason ?? "").slice(0, 300),
        checklist: (x.checklist ?? []).slice(0, 5).map((c) => ({ label: String(c.label ?? "").slice(0, 40), ok: !!c.ok })),
        buyTiming: String(x.buyTiming ?? "").slice(0, 300),
        watch: String(x.watch ?? "").slice(0, 200),
      })),
      isFallback: false,
    };
  } catch {
    return { overview: "", picks: [], isFallback: true };
  }
}
