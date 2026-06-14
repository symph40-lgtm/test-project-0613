"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { History } from "lucide-react";
import { GlobalNav, SubNav, Disclaimer } from "../_components/Shell";
import { ButtonLink, Button } from "../_components/Button";
import { Tile, ActionList, StateNote } from "../_components/primitives";
import { briefing } from "../_data/mock";

type View = "default" | "loading" | "fallback";

export default function BriefingPage() {
  const router = useRouter();
  const [view, setView] = useState<View>("default");

  return (
    <div className="flex min-h-screen flex-col">
      <GlobalNav />
      <SubNav
        title="아침 브리핑"
        right={
          <ButtonLink href="/principles" variant="primary">
            원칙 확인
          </ButtonLink>
        }
      />

      {/* 데모 상태 전환기 — 리뷰용 */}
      <div className="mx-auto flex w-full max-w-[820px] items-center gap-2 px-4 pt-4 text-[13px] text-ink-48 sm:px-6">
        <span>데모 상태:</span>
        {(["default", "loading", "fallback"] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-full border px-3 py-1 ${
              view === v ? "border-guard text-guard" : "border-hairline text-ink-48"
            }`}
          >
            {v === "default" ? "기본" : v === "loading" ? "로딩" : "데이터 부족"}
          </button>
        ))}
      </div>

      <main className="flex-1">
        {view === "loading" ? (
          <div className="mx-auto w-full max-w-[820px] px-4 py-10 sm:px-6">
            <div className="space-y-4">
              <div className="h-28 animate-pulse rounded-[18px] bg-divider" />
              <div className="h-40 animate-pulse rounded-[18px] bg-divider" />
            </div>
            <p className="mt-4 text-[15px] text-ink-48">오늘의 판단을 준비하고 있습니다.</p>
          </div>
        ) : (
          <>
            {/* 결론 먼저 — 다크 결정 타일 */}
            <Tile tone="dark">
              <div className="mx-auto w-full max-w-[820px]">
                <p className="text-[14px] font-semibold tracking-[0.04em] text-guard-on-dark">
                  AI 종합 판단
                </p>
                <h2 className="mt-2 text-[40px] font-semibold leading-[1.1] tracking-[-0.374px] headline-tight">
                  {briefing.verdict}
                </h2>
                <p className="mt-3 text-[17px] text-body-muted">
                  현재 장세 {briefing.stage} · 하락 리스크 {briefing.riskScore}점
                </p>
                {view === "fallback" ? (
                  <p className="mt-4 inline-block rounded-full bg-white/10 px-3 py-1 text-[13px] text-body-muted">
                    일부 시세를 불러오지 못해 저장된 기준 가격으로 판단했습니다. 신뢰도 낮음.
                  </p>
                ) : null}
              </div>
            </Tile>

            {/* 행동 / 금지 — 라이트 타일 */}
            <Tile tone="light">
              <div className="mx-auto grid w-full max-w-[820px] gap-8 sm:grid-cols-2">
                <ActionList title="해야 할 행동" items={briefing.dos} tone="do" />
                <ActionList title="하지 말아야 할 행동" items={briefing.donts} tone="dont" />
              </div>
            </Tile>

            {/* 버핏식 관점 — 패치먼트 타일, 대조 관점 */}
            <Tile tone="parchment">
              <div className="mx-auto w-full max-w-[820px]">
                <p className="text-[14px] font-semibold text-ink-48">
                  버핏식 원칙 관점 · 대조 관점
                </p>
                <p className="mt-2 text-[24px] font-light leading-[1.4]">
                  {briefing.buffett}
                </p>
              </div>
            </Tile>

            <div className="mx-auto w-full max-w-[820px] px-6 py-8 sm:px-10">
              {view === "fallback" ? (
                <StateNote tone="error" title="현재 시세를 불러오지 못했습니다.">
                  저장된 기준 가격으로 먼저 판단합니다. 일부 근거는 &lsquo;확인 불가&rsquo;로
                  표시됩니다.
                </StateNote>
              ) : null}

              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <Button variant="secondary" onClick={() => router.push("/positions")}>
                  내 종목 영향 보기
                </Button>
                <Button variant="primary" onClick={() => router.push("/briefing/evidence")}>
                  근거 보기
                </Button>
              </div>

              <button
                onClick={() => router.push("/journal/similar")}
                className="mt-5 flex items-center gap-1.5 text-[15px] text-guard"
              >
                <History size={16} /> 비슷했던 과거 상황 보기
              </button>

              <Disclaimer />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
