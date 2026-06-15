"use client";

import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, ScoreBar, SectionLabel } from "../../_components/primitives";
import type { BriefingSnapshot, RiskScores } from "@/lib/market/types";

function scoreNote(score: number): string {
  if (score <= 30) return "안정";
  if (score <= 60) return "주의";
  if (score <= 80) return "높음";
  return "취약";
}

function riskScoresToEvidence(scores: RiskScores) {
  return [
    { label: "금리 위험", score: Math.round(scores.rate), note: scoreNote(scores.rate) },
    { label: "환율 위험", score: Math.round(scores.forex), note: scoreNote(scores.forex) },
    { label: "유가 위험", score: Math.round(scores.oil), note: scoreNote(scores.oil) },
    { label: "반도체 섹터", score: Math.round(scores.semiconductor), note: scoreNote(scores.semiconductor) },
    { label: "수급 위험", score: Math.round(scores.supply), note: scoreNote(scores.supply) },
    { label: "채권 이동", score: Math.round(scores.bond), note: scoreNote(scores.bond) },
  ];
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

export default function EvidenceClient({ snapshot }: { snapshot: BriefingSnapshot | null }) {
  const router = useRouter();
  const ai = snapshot?.ai_output;
  const riskScores = snapshot?.risk_scores;
  const evidenceScores = riskScores ? riskScoresToEvidence(riskScores) : null;
  // AI 응답에 일부 배열 필드가 누락돼도 페이지가 죽지 않도록 방어
  const coreIssues = ai?.coreIssues ?? [];
  const supplyNotes = ai?.supplyNotes ?? [];
  const issuesDuration = ai?.issuesDuration ?? [];
  // 가로축(큰 장세 압력) = 실제 종합 리스크 점수 기반 (AI 주관값 대신 데이터 기반)
  const pressureLevel =
    snapshot?.risk_score != null ? snapshot.risk_score / 100 : (ai?.pressureLevel ?? 0.5);
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
            <div className="divide-y divide-divider">
              {evidenceScores.map((s) => (
                <ScoreBar key={s.label} label={s.label} score={s.score} note={s.note} />
              ))}
            </div>
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
            </ul>
          </Card>

          {/* 수급 */}
          <Card className="mt-4">
            <SectionLabel>수급</SectionLabel>
            <ul className="space-y-1.5">
              {supplyNotes.map((s) => (
                <li key={s} className="flex gap-2 text-[16px]">
                  <span className="text-ink-48">·</span>
                  {s}
                </li>
              ))}
            </ul>
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
