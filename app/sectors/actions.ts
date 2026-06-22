"use server";

import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";
import { fetchEpsRevision, SECTOR_REPS, type SectorFlow } from "@/lib/market/sectors";

// 100점 조건표 항목별 점수
export type ScoredItem = { label: string; score: number; max: number; note: string };

export type SemiDiagnosis = {
  total: number;
  verdict: string;
  items: ScoredItem[];
  outlook: string;  // 방향 전망 (반등/추가 상승/조정 위험)
  stance: string;   // 보유 관점 매수/매도 결론
  notes: string;
};

// 반도체 외 유망 섹터 — 반도체와 동일한 깊이(8항목 점수 + 섹터별 핵심 지표)
export type SectorPick = {
  sector: string;
  etf: string;
  total: number;            // /100
  verdict: string;
  items: ScoredItem[];      // 8개 항목 점수
  reason: string;           // 구조적 주도 vs 단기 테마 판정 근거
  outlook: string;          // 방향 전망 — 다시 오를지(반등) vs 더 떨어질지(추가 하락)
  keyIndicators: string[];  // 섹터별 핵심 점검 지표
  buyTiming: string;
  watch: string;
  risks: string;
};

export type SectorReco = {
  overview: string;
  picks: SectorPick[];
  semiconductor: SemiDiagnosis | null;
  isFallback: boolean;
};

const FRAMEWORK = `[100점 조건표] 실적 전망 상향 20 · 기관·외국인 수급 20 · 거래대금 증가 15 · 글로벌 동조화 10 · 정책·산업 모멘텀 10 · 차트 정배열·신고가 10 · 업종 내 확산 10 · 밸류에이션 정당화 5.
판정: 80+ 주도 가능성 높음 / 65~79 단기 주도 가능 / 50~64 테마성 / 50미만 주도 아님.
[테마 vs 주도] 주가가 오른 뒤에도 실적 전망이 오르고 외국인·기관 동시 매수·거래대금이 업종 전체로 확산되면 '구조적 주도'. 주가만 오르고 실적 전망 그대로·개인만 매수·1~2종목만 오르면 '단기 테마'.`;

// 섹터별 특히 점검해야 할 핵심 지표 (정성평가 가이드)
const SECTOR_GUIDE = `[섹터별 핵심 점검 지표]
- 전력기기·전선·변압기: 미국 전력망 투자, 변압기 수출 단가, 수주잔고, 구리 가격, 북미 매출 비중
- 조선: 수주잔고, 선가지수(Clarksons), LNG선 수주, 환율
- 방산: 방산 수출 계약, 정부 국방예산, 수주잔고
- 원전·전력인프라: 원전 수출계약, SMR 정책, 전력설비 투자, 글로벌 원전 재개
- 자동차·전장·로봇: 전기차·하이브리드 판매, 전장/로봇 매출 비중, 환율, 영업이익률
- 2차전지: 전기차 수요, 배터리 가격, 수주, 미국 IRA 정책
- 바이오·제약: 임상 2/3상 결과, 기술수출, FDA 일정, 매출 발생, 대형제약 협업, CDMO/비만/항암
- 화장품·수출소비재: 미국·일본·중국 수출, 브랜드 확산, 면세점, 영업이익률
- 은행·증권: 금리·정책, 배당, 거래대금
- 건설·철강·운송: 경기·금리·환율·원자재 가격`;

