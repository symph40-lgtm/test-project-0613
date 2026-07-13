"use client";

// 미국 신호 페이지 새로고침 버튼 — 서버 컴포넌트 스냅샷을 그 시점 실시간으로 다시 렌더
// (한국 /signal의 갱신 버튼과 동일한 스타일, 사용자 지정 2026-07-13)

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export default function RefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  return (
    <button
      onClick={() => {
        startTransition(() => {
          router.refresh();
          setUpdatedAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        });
      }}
      className="flex items-center gap-1.5 rounded-[8px] border border-hairline bg-canvas px-3 py-1.5 text-[13px] hover:bg-pearl"
    >
      <RefreshCw size={13} className={isPending ? "animate-spin" : ""} />
      {updatedAt ? `${updatedAt} 갱신` : "갱신"}
    </button>
  );
}
