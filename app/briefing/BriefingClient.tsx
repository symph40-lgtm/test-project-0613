"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { History, X } from "lucide-react";
import { GlobalNav, SubNav, Disclaimer } from "../_components/Shell";
import { ButtonLink, Button } from "../_components/Button";
import { Tile, ActionList, StateNote } from "../_components/primitives";
import { stagePosture } from "@/lib/market/risk";
import { HoldingCalls } from "../_components/HoldingCalls";
import type { Recommendation } from "@/lib/market/recommend";
import type { BriefingSnapshot } from "@/lib/market/types";

export default function BriefingClient({
  snapshot,
  hasBookmark,
  recs = [],
}: {
  snapshot: BriefingSnapshot | null;
  hasBookmark: boolean;
  recs?: Recommendation[];
}) {
  const router = useRouter();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const ai = snapshot?.ai_output;
  const isFallback = snapshot?.is_fallback ?? false;
  const noData = !snapshot || !ai;

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

      <main className="flex-1">
        {hasBookmark && !bannerDismissed && (
          <div className="flex items-center justify-between gap-3 bg-guard/10 px-5 py-3 text-[14px] text-ink-80">
            <span>
              어제 마감 전 판단에서 오늘 브리핑을 예약했습니다. 오늘 안내를 확인해보세요.
            </span>
            <button
              onClick={() => setBannerDismissed(true)}
              className="shrink-0 text-ink-48 hover:text-ink-80"
              aria-label="닫기"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {noData ? (
          <div className="mx-auto w-full max-w-[820px] px-4 py-10 sm:px-6">
            <div className="space-y-4">
              <div className="h-28 animate-pulse rounded-[18px] bg-divider" />
              <div className="h-40 animate-pulse rounded-[18px] bg-divider" />
            </div>
            <p className="mt-4 text-[15px] text-ink-48">오늘의 판단을 준비하고 있습니다.</p>
          </div>
        ) : (
          <>
            {/* 결론 — 다크 결정 타일 */}
            <Tile tone="dark">
              <div className="mx-auto w-full max-w-[820px]">
                <p className="text-[14px] font-semibold tracking-[0.04em] text-guard-on-dark">
                  AI 종합 판단
                </p>
                <h2 className="mt-2 text-[40px] font-semibold leading-[1.1] tracking-[-0.374px] headline-tight">
                  {ai.verdict}
                </h2>
                <p className="mt-3 text-[17px] text-body-muted">
                  현재 장세 {snapshot.stage ?? ai.stage} · 하락 리스크 {snapshot.risk_score ?? 0}점
                </p>
                {(() => {
                  const posture = stagePosture(snapshot.stage ?? ai.stage);
                  return (
                    <div className="mt-4 rounded-[12px] border border-white/15 bg-white/5 p-4">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-guard-on-dark/20 px-2.5 py-0.5 text-[13px] font-semibold text-guard-on-dark">
                          권장 자세: {posture.stance}
                        </span>
                        <span className="text-[13px] text-body-muted">
                          공격성 {posture.aggressiveness}/100
                        </span>
                      </div>
                      <p className="mt-2 text-[15px] leading-snug text-body-muted">
                        {posture.guidance}
                      </p>
                      <p className="mt-2 text-[12px] leading-snug text-body-muted/70">
                        ※ 단계 숫자는 상승의 크기가 아니라 위험 수준입니다. 상승장은 1단계가 가장 안정적(공격성 최고)이고, 3단계로 갈수록 후기·과열로 신중해집니다.
                      </p>
                    </div>
                  );
                })()}
                {isFallback && (
                  <p className="mt-4 inline-block rounded-full bg-white/10 px-3 py-1 text-[13px] text-body-muted">
                    일부 시세를 불러오지 못해 저장된 기준 가격으로 판단했습니다. 신뢰도 낮음.
                  </p>
                )}
              </div>
            </Tile>

            {/* 행동 / 금지 */}
            <Tile tone="light">
              <div className="mx-auto grid w-full max-w-[820px] gap-8 sm:grid-cols-2">
                <ActionList title="해야 할 행동" items={ai.dos ?? []} tone="do" />
                <ActionList title="하지 말아야 할 행동" items={ai.donts ?? []} tone="dont" />
              </div>
            </Tile>

            {/* 보유 종목별 매매 판단 */}
            {recs.length > 0 && (
              <Tile tone="light">
                <div className="mx-auto w-full max-w-[820px]">
                  <h3 className="text-[14px] font-semibold tracking-[-0.224px] text-ink-48">
                    보유 종목 매매 판단 (매수·보유·매도 · 3단계)
                  </h3>
                  <div className="mt-3">
                    <HoldingCalls recs={recs} />
                  </div>
                </div>
              </Tile>
            )}

            {/* 버핏식 관점 */}
            <Tile tone="parchment">
              <div className="mx-auto w-full max-w-[820px]">
                <p className="text-[14px] font-semibold text-ink-48">
                  버핏식 원칙 관점 · 대조 관점
                </p>
                <p className="mt-2 text-[24px] font-light leading-[1.4]">{ai.buffett}</p>
              </div>
            </Tile>

            <div className="mx-auto w-full max-w-[820px] px-6 py-8 sm:px-10">
              {isFallback && (
                <StateNote tone="error" title="현재 시세를 불러오지 못했습니다.">
                  저장된 기준 가격으로 먼저 판단합니다. 일부 근거는 &lsquo;확인 불가&rsquo;로
                  표시됩니다.
                </StateNote>
              )}

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