const SYSTEM = `당신은 한국 증시 섹터 전략가입니다. 아래 프레임워크와 섹터별 핵심 지표로 '깊이 있게' 채점합니다.
[방향 전망 핵심] 단순히 '얼마나 떨어졌나'가 아니라 '다시 오를지(반등) vs 더 떨어질지(추가 하락)'와 매수 매력도를 판단하십시오.
- 매수 매력 높음(반등 가능): 많이 빠졌는데 실적 전망은 오히려 상향(실적-주가 괴리) + 과매도(RSI 낮음) + 외국인·기관이 바닥에서 순매수 전환 + 거래량 동반 반등 시작.
- 추가 하락 위험: 역배열 지속 + 외국인·기관 순매도 + 거래량 없는 하락 + 실적 전망도 하향.
- 'outlook' 필드에 '반등 가능/바닥 확인 필요/추가 하락 위험' 중 하나로 방향을 명시하고 근거를 적으십시오. (제공된 '매수매력도' 점수와 EPS 리비전을 우선 근거로)
[현재 주도력 핵심 규칙] 'dataScore(주도력)'는 지금 강한 섹터를, '매수매력도'는 조정 후 반등 매력을 나타냅니다. 둘은 다를 수 있습니다(예: 반도체는 주도력 높지만 신고가라 매수매력은 낮을 수 있고, 조정 섹터는 주도력 낮지만 매수매력이 높을 수 있음).
- '차트 정배열·신고가'(10점)는 전고점 대비 위치로 채점: 신고가권(전고점 -3% 이내)=9~10점, -10%=5점, -20% 이상 하락=0~2점.
- 총점도 이를 반영: 신고가권에서 강하게 오르는 섹터와, 전고점 대비 15%+ 하락한 섹터는 총점이 '뚜렷이'(최소 10점 이상) 벌어져야 합니다. 둘을 비슷한 점수로 주지 마십시오.
- verdict/reason에 전고점 대비 하락이 크면 '되돌림·주도력 약화', 신고가권이면 '현재 주도 지속'을 명시하십시오.
반도체도 같은 조건표로 항목별 채점하되, 보유 관점에서 매수/매도를 판단합니다(조건 강하게 충족 + 신고가·과열·급등 후반이면 '차익실현·레버리지 축소·비중 조절', 주도력 약화면 '비중 축소', 건강한 주도면 '보유 유지').
반도체 외 유망 섹터 2개도 반도체와 '동일한 깊이'로 8항목 점수 + 섹터별 핵심 지표 + 리스크까지 분석합니다.
규칙: 제공된 수치 신호(수급·거래대금·상대강도·정배열·신고가)는 그대로 반영하고, 실적·정책·글로벌·확산·밸류는 지식으로 보수적 평가(없는 수치 지어내지 말 것). 단정·투자권유 금지, 코칭 표현. JSON만 반환.`;

const fmtLine = (s: SectorFlow) =>
  `${s.sector}(${s.etf}): 당일 ${s.changePercent?.toFixed(2) ?? "N/A"}% · 전고점대비 ${s.drawdown ?? "N/A"}%${s.near52wHigh ? "(신고가권)" : ""} · RSI ${s.rsi14 ?? "N/A"}·볼린저%B ${s.pctB ?? "N/A"} · 상대강도 ${s.relStrength ?? "N/A"}%p · ${s.maAligned ? "정배열" : "역배열/혼조"} · 거래량배수 ${s.volRatio ?? "N/A"} · 외인5일 ${s.foreign5d?.toLocaleString("ko-KR") ?? "N/A"}/기관5일 ${s.inst5d?.toLocaleString("ko-KR") ?? "N/A"}(동시순매수 ${s.bothBuying ? "O" : "X"}) · 주도력 ${s.dataScore}·매수매력도 ${s.buyAttract}`;

const ITEMS_SCHEMA = `[
      {"label":"실적 전망 상향","score":0~20,"max":20,"note":"근거 짧게"},
      {"label":"기관·외국인 수급","score":0~20,"max":20,"note":""},
      {"label":"거래대금 증가","score":0~15,"max":15,"note":""},
      {"label":"글로벌 동조화","score":0~10,"max":10,"note":""},
      {"label":"정책·산업 모멘텀","score":0~10,"max":10,"note":""},
      {"label":"차트 정배열·신고가","score":0~10,"max":10,"note":""},
      {"label":"업종 내 확산","score":0~10,"max":10,"note":""},
      {"label":"밸류에이션 정당화","score":0~5,"max":5,"note":""}
    ]`;

function dataSemiFallback(semi: SectorFlow | null, rev: number | null = null): SemiDiagnosis | null {
  if (!semi) return null;
  const supply = semi.bothBuying ? 14 : (semi.foreign5d ?? 0) > 0 ? 8 : 4;
  const tv = (semi.volRatio ?? 0) >= 1.5 ? 13 : (semi.volRatio ?? 0) >= 1.2 ? 8 : 5;
  const chart = (semi.maAligned ? 6 : 0) + (semi.near52wHigh ? 4 : 0);
  const earn = rev !== null ? Math.max(0, Math.min(20, Math.round(((rev + 2) / 12) * 20))) : 0;
  const items: ScoredItem[] = [
    { label: "실적 전망 상향", score: earn, max: 20, note: rev !== null ? `EPS리비전 ${rev >= 0 ? "+" : ""}${rev}%` : "AI 분석 필요" },
    { label: "기관·외국인 수급", score: supply, max: 20, note: "ETF 수급 기준(종목 수급과 다를 수 있음)" },
    { label: "거래대금 증가", score: tv, max: 15, note: `거래량 배수 ${semi.volRatio ?? "?"}` },
    { label: "글로벌 동조화", score: 0, max: 10, note: "AI 분석 필요" },
    { label: "정책·산업 모멘텀", score: 0, max: 10, note: "AI 분석 필요" },
    { label: "차트 정배열·신고가", score: chart, max: 10, note: `${semi.maAligned ? "정배열" : "비정배열"}${semi.near52wHigh ? "·신고가근접" : ""}` },
    { label: "업종 내 확산", score: 0, max: 10, note: "AI 분석 필요" },
    { label: "밸류에이션 정당화", score: 0, max: 5, note: "AI 분석 필요" },
  ];
  const total = items.reduce((a, b) => a + b.score, 0);
  const overheated = semi.near52wHigh && (semi.changePercent ?? 0) > 2;
  return {
    total,
    verdict: "AI 미사용 — 데이터 항목만 채점",
    items,
    outlook: overheated ? "신고가·과열권 — 추가 상승보다 조정 가능성 유의." : "데이터 기준 — 추세·수급 확인 필요.",
    stance: overheated
      ? "신고가·급등 구간 — 신규는 눌림 대기, 보유는 레버리지 축소·일부 이익실현 검토."
      : "데이터 신호 기준 — 수급·거래대금 확인 후 분할 접근 검토.",
    notes: "실적·정책·확산은 AI 분석에서 평가됩니다(현재 AI 미사용).",
  };
}

