"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleDot, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, MetaRow } from "../../_components/primitives";
import { TODAY } from "../../_data/mock";

type Status = "대기" | "승인" | "거절";

const meta: Record<Status, { icon: typeof CircleDot; title: string; desc: string }> = {
  대기: {
    icon: CircleDot,
    title: "신청 상태: 대기 중",
    desc: "신청이 접수되었습니다. 관리자 검토 후 결과를 알려드립니다.",
  },
  승인: {
    icon: CheckCircle2,
    title: "승인되었습니다",
    desc: "이제 시작할 수 있습니다. 종목을 입력하고 오늘의 판단을 받아보세요.",
  },
  거절: {
    icon: XCircle,
    title: "신청이 거절되었습니다",
    desc: "이번에는 대상 조건을 충족하지 못했습니다. 안내에 따라 다시 신청할 수 있습니다.",
  },
};

export default function StatusPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("대기");
  const [refreshing, setRefreshing] = useState(false);
  const m = meta[status];
  const Icon = m.icon;

  return (
    <PageShell title="신청 상태" width="narrow">
      {/* 데모 상태 전환기 — 리뷰용 (실제 서비스에는 없음) */}
      <div className="mb-6 flex items-center gap-2 text-[13px] text-ink-48">
        <span>데모 상태:</span>
        {(["대기", "승인", "거절"] as Status[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 ${
              status === s ? "border-guard text-guard" : "border-hairline text-ink-48"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <Card>
        <div className="flex items-center gap-2">
          <Icon size={20} className="text-guard" />
          <h2 className="text-[21px] font-semibold tracking-[0.231px]">{m.title}</h2>
        </div>
        <p className="mt-2 text-[17px] leading-[1.47] text-ink-80">{m.desc}</p>

        <div className="mt-5 border-t border-divider pt-4">
          <MetaRow label="접수일" value={TODAY} />
          <MetaRow label="통지 채널" value="이메일" />
          {status === "거절" ? <MetaRow label="거절 사유" value="대상 조건 미충족" /> : null}
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          {status === "승인" ? (
            <Button variant="primary" size="lg" onClick={() => router.push("/onboarding")}>
              시작하기
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setRefreshing(true);
                setTimeout(() => setRefreshing(false), 800);
              }}
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "확인 중…" : "상태 새로고침"}
            </Button>
          )}
          {status === "거절" ? (
            <Button variant="text" onClick={() => router.push("/apply")}>
              다시 신청하기
            </Button>
          ) : null}
        </div>
      </Card>

      {status === "대기" ? (
        <p className="mt-4 text-[13px] text-ink-48">
          이메일 인증이 완료되지 않은 경우 앱 내 알림으로 결과를 안내합니다. 승인 전에는
          핵심 기능에 접근할 수 없습니다.
        </p>
      ) : null}

      <Disclaimer />
    </PageShell>
  );
}
