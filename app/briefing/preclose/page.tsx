"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, MetaRow } from "../../_components/primitives";
import { preCloseScenarios, perStockCalls } from "../../_data/mock";

export default function PreClosePage() {
  const router = useRouter();
  const [booked, setBooked] = useState(false);

  return (
    <PageShell title="마감 전 판단" width="default">
      {/* 결론 먼저 */}
      <div className="rounded-[18px] bg-tile-1 p-6 text-white sm:p-8">
        <p className="text-[13px] text-body-muted">기준 포지션 · 14:42 최신 상태</p>
        <h2 className="mt-2 text-[28px] font-semibold leading-tight">
          다음날 갭하락 위험: 높음
        </h2>
        <p className="mt-2 text-[17px] text-body-muted">권장 대응: 비중 축소 검토</p>
      </div>

      {/* 야간 이벤트 */}
      <Card className="mt-4">
        <SectionLabel>오늘 밤 주요 이벤트 · 자동 스캔</SectionLabel>
        <div className="space-y-3">
          <div>
            <p className="text-[15px] font-semibold">경제지표</p>
            <p className="text-[15px] text-ink-80">
              미국 비농업고용지표 22:30 발표 · 예상 범위: 컨센서스 부근~소폭 상회
            </p>
          </div>
          <div>
            <p className="text-[15px] font-semibold">주요 실적</p>
            <p className="text-[15px] text-ink-80">
              반도체 관련 대형주 실적 · AI 서버·메모리·장비 가이던스 확인
            </p>
          </div>
        </div>
      </Card>

      {/* 결과별 시나리오 */}
      <Card className="mt-4">
        <SectionLabel>결과별 시나리오</SectionLabel>
        <ul className="divide-y divide-divider">
          {preCloseScenarios.map((s) => (
            <li key={s.result} className="flex gap-3 py-2.5">
              <span className="w-20 shrink-0 text-[15px] font-semibold">{s.result}</span>
              <span className="text-[15px] text-ink-80">{s.impact}</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {/* 2차원 맵 */}
        <Card>
          <SectionLabel>큰 장세 × 오늘 상황</SectionLabel>
          <p className="text-[15px] text-ink-80">큰 압력 높음 · 휴전 뉴스로 일부 완화</p>
          <p className="mt-2 text-[15px] font-semibold">판단: 큰 압력 안의 단기 호재</p>
        </Card>
        {/* 수급 */}
        <Card>
          <SectionLabel>수급</SectionLabel>
          <p className="text-[15px] text-ink-80">
            외국인 4거래일 순매도 · 채권 선호 강화 · 개인 거래량 급증
          </p>
        </Card>
      </div>

      {/* 종목별 판단 */}
      <Card className="mt-4">
        <SectionLabel>종목별 판단</SectionLabel>
        {perStockCalls.map((p) => (
          <MetaRow key={p.ticker} label={p.ticker} value={p.call} />
        ))}
      </Card>

      {/* 미준수 리스크 */}
      <Card className="mt-4 !bg-parchment">
        <SectionLabel>원칙을 무시할 경우</SectionLabel>
        <p className="text-[15px] leading-snug">
          SOXL 유지 + 추가 매수 시, 나스닥 약세와 금리 상승이 겹치면 손실률이 빠르게 확대될 수
          있습니다.
        </p>
      </Card>

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            setBooked(true);
          }}
        >
          <CalendarClock size={18} />
          {booked ? "내일 아침 다시 보기 예약됨" : "내일 아침 다시 보기 예약"}
        </Button>
        {booked ? (
          <p className="mt-3 text-[14px] text-ink-80">
            예약했습니다. 내일 아침 브리핑에서 오늘 판단과 함께 다시 보여드립니다.
          </p>
        ) : null}
        <button
          onClick={() => router.push("/principles")}
          className="ml-1 mt-4 block text-[14px] text-guard"
        >
          원칙 다시 확인하기 →
        </button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