const clampItem = (it: ScoredItem): ScoredItem => ({
  label: String(it.label ?? "").slice(0, 30),
  score: Math.max(0, Math.round(Number(it.score ?? 0))),
  max: Math.max(1, Math.round(Number(it.max ?? 10))),
  note: String(it.note ?? "").slice(0, 140),
});

export async function recommendSectors(sectors: SectorFlow[]): Promise<SectorReco> {
  const semi = sectors.find((s) => s.isSemi) ?? null;
  // 매수매력도(반등 매력) 높은 순 — 픽은 이 상위에서 선정해 표와 일치시킴
  const others = sectors
    .filter((s) => !s.isSemi)
    .sort((a, b) => b.buyAttract - a.buyAttract)
    .slice(0, 6);

  const fallback = (): SectorReco => ({
    overview: "데이터 신호 기준(AI 미사용/지연).",
    picks: [...others].sort((a, b) => b.buyAttract - a.buyAttract).slice(0, 2).map((s) => ({
      sector: s.sector, etf: s.etf, total: s.buyAttract,
      verdict: s.buyAttract >= 60 ? "매수 매력 우위" : "매수 매력 보통",
      items: [],
      reason: `전고점대비 ${s.drawdown ?? "?"}% · RSI ${s.rsi14 ?? "?"} · 동시순매수 ${s.bothBuying ? "O" : "X"} · 매수매력도 ${s.buyAttract}`,
      outlook: s.buyAttract >= 60 ? "낙폭·과매도·수급 기준 반등 매력 — 바닥 확인 후 분할." : "반등 신호 약함 — 추세·수급 확인 필요.",
      keyIndicators: [],
      buyTiming: "외국인·기관 순매수 전환 + 20일선 회복 확인 후 분할 접근 검토.",
      watch: "수급 전환·거래량 동반 반등 여부.",
      risks: "추세 미회복 시 추가 하락 위험.",
    })),
    semiconductor: dataSemiFallback(semi),
    isFallback: true,
  });

  if (!hasAiKey() || sectors.length === 0) return fallback();

  // 미국 대표주 EPS 90일 리비전(실적 전망 상향 실데이터) — 병렬 수집
  const [semiRev, othersRev] = await Promise.all([
    semi ? fetchEpsRevision(SECTOR_REPS[semi.sector] ?? []) : Promise.resolve(null),
    Promise.all(others.map((s) => fetchEpsRevision(SECTOR_REPS[s.sector] ?? []))),
  ]);
  const revStr = (rev: number | null) =>
    rev !== null ? ` · 미국대표주 EPS 90일리비전 ${rev >= 0 ? "+" : ""}${rev}%(실적전망 ${rev > 5 ? "강한 상향" : rev > 1 ? "상향" : rev < -1 ? "하향" : "보합"})` : " · 실적리비전 데이터없음";

  async function callJson<T>(prompt: string, maxTokens: number): Promise<T | null> {
    try {
      const client = getAiClient();
      const msg = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: maxTokens,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content[0].type === "text" ? msg.content[0].text : "";
      return parseJsonLoose<T>(text);
    } catch {
      return null;
    }
  }

  // ① 반도체 진단 (단독 호출 — 출력이 작아 안 잘림)
  const semiPrompt = `${FRAMEWORK}

${SECTOR_GUIDE}

반도체 섹터를 보유 관점에서 8항목 채점하십시오.
- ${semi ? fmtLine(semi) + revStr(semiRev) : "데이터 없음"}
주의: 'ETF 외국인 수급'은 ETF 자체 매매라 구성종목(삼성·SK하이닉스) 실제 수급과 다를 수 있으니, 반도체 대형주 외국인 순매수 흐름을 감안해 평가. '실적 전망 상향' 항목은 위 'EPS 90일 리비전'을 우선 근거로 채점(+5%↑ 강한 상향=높은 점수, 음수=하향=낮은 점수).
note는 12자 이내로 간결히. 다음 JSON으로만:
{ "total":0~100, "verdict":"주도 지속/과열 후반/주도 약화 판정", "items": ${ITEMS_SCHEMA}, "outlook":"방향 전망 — 추가 상승 여력 vs 과열 조정 위험(1문장)", "stance":"보유 관점 결론(보유 유지·레버리지 축소·일부 이익실현·신규 눌림 대기 등 코칭)", "notes":"HBM·DRAM·레버리지·종목 차별화 1~2문장" }`;

  // ② 반도체 외 유망 2개 (단독 호출)
  const picksPrompt = `${FRAMEWORK}

${SECTOR_GUIDE}

다음은 '반도체 외' 섹터를 매수매력도(반등 매력) 높은 순으로 정렬한 것입니다. 이 중 반등 가능성(실적-주가 괴리·수급 유입·과매도 반등)이 가장 높은 2개를 골라 8항목 깊게 채점하십시오(가급적 상위 매수매력도 섹터 우선).
${others.map((s, i) => "- " + fmtLine(s) + revStr(othersRev[i])).join("\n")}
'실적 전망 상향' 항목은 위 'EPS 90일 리비전'을 우선 근거로 채점(+5%↑ 강한 상향=높은 점수, 데이터없음이면 보수적). note는 12자 이내 간결히, keyIndicators는 3~4개. 다음 JSON으로만:
{
  "overview":"섹터 로테이션 흐름 한 줄 (자금이 어디로 도는지)",
  "picks":[
    { "sector":"", "etf":"", "total":0~100, "verdict":"판정", "items": ${ITEMS_SCHEMA}, "reason":"왜 매수 매력이 있는지 2문장", "outlook":"다시 오를지(반등 가능) vs 더 떨어질지(추가 하락 위험) 방향 전망 1~2문장", "keyIndicators":["섹터 핵심 점검 지표 3~4개"], "buyTiming":"매수 타이밍(조건형)", "watch":"모니터링", "risks":"핵심 리스크 1문장" }
  ]
}`;

  const [sdRaw, picksRaw] = await Promise.all([
    callJson<SemiDiagnosis>(semiPrompt, 1500),
    callJson<{ overview: string; picks: SectorPick[] }>(picksPrompt, 2800),
  ]);

  const semiconductor: SemiDiagnosis | null = sdRaw
    ? {
        total: Math.max(0, Math.min(100, Math.round(Number(sdRaw.total ?? 0)))),
        verdict: String(sdRaw.verdict ?? "").slice(0, 60),
        items: (sdRaw.items ?? []).slice(0, 8).map(clampItem),
        outlook: String(sdRaw.outlook ?? "").slice(0, 200),
        stance: String(sdRaw.stance ?? "").slice(0, 300),
        notes: String(sdRaw.notes ?? "").slice(0, 300),
      }
    : dataSemiFallback(semi, semiRev);

  const picks: SectorPick[] = picksRaw?.picks
    ? picksRaw.picks.slice(0, 2).map((x) => ({
        sector: String(x.sector ?? "").slice(0, 30),
        etf: String(x.etf ?? "").slice(0, 40),
        total: Math.max(0, Math.min(100, Math.round(Number(x.total ?? 50)))),
        verdict: String(x.verdict ?? "").slice(0, 60),
        items: (x.items ?? []).slice(0, 8).map(clampItem),
        reason: String(x.reason ?? "").slice(0, 400),
        outlook: String(x.outlook ?? "").slice(0, 300),
        keyIndicators: (x.keyIndicators ?? []).slice(0, 6).map((k) => String(k).slice(0, 120)),
        buyTiming: String(x.buyTiming ?? "").slice(0, 300),
        watch: String(x.watch ?? "").slice(0, 200),
        risks: String(x.risks ?? "").slice(0, 300),
      }))
    : fallback().picks;

  return {
    overview: String(picksRaw?.overview ?? "").slice(0, 200),
    picks,
    semiconductor,
    isFallback: !sdRaw && !picksRaw,
  };
}
