"use client";

import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, ScoreBar, SectionLabel } from "../../_components/primitives";
import type { BriefingSnapshot, RiskScores } from "@/lib/market/types";
import type { StockFlow } from "@/lib/market/naver-flow";
import type { PoliticalRisk } from "@/lib/ai/political";

// 정치 리스크 반영 가중치 (데이터 73% + 정치 27%)
const POLITICAL_WEIGHT = 0.27;

// 순매매량(주) 표기: 천 단위 + 매수(빨강)/매도(파랑)
function flowText(v: number | null): { text: string; cls: string } {
  if (v === null) return { text: "—", cls: "text-ink-48" };
  const sign = v > 0 ? "+" : "";
  const cls = v > 0 ? "text-red-600" : v < 0 ? "text-blue-600" : "text-ink-48";
  return { text: `${sign}${v.toLocaleString("ko-KR")}주`, cls };
}

function scoreNote(score: number): string {
  if (score <= 30) return "안정";
  if (score <= 60) return "주의";
  if (score <= 80) return "높음";
  return "취약";
}

// 각 지표 산출 근거 설명
const RISK_DESC: Record<string, string> = {
  "금리 위험": "미국 10년물 금리의 당일 상승폭 기준. 금리가 오를수록 기술주·성장주 밸류에이션 부담이 커집니다.",
  "환율 위험": "달러/원 상승(원화 약세)폭 기준. 원화가 약해지면 외국인 자금 이탈 부담이 커집니다.",
  "유가 위험": "유가 급등은 인플레이션 압력(위험↑), 완만한 하락은 위험으로 보지 않고 급락만 경기둔화 신호로 반영합니다.",
  "반도체 섹터": "필라델피아 반도체지수(SOX)의 당일 하락폭 기준. 삼성전자·SK하이닉스 등 한국 반도체에 직접 영향을 줍니다.",
  "수급 위험": "S&P500·코스피 평균 하락폭 기준. 시장 전반의 매도 압력(수급 악화)을 나타냅니다.",
  "채권 이동": "나스닥 하락 + 미국 금리 상승이 겹치면 점수가 오릅니다. 자금이 주식에서 안전자산(채권)으로 옮겨가려는 위험회피 압력을 뜻합니다.",
};

function riskScoresToEvidence(scores: RiskScores) {
  return [
    { label: "금리 위험", score: Math.round(scores.rate), note: scoreNote(scores.rate) },
    { label: "환율 위험", score: Math.round(scores.forex), note: scoreNote(scores.forex) },
    { label: "유가 위험", score: Math.round(scores.oil), note: scoreNote(scores.oil) },
    { label: "반도체 섹터", score: Math.round(scores.semiconductor), note: scoreNote(scores.semiconductor) },
    { label: "수급 위험", score: Math.round(scores.supply), note: scoreNote(scores.supply) },
    { label: "채권 이동", score: Math.round(scores.bond), note: scoreNote(scores.bond) },
  ].map((s) => ({ ...s, desc: RISK_DESC[s.label] ?? "" }));
}

// 세로축(오늘 상황)을 실제 지수 등락률로 산출 — 0=완화(개선), 1=악화
// 주요 지수가 오를수록 0(완화)에 가깝게, 내릴수록 1(악화)에 가깝게
function deriveSituationLevel(snapshot: BriefingSnapshot): number | null {
  const m = snapshot.market_data;
  if (!m) return null;
  const changes = [
    m.nasdaq?.changePercent,
    m.sox?.changePercent,
    m.kospi?.changePercent,
    m.sp500?.changePercent,
  ].filter((v): v is number => typeof v === "number");
  if (changes.length === 0) return null;
  const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
  // 평균 +3% → 0(완화), 0% → 0.5, -3% → 1(악화)
  return Math.max(0, Math.min(1, 0.5 - avg / 6));
}

