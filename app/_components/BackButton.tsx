"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

/* 직전 페이지로 돌아가는 버튼 — 모든 PageShell 상단에 표시 */
export function BackButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      aria-label="뒤로 가기"
      className="-ml-1 grid size-8 shrink-0 place-items-center rounded-full text-ink-48 transition-colors hover:bg-divider hover:text-ink"
    >
      <ChevronLeft size={20} />
    </button>
  );
}
