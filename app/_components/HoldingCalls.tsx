import type { Recommendation } from "@/lib/market/recommend";
import { type Stance7, STANCE7_META } from "@/lib/market/stance";

// 매수 계열=빨강 / 매도 계열=파랑 / 중립=회색 (한국식)
function badgeStyle(tone: Recommendation["tone"]): string {
  if (tone === "buy") return "bg-red-50 text-red-600";
  if (tone === "sell") return "bg-blue-50 text-blue-600";
  return "bg-ink/10 text-ink-80";
}

// 10단계 스케일 막대 — 왼쪽(적극매도) … 오른쪽(적극매수), 현재 단계 강조
function StanceScale({ stance }: { stance: Stance7 }) {
  return (
    <span className="inline-flex items-center gap-[2px]" title={`${stance}/10단계`}>
      {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as Stance7[]).map((i) => {
        const tone = STANCE7_META[i].tone;
        const active = i === stance;
        const color = tone === "buy" ? "bg-red-500" : tone === "sell" ? "bg-blue-500" : "bg-ink/40";
        return (
          <span
            key={i}
            className={`h-2 w-1.5 rounded-[1px] ${active ? color : "bg-ink/12"} ${active ? "ring-1 ring-offset-1 ring-ink/20" : ""}`}
          />
        );
      })}
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
              <StanceScale stance={r.stance} />
              <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${badgeStyle(r.tone)}`}>
                {r.stance}. {r.label}
              </span>
            </span>
          </div>
          {r.reason && <p className="mt-1 text-[13px] leading-snug text-ink-48">{r.reason}</p>}
          {r.aiNote && <p className="mt-0.5 text-[12px] leading-snug text-guard">↳ {r.aiNote}</p>}
        </div>
      ))}
      <p className="text-[12px] leading-snug text-ink-48">
        10단계: 1 적극매도 · 2 매도 · 3 분할매도 · 4 비중축소 · 5 중립(매도우위) · 6 중립(매수우위) · 7 비중확대 · 8 분할매수 · 9 매수 · 10 적극매수.
        실시간 데이터 기반 추정(+ AI 의견 일부 반영)이며, 투자 권유가 아닙니다. 최종 판단·책임은 본인에게 있습니다.
      </p>
    </div>
  );
}