export default function EvidenceClient({
  snapshot,
  supplyFlows = [],
  political = null,
  liveScores = null,
  liveComposite = null,
  liveProxy = null,
}: {
  snapshot: BriefingSnapshot | null;
  supplyFlows?: StockFlow[];
  political?: PoliticalRisk | null;
  liveScores?: RiskScores | null;
  liveComposite?: number | null;
  liveProxy?: string | null;
}) {
  const router = useRouter();
  const ai = snapshot?.ai_output;
  // 위험 점수는 현재 라이브 우선(스냅샷은 아침 고정이라 저녁 SOX·선물 하락 미반영)
  const riskScores = liveScores ?? snapshot?.risk_scores;
  const evidenceScores = riskScores ? riskScoresToEvidence(riskScores) : null;
  // AI 응답에 일부 배열 필드가 누락돼도 페이지가 죽지 않도록 방어
  const coreIssues = ai?.coreIssues ?? [];
  const supplyNotes = ai?.supplyNotes ?? [];
  const issuesDuration = ai?.issuesDuration ?? [];
  // 가로축(큰 장세 압력) = 실제 종합 리스크 점수 기반 (라이브 우선)
  const dataPressure =
    (liveComposite ?? snapshot?.risk_score) != null ? (liveComposite ?? snapshot!.risk_score!) / 100 : (ai?.pressureLevel ?? 0.5);
  // 정치·정책·지정학 리스크 27% 블렌딩 (데이터 73%) — 정치 점수가 높을수록 압력 ↑
  const pressureLevel = political
    ? dataPressure * (1 - POLITICAL_WEIGHT) + (political.score / 100) * POLITICAL_WEIGHT
    : dataPressure;
  // 세로축(오늘 상황) = 실제 지수 등락률 기반, 없으면 AI값 폴백
  const situationLevel =
    (snapshot ? deriveSituationLevel(snapshot) : null) ?? ai?.situationLevel ?? 0.5;

  return (
    <PageShell title="판단 근거">
      {!snapshot || !ai || !evidenceScores ? (
        <div className="space-y-4">
          <div className="h-28 animate-pulse rounded-[18px] bg-divider" />
          <p className="text-[15px] text-ink-48">근거 데이터를 불러오고 있습니다.</p>
        </div>
      ) : (
        <>
          {/* 위험 점수 */}
          <Card>
            <SectionLabel>위험 점수</SectionLabel>
            <p className="mb-2 text-[12px] text-ink-48">
              {liveScores ? "현재 실시간 시세 기준" : "아침 스냅샷 기준"}
              {liveProxy ? ` · 코스피는 ${liveProxy}로 대체(정규장 마감)` : ""}
            </p>
            <div className="divide-y divide-divider">
              {evidenceScores.map((s) => (
                <div key={s.label} className="py-1">
                  <ScoreBar label={s.label} score={s.score} note={s.note} />
                  {s.desc && (
                    <p className="pl-[3px] text-[12px] leading-snug text-ink-48">{s.desc}</p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-ink-48">
              점수 구간: 0~30 안정 · 31~60 주의 · 61~80 높음 · 81~100 취약
            </p>
            {issuesDuration.length > 0 && (
              <p className="mt-3 text-[14px] text-ink-48">
                이슈 지속성:{" "}
                <span className="text-ink">
                  {issuesDuration[0].duration === "이상" ? "높음" : issuesDuration[0].duration}
                </span>{" "}
                · {issuesDuration[0].issue}
              </p>
            )}
          </Card>

          {/* 정치·정책·지정학 리스크 — 별도 패널 (크게) */}
          {political && (
            <Card className="mt-4 border-guard/40">
              <SectionLabel>정치·정책·지정학 리스크</SectionLabel>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[24px] font-semibold tabular-nums">{political.score}</span>
                <span className="text-[13px] text-ink-48">/100</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${
                    political.direction === "부담"
                      ? "bg-blue-50 text-blue-600"
                      : political.direction === "우호"
                        ? "bg-red-50 text-red-600"
                        : "bg-ink/10 text-ink-80"
                  }`}
                >
                  증시 {political.direction}
                </span>
                <span className="rounded-full bg-guard/15 px-2 py-0.5 text-[12px] font-medium text-guard">
                  종합 판단에 27% 반영
                </span>
              </div>
              <p className="mt-1 text-[12px] text-ink-48">
                뉴스(지정학·정치) {political.newsScore} · 매크로(유가·금리·인플레) {political.macroScore} → 종합 {political.score} (각 50%)
              </p>
              <p className="mt-2 text-[15px] leading-snug text-ink-80">{political.summary}</p>

              {/* 전쟁→유가→인플레→금리 전이 데이터 */}
              {political.macro.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {political.macro.map((m) => {
                    const cls =
                      m.risk === "high"
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : m.risk === "watch"
                          ? "border-hairline bg-pearl text-ink-80"
                          : "border-red-200 bg-red-50 text-red-600";
                    return (
                      <span key={m.label} className={`rounded-[8px] border px-2.5 py-1 text-[12px] ${cls}`}>
                        <b>{m.label}</b> {m.value} <span className="tabular-nums">({m.change})</span>
                      </span>
                    );
                  })}
                </div>
              )}

              {political.drivers.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {political.drivers.map((d, i) => (
                    <li key={i} className="flex gap-2 text-[14px]">
                      <span className="text-ink-48">·</span>
                      {d}
                    </li>
                  ))}
                </ul>
              )}
              {political.headlines.length > 0 && (
                <div className="mt-3">
                  <p className="text-[12px] font-semibold text-ink-48">근거 뉴스 <span className="font-normal">(최근 24시간 · 최신순 · 반도체 영향도 낮은 기사 제외)</span></p>
                  <ul className="mt-1 space-y-1">
                    {political.headlines.slice(0, 4).map((h, i) => {
                      const d = h.pubDate ? new Date(h.pubDate) : null;
                      const dateStr = d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : null;
                      return (
                        <li key={i}>
                          <a
                            href={h.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[13px] text-ink-80 hover:text-guard hover:underline"
                          >
                            · {dateStr && <span className="text-ink-48 tabular-nums">[{dateStr}]</span>} {h.title} <span className="text-ink-48">({h.source})</span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              <p className="mt-3 text-[12px] leading-snug text-ink-48">
                지정학·정치는 뉴스 기반 AI 추정, 유가·금리·기대인플레는 <b>FRED 실데이터</b>로 전쟁→유가→인플레→금리 전이를 확인합니다
                {political.isFallback ? " (현재 뉴스 신호 부족으로 데이터 중심)" : ""}. 색: 파랑=증시 부담↑, 빨강=완화. 투자 권유가 아니며,
                종합 점수는 아래 2축 맵 가로축에 27% 반영됩니다.
              </p>
            </Card>
          )}

          {/* 2차원 맵 */}
          <Card className="mt-4">
            <SectionLabel>큰 장세 × 오늘 상황</SectionLabel>
            <p className="text-[15px] text-ink-80">
              {coreIssues.join(" · ")}
            </p>
            <TwoAxisMap pressureLevel={pressureLevel} situationLevel={situationLevel} />
            {(() => {
              const v = interpretMap(pressureLevel, situationLevel);
              return (
                <div className="mt-3 rounded-[10px] border border-hairline bg-pearl p-3">
                  <p className="text-[15px] font-semibold">{v.headline}</p>
                  <p className="mt-1 text-[13px] text-ink-80">{v.detail}</p>
                </div>
              );
            })()}
            <ul className="mt-3 space-y-1 text-[12px] text-ink-48">
              <li>· 가로축(큰 장세 압력): 왼쪽 = 안정, 오른쪽 = 위험 누적. 시장 구조적 위험 수준.</li>
              <li>· 세로축(오늘 상황): 위 = 완화(개선), 아래 = 악화(나빠짐). 오늘의 단기 흐름.</li>
              <li>· 점이 <b>왼쪽 위</b>일수록 좋고, <b>오른쪽 아래</b>일수록 나쁩니다.</li>
              {political && (
                <li>· 가로축에는 위 <b>정치·정책·지정학 리스크</b>가 27% 반영돼 있습니다(데이터 73%).</li>
              )}
            </ul>
          </Card>

          {/* 수급 — 네이버 금융 종목별 외국인·기관 순매매 실데이터 */}
          <Card className="mt-4">
            <SectionLabel>수급 (외국인·기관 순매매)</SectionLabel>
            {supplyFlows.length > 0 ? (
              <>
                <div className="overflow-hidden rounded-[10px] border border-hairline">
                  <table className="w-full text-[14px]">
                    <thead className="bg-pearl text-[12px] text-ink-48">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">종목</th>
                        <th className="px-3 py-2 text-right font-medium">외국인</th>
                        <th className="px-3 py-2 text-right font-medium">기관</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-divider">
                      {supplyFlows.map((f) => {
                        const fo = flowText(f.foreign);
                        const inst = flowText(f.institution);
                        return (
                          <tr key={f.code}>
                            <td className="px-3 py-2">{f.ticker}</td>
                            <td className={`px-3 py-2 text-right tabular-nums ${fo.cls}`}>{fo.text}</td>
                            <td className={`px-3 py-2 text-right tabular-nums ${inst.cls}`}>{inst.text}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[12px] text-ink-48">
                  {supplyFlows[0]?.date} {supplyFlows[0]?.provisional ? "장중 잠정" : "확정"} · 순매매량(주) · 매수=빨강, 매도=파랑 · 출처: 네이버 금융
                </p>
              </>
            ) : (
              <div className="text-[15px] text-ink-80">
                <p>
                  지수 흐름 기반 수급 위험 점수:{" "}
                  <span className="font-semibold">
                    {riskScores ? Math.round(riskScores.supply) : "—"}점
                  </span>{" "}
                  ({riskScores ? scoreNote(riskScores.supply) : "—"})
                </p>
                <p className="mt-1 text-[13px] text-ink-48">
                  보유 한국 종목이 없거나 수급 데이터를 불러오지 못했습니다. 지수 등락 기반
                  추정 수급만 표시합니다.
                </p>
              </div>
            )}
          </Card>

          {/* 핵심 이슈 */}
          <Card className="mt-4">
            <SectionLabel>핵심 이슈</SectionLabel>
            <ul className="space-y-1.5">
              {coreIssues.map((s) => (
                <li key={s} className="flex gap-2 text-[16px]">
                  <span className="text-ink-48">·</span>
                  {s}
                </li>
              ))}
            </ul>
          </Card>

          <div className="mt-6">
            <Button variant="primary" onClick={() => router.push("/positions")}>
              내 포지션 검토하기
            </Button>
          </div>
        </>
      )}

      <Disclaimer />
    </PageShell>
  );
}

// 사분면 해석: 압력(x) 낮음 + 상황(y) 완화 = 양호 / 압력 높음 + 악화 = 위험
function interpretMap(
  pressureLevel: number,
  situationLevel: number,
): { headline: string; detail: string } {
  const pressureHigh = pressureLevel >= 0.5;
  const worsening = situationLevel >= 0.5;

  if (!pressureHigh && !worsening)
    return {
      headline: "🟢 양호 — 장이 좋은 편입니다",
      detail: "큰 장세 압력이 낮고 오늘 상황도 개선 흐름입니다. 계획된 비중을 채우기 우호적인 구간입니다.",
    };
  if (pressureHigh && worsening)
    return {
      headline: "🔴 위험 — 장이 나쁜 편입니다",
      detail: "구조적 위험이 높은데 오늘 상황도 악화 중입니다. 방어적 대응(비중 축소·현금 확보) 검토 구간입니다.",
    };
  if (!pressureHigh && worsening)
    return {
      headline: "🟡 주의 — 단기 흔들림",
      detail: "큰 틀은 안정적이나 오늘 단기 흐름이 나빠지고 있습니다. 추격 매수보다 관망이 도움이 될 수 있습니다.",
    };
  return {
    headline: "🟡 주의 — 압력 누적",
    detail: "오늘은 버티고 있으나 구조적 위험이 높은 편입니다. 반등 시 비중 정리를 검토할 수 있습니다.",
  };
}

function TwoAxisMap({
  pressureLevel,
  situationLevel,
}: {
  pressureLevel: number;
  situationLevel: number;
}) {
  // pressureLevel: 0(낮음)~1(높음) → x축 좌→우
  // situationLevel: 0(완화)~1(악화) → y축 위→아래
  const xPct = Math.round(pressureLevel * 80 + 10); // 10%~90%
  const yPct = Math.round(situationLevel * 80 + 10);

  return (
    <div className="mt-4">
      <div className="flex">
        <div className="flex w-6 flex-col items-center justify-between py-1 text-[12px] text-ink-48">
          <span>완화</span>
          <span className="[writing-mode:vertical-rl]">오늘 상황</span>
          <span>악화</span>
        </div>
        <div className="relative flex-1">
          <div className="relative aspect-[16/9] overflow-hidden rounded-[8px] border border-hairline bg-pearl">
            <div className="absolute left-1/2 top-0 h-full w-px bg-hairline" />
            <div className="absolute left-0 top-1/2 h-px w-full bg-hairline" />
            {/* 사분면 라벨 */}
            <span className="absolute left-2 top-1.5 text-[11px] font-medium text-ink-48">양호</span>
            <span className="absolute right-2 bottom-1.5 text-[11px] font-medium text-ink-48">위험</span>
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${xPct}%`, top: `${yPct}%` }}
            >
              <div className="size-3 rounded-full bg-guard ring-4 ring-guard/20" />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 whitespace-nowrap text-[12px] font-semibold text-guard">
                현재
              </span>
            </div>
          </div>
          <div className="mt-1 flex justify-between text-[12px] text-ink-48">
            <span>낮음(안정)</span>
            <span>큰 장세 압력</span>
            <span>높음(위험)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
