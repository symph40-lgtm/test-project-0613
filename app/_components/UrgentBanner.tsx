"use client";

import { useState } from "react";
import { AlertTriangle, X, ExternalLink } from "lucide-react";
import type { UrgentAlert } from "@/lib/market/urgentAlert";

// AI 빅테크發 반도체 급등락 긴급 배너 — 페이지 진입·새로고침 시 상단 노출, 닫기 가능.
// 한국식 색상: 급락=파랑, 급등=빨강, 혼조=앰버(중립). 등급(경계/심각/위급)에 따라 색 농도를 달리한다.
// Tailwind가 클래스를 스캔할 수 있도록 전체 리터럴 문자열로 매핑한다(동적 조합 금지).
type Dir = "급락" | "급등" | "혼조";
type Style = { box: string; badge: string; icon: string };

const GRADE_STYLES: Record<Dir, Record<1 | 2 | 3, Style>> = {
  급락: {
    1: { box: "border-blue-300 bg-blue-50", badge: "bg-blue-500 text-white", icon: "text-blue-500" },
    2: { box: "border-blue-500 bg-blue-50", badge: "bg-blue-600 text-white", icon: "text-blue-600" },
    3: { box: "border-blue-700 bg-blue-100", badge: "bg-blue-700 text-white", icon: "text-blue-700" },
  },
  급등: {
    1: { box: "border-red-300 bg-red-50", badge: "bg-red-500 text-white", icon: "text-red-500" },
    2: { box: "border-red-500 bg-red-50", badge: "bg-red-600 text-white", icon: "text-red-600" },
    3: { box: "border-red-700 bg-red-100", badge: "bg-red-700 text-white", icon: "text-red-700" },
  },
  혼조: {
    1: { box: "border-amber-300 bg-amber-50", badge: "bg-amber-500 text-white", icon: "text-amber-500" },
    2: { box: "border-amber-500 bg-amber-50", badge: "bg-amber-600 text-white", icon: "text-amber-600" },
    3: { box: "border-amber-700 bg-amber-100", badge: "bg-amber-700 text-white", icon: "text-amber-700" },
  },
};

export function UrgentBanner({ alert, className = "" }: { alert: UrgentAlert | null; className?: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (!alert?.active || !alert.direction || dismissed) return null;

  const s = GRADE_STYLES[alert.direction as Dir][alert.grade];

  const fmtDate = (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    return ` · ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div role="alert" className={`rounded-[14px] border ${s.box} p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} className={`mt-0.5 shrink-0 ${s.icon}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[12px] font-bold ${s.badge}`}>긴급</span>
            {alert.level && (
              <span className={`rounded-full px-2 py-0.5 text-[12px] font-bold ${s.badge}`}>
                {alert.level} · {alert.grade}등급
              </span>
            )}
            <span className="text-[16px] font-semibold leading-snug">{alert.headline}</span>
          </div>

          <p className="mt-2 text-[14px] leading-relaxed text-ink-80">{alert.detail}</p>

          {alert.news.length > 0 && (
            <div className="mt-3">
              <p className="text-[12px] font-semibold text-ink-48">긴급뉴스 (AI·메모리 우선)</p>
              <ul className="mt-1 space-y-1">
                {alert.news.map((n, i) => (
                  <li key={i}>
                    <a
                      href={n.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-start gap-1.5"
                    >
                      <ExternalLink size={13} className="mt-1 shrink-0 text-ink-48" />
                      <span className="text-[13px] leading-snug text-ink-80 group-hover:underline">
                        <span className={`mr-1 rounded px-1 py-0.5 text-[10px] font-bold ${s.badge}`}>긴급</span>
                        {n.tier === 2 && (
                          <span className="mr-1 rounded bg-ink px-1 py-0.5 text-[10px] font-bold text-white">AI·메모리</span>
                        )}
                        {n.title}
                        <span className="text-ink-48">
                          {" "}({n.source}{fmtDate(n.pubDate)})
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-3 text-[11px] text-ink-48">
            당일 뉴스와 당일 급등락을 함께 감지한 추정 경고이며, 투자 권유가 아닙니다.
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 text-ink-48 hover:text-ink-80"
          aria-label="긴급 알람 닫기"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
