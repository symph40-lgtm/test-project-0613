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

export default function EvidenceClient({ snapshot }: { snapshot: BriefingSnapshot | null }) {
  const router = useRouter();
  const ai = snapshot?.ai_output;
  const riskScores = snapshot?.risk_scores;
  const evidenceScores = riskScores ? riskScoresToEvidence(riskScores) : null;
  const pressureLevel = ai?.pressureLevel ?? 0.5;
  const situationLevel = ai?.situationLevel ?? 0.5;

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
            {ai.issuesDuration.length > 0 && (
              <p className="mt-3 text-[14px] text-ink-48">
                이슈 지속성:{" "}
                <span className="text-ink">
                  {ai.issuesDuration[0].duration === "이상" ? "높음" : ai.issuesDuration[0].duration}
                </span>{" "}
                · {ai.issuesDuration[0].issue}
              </p>
            )}
          </Card>

          {/* 2차원 맵 */}
          <Card className="mt-4">
            <SectionLabel>큰 장세 × 오늘 상황</SectionLabel>
            <p className="text-[15px] text-ink-80">
              {ai.coreIssues.join(" · ")}
            </p>
            <TwoAxisMap pressureLevel={pressureLevel} situationLevel={situationLevel} />
            <p className="mt-3 text-[15px] font-semibold">
              판단: 압력 {Math.round(pressureLevel * 100)}% · 상황 {situationLevel >= 0.5 ? "악화" : "완화"} 경향
            </p>
          </Card>

          {/* 수급 */}
          <Card className="mt-4">
            <SectionLabel>수급</SectionLabel>
            <ul className="space-y-1.5">
              {ai.supplyNotes.map((s) => (
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
              {ai.coreIssues.map((s) => (
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
          <div className="relative aspect-[16/9] rounded-[8px] border border-hairline bg-pearl">
            <div className="absolute left-1/2 top-0 h-full w-px bg-hairline" />
            <div className="absolute left-0 top-1/2 h-px w-full bg-hairline" />
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
            <span>낮음</span>
            <span>큰 장세 압력</span>
            <span>높음</span>
          </div>
        </div>
      </div>
    </div>
  );
}
