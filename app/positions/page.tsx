"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { PageShell, Disclaimer } from "../_components/Shell";
import { ButtonLink } from "../_components/Button";
import { RiskBadge, StateNote } from "../_components/primitives";
import { positions as seed } from "../_data/mock";

export default function PositionsPage() {
  const [rows] = useState(seed);
  const empty = rows.length === 0;

  return (
    <PageShell
      title="포트폴리오"
      width="wide"
      subNavRight={
        <ButtonLink href="/positions/risk-line" variant="primary">
          위험선 추천 받기
        </ButtonLink>
      }
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[17px] font-semibold">내 주요 포지션</h2>
        <span className="text-[13px] text-ink-48">{rows.length} / 10 등록</span>
      </div>

      {empty ? (
        <StateNote title="주요 종목을 추가해 위험 노출을 확인하세요.">
          실제 의사결정에 큰 영향을 주는 포지션을 우선 등록하면 됩니다.
        </StateNote>
      ) : (
        <>
          {/* 데스크톱: 테이블 */}
          <div className="hidden overflow-hidden rounded-[18px] border border-hairline sm:block">
            <table className="w-full text-left text-[15px]">
              <thead className="bg-pearl text-[13px] text-ink-48">
                <tr>
                  <th className="px-4 py-3 font-medium">종목</th>
                  <th className="px-4 py-3 font-medium">비중</th>
                  <th className="px-4 py-3 font-medium">손익</th>
                  <th className="px-4 py-3 font-medium">유형</th>
                  <th className="px-4 py-3 font-medium">섹터 / 위험</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {rows.map((p) => (
                  <tr key={p.ticker}>
                    <td className="px-4 py-3 font-semibold">{p.ticker}</td>
                    <td className="px-4 py-3 tabular-nums">{p.weight}%</td>
                    <td className="px-4 py-3 tabular-nums">
                      {p.pnl > 0 ? `+${p.pnl}` : p.pnl}%
                    </td>
                    <td className="px-4 py-3">{p.leverage ? "레버리지" : "일반"}</td>
                    <td className="px-4 py-3">
                      <span className="mr-2 text-ink-80">{p.sector}</span>
                      <RiskBadge level={p.risk} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 모바일: 카드 */}
          <div className="space-y-2.5 sm:hidden">
            {rows.map((p) => (
              <div key={p.ticker} className="rounded-[18px] border border-hairline p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[17px] font-semibold">{p.ticker}</span>
                  <RiskBadge level={p.risk} />
                </div>
                <div className="mt-1.5 flex gap-4 text-[14px] text-ink-80">
                  <span>비중 {p.weight}%</span>
                  <span>손익 {p.pnl > 0 ? `+${p.pnl}` : p.pnl}%</span>
                  <span>{p.leverage ? "레버리지" : "일반"}</span>
                </div>
                <p className="mt-1 text-[13px] text-ink-48">{p.sector} 섹터</p>
              </div>
            ))}
          </div>

          <button className="mt-3 flex items-center gap-1.5 px-1 py-2 text-[15px] text-guard">
            <Plus size={16} /> 주요 종목 추가
          </button>

          <p className="mt-2 text-[13px] text-ink-48">
            &lsquo;주요 종목 최대 10개&rsquo;는 모든 보유 종목이 아니라 의사결정에 큰 영향을
            주는 포지션 기준입니다. 같은 종목을 다시 추가하면 합산할지 안내합니다.
          </p>
        </>
      )}

      <div className="mt-6 sm:hidden">
        <ButtonLink href="/positions/risk-line" variant="primary">
          위험선 추천 받기
        </ButtonLink>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
