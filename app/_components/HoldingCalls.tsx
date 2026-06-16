import type { Recommendation } from "@/lib/market/recommend";

// 매수=빨강 / 매도=파랑 / 보유=회색 (한국식)
function badgeStyle(dir: Recommendation["direction"]): string {
  if (dir === "매수") return "bg-red-50 text-red-600";
  if (dir === "매도") return "bg-blue-50 text-blue-600";
  return "bg-ink/10 text-ink-80";
}

// 단계 점(●●○) 표시
function LevelDots({ dir, level }: { dir: Recommendation["direction"]; level: number }) {
  if (dir === "보유") return null;
  const color = dir === "매수" ? "bg-red-500" : "bg-blue-500";
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3].map((i) => (
        <span key={i} className={`size-1.5 rounded-full ${i <= level ? color : "bg-ink/15"}`} />
      ))}
    </span>
  );
}

export function HoldingCalls({ recs }: { recs: Recommendation[] }) {
  if (recs.length === 0) return null;
  return (
    <div className="space-y-2.5">
      {recs.map((r) => (
        <div key={r.ticker} className="border-b border-divider pb-2.5 last:border-0">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px] font-medium">{r.ticker}</span>
            <span className="flex items-center gap-2">
              <LevelDots dir={r.direction} level={r.level} />
              <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${badgeStyle(r.direction)}`}>
                {r.label}
              </span>
            </span>
          </div>
          {r.reason && <p className="mt-1 text-[13px] leading-snug text-ink-48">{r.reason}</p>}
        </div>
      ))}
      <p className="text-[12px] text-ink-48">
        단계 1~3은 신호의 강도입니다(3이 가장 강함). 실시간 데이터 기반 추정이며 투자 권유가 아닙니다.
      </p>
    </div>
  );
}
