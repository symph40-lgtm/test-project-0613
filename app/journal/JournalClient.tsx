"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../_components/Shell";
import { Button } from "../_components/Button";
import { Card, SectionLabel, StateNote } from "../_components/primitives";
import { saveActionLog } from "./actions";
import type { GuidanceData } from "./actions";

type ActualAction = "축소" | "유지" | "추가매수" | "전량매도" | "기타";
type FollowLevel = "따름" | "일부 따름" | "따르지 않음";

const ACTION_OPTIONS: ActualAction[] = ["축소했다", "유지했다", "추가 매수했다", "전량 매도했다", "기타"].map(
  (_, i) => (["축소", "유지", "추가매수", "전량매도", "기타"] as ActualAction[])[i]
);
const ACTION_LABELS: Record<ActualAction, string> = {
  축소: "축소했다",
  유지: "유지했다",
  추가매수: "추가 매수했다",
  전량매도: "전량 매도했다",
  기타: "기타",
};
const FOLLOW_LEVELS: FollowLevel[] = ["따름", "일부 따름", "따르지 않음"];

function parseResult(v: string): number | null {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

export default function JournalClient({ guidance }: { guidance: GuidanceData | null }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);

  const [guidanceAction, setGuidanceAction] = useState(guidance?.action ?? "");
  const [guidanceProhibition, setGuidanceProhibition] = useState(guidance?.prohibition ?? "");
  const [ticker, setTicker] = useState("");
  const [action, setAction] = useState<ActualAction>("유지");
  const [follow, setFollow] = useState<FollowLevel>("따름");
  const [reason, setReason] = useState("");
  const [results, setResults] = useState({ day0: "", day1: "", day3: "", week1: "" });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      try {
        await saveActionLog({
          date: today,
          ticker: ticker.trim() || undefined,
          briefing_snapshot_id: guidance?.snapshotId ?? undefined,
          guidance_action: guidanceAction,
          guidance_prohibition: guidanceProhibition,
          actual_action: action,
          follow_level: follow,
          reason: reason.trim() || undefined,
          result_day0: parseResult(results.day0),
          result_day1: parseResult(results.day1),
          result_day3: parseResult(results.day3),
          result_week1: parseResult(results.week1),
          stage: guidance?.stage ?? undefined,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "저장 중 오류가 발생했습니다.");
      }
    });
  }

  return (
    <PageShell title="행동 기록" width="narrow">
      <h2 className="text-[21px] font-semibold tracking-[0.231px]">{today} 행동 기록</h2>

      {/* 스탁가드 안내 */}
      {guidance ? (
        <Card className="mt-4 !bg-parchment">
          <SectionLabel>스탁가드 안내</SectionLabel>
          {guidance.action ? (
            <p className="text-[16px]">{guidance.action}</p>
          ) : null}
          {guidance.prohibition ? (
            <p className="text-[16px] text-ink-80">금지: {guidance.prohibition}</p>
          ) : null}
          {guidance.stage ? (
            <p className="mt-1 text-[13px] text-ink-48">장세: {guidance.stage}</p>
          ) : null}
        </Card>
      ) : (
        <StateNote title="오늘 브리핑 안내를 찾지 못했습니다.">
          아래에서 안내 내용을 직접 입력하거나, 먼저 아침 브리핑을 확인해주세요.
        </StateNote>
      )}

      {/* 안내 직접 입력 (브리핑 없을 때 or 수정) */}
      {!guidance && (
        <div className="mt-4 space-y-2">
          <SectionLabel>안내 행동 (직접 입력)</SectionLabel>
          <input
            value={guidanceAction}
            onChange={(e) => setGuidanceAction(e.target.value)}
            placeholder="예: 레버리지 비중 축소"
            className="h-11 w-full rounded-[8px] border border-hairline px-3 text-[16px] outline-none focus:border-guard"
          />
          <input
            value={guidanceProhibition}
            onChange={(e) => setGuidanceProhibition(e.target.value)}
            placeholder="예: 손실 만회성 추가 매수 금지"
            className="h-11 w-full rounded-[8px] border border-hairline px-3 text-[16px] outline-none focus:border-guard"
          />
        </div>
      )}

      {/* 종목 */}
      <div className="mt-5">
        <SectionLabel>종목 (선택)</SectionLabel>
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="예: SOXL, 삼성전자"
          className="h-11 w-full rounded-[8px] border border-hairline px-3 text-[16px] outline-none focus:border-guard"
        />
      </div>

      {/* 실제 행동 */}
      <div className="mt-5">
        <SectionLabel>내가 실제 한 행동</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          {ACTION_OPTIONS.map((a) => (
            <button
              key={a}
              onClick={() => setAction(a)}
              className={`rounded-[11px] border px-4 py-3 text-left text-[15px] transition-colors ${
                action === a ? "border-guard bg-pearl" : "border-hairline"
              }`}
            >
              {ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      </div>

      {/* 따른 정도 */}
      <div className="mt-5">
        <SectionLabel>따른 정도</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {FOLLOW_LEVELS.map((f) => (
            <button
              key={f}
              onClick={() => setFollow(f)}
              className={`rounded-full border px-4 py-2 text-[15px] transition-colors ${
                follow === f ? "border-guard text-guard" : "border-hairline text-ink-80"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="행동 이유를 적어주세요"
          className="mt-3 w-full rounded-[11px] border border-hairline p-3 text-[15px] outline-none focus:border-guard"
        />
      </div>

      {/* 결과 기록 */}
      <div className="mt-5">
        <SectionLabel>결과 기록 (%)</SectionLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: "당일", key: "day0" as const },
            { label: "다음날", key: "day1" as const },
            { label: "3거래일", key: "day3" as const },
            { label: "1주일", key: "week1" as const },
          ].map((r) => (
            <div key={r.label} className="rounded-[11px] border border-hairline p-3 text-center">
              <p className="text-[12px] text-ink-48">{r.label}</p>
              <input
                type="number"
                step="0.1"
                value={results[r.key]}
                onChange={(e) => setResults((prev) => ({ ...prev, [r.key]: e.target.value }))}
                placeholder="—"
                className="mt-0.5 w-full bg-transparent text-center text-[17px] font-semibold tabular-nums outline-none"
              />
            </div>
          ))}
        </div>
        <p className="mt-2 text-[13px] text-ink-48">
          결과는 직접 입력합니다. 이후 가격 데이터가 연결되면 자동 계산합니다.
        </p>
      </div>

      {error ? <p className="mt-3 text-[13px] text-red-500">{error}</p> : null}

      <div className="mt-6">
        <Button variant="primary" size="lg" disabled={isPending} onClick={handleSubmit}>
          {isPending ? "저장 중…" : "기록 저장"}
        </Button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
