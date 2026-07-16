"use client";

// 예측 모델 실행 버튼 — /api/predict/run 호출(백필·판정·채점) 후 페이지 갱신.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RunButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/predict/run");
      const j = (await r.json()) as { judgedToday?: boolean; backfilled?: string[]; scored?: string[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const parts: string[] = [];
      if (j.judgedToday) parts.push("오늘 판정 완료");
      if (j.backfilled?.length) parts.push(`백필 ${j.backfilled.length}일`);
      if (j.scored?.length) parts.push(`채점 ${j.scored.length}일`);
      setMsg(parts.length ? parts.join(" · ") : "새 작업 없음 (판정은 10:31, 채점은 15:35 이후)");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "실행 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-[8px] bg-ink px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
      >
        {busy ? "실행 중…" : "지금 실행 (판정·채점·백필)"}
      </button>
      {msg && <span className="text-[12px] text-ink-48">{msg}</span>}
    </div>
  );
}
