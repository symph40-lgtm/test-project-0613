"use client";

// 문자 일시정지 확인 단계 (사용자 지시 2026-07-28) — 7/28 아침 /ops에서 원탭 오터치로
// 당일 문자가 통째로 정지된 사고 후속. 기본값이 '오늘'이라 탭 한 번에 즉시 발동되던 것을,
// 폼의 날짜·허용 체크 값을 확인창에 보여주고 승인해야 제출되게 막는다.

import type { ReactNode } from "react";

export function ConfirmPauseButton({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        const form = e.currentTarget.form;
        const until = (form?.elements.namedItem("until") as HTMLInputElement | null)?.value ?? "";
        const allow = (form?.elements.namedItem("allowStrong") as HTMLInputElement | null)?.checked ?? false;
        const msg = `${until}까지 문자를 정지합니다${allow ? " (판정 확정 문자는 허용)" : " — 전체 정지"}.\n정말 정지할까요?`;
        if (!window.confirm(msg)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
