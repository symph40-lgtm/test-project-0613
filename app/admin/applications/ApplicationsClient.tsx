"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Button } from "../../_components/Button";
import { StateNote } from "../../_components/primitives";
import {
  approveApplication,
  rejectApplication,
  resendInvite,
} from "./actions";
import type { Application } from "./actions";

type Filter = "pending" | "approved" | "rejected";

export default function ApplicationsClient({
  applications,
  filter,
}: {
  applications: Application[];
  filter: Filter;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(
    applications[0]?.id ?? null,
  );
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("대상 조건 미충족");
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  function showToast(msg: string, error = false) {
    setToast({ msg, error });
    setTimeout(() => setToast(null), 3000);
  }

  function handleFilterChange(f: Filter) {
    router.push(`/admin/applications?filter=${f}`);
  }

  function handleApprove(id: string, name: string) {
    startTransition(async () => {
      const result = await approveApplication(id);
      if (!result.success) {
        showToast(result.error ?? "오류가 발생했습니다.", true);
        return;
      }
      showToast(
        result.inviteError
          ? `${name} 승인 완료. ${result.inviteError}`
          : `${name} 승인 완료. 초대 이메일을 발송했습니다.`,
        !!result.inviteError,
      );
      setExpanded(null);
      router.refresh();
    });
  }

  function handleReject(id: string, name: string) {
    startTransition(async () => {
      const result = await rejectApplication(id, rejectReason);
      if (!result.success) {
        showToast(result.error ?? "오류가 발생했습니다.", true);
        return;
      }
      showToast(`${name} 거절 처리 완료.`);
      setRejecting(null);
      setRejectReason("대상 조건 미충족");
      setExpanded(null);
      router.refresh();
    });
  }

  function handleResendInvite(id: string) {
    startTransition(async () => {
      const result = await resendInvite(id);
      showToast(
        result.success ? "초대 이메일을 재발송했습니다." : (result.error ?? "오류"),
        !result.success,
      );
    });
  }

  const filters: { key: Filter; label: string }[] = [
    { key: "pending", label: "대기" },
    { key: "approved", label: "승인" },
    { key: "rejected", label: "거절" },
  ];

  return (
    <>
      {/* 상태 필터 탭 */}
      <div className="flex flex-wrap gap-2">
        {filters.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => handleFilterChange(key)}
            className={`rounded-full border px-4 py-1.5 text-[14px] ${
              filter === key
                ? "border-guard bg-guard text-white"
                : "border-hairline text-ink-80"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {toast ? (
        <div
          className={`mt-4 rounded-[11px] border p-3 text-[14px] ${
            toast.error
              ? "border-ink/20 bg-pearl text-ink"
              : "border-guard/30 bg-pearl text-ink-80"
          }`}
        >
          {toast.msg}
        </div>
      ) : null}

      <div className="mt-5 space-y-3">
        {applications.length === 0 ? (
          <StateNote title="검토할 신청이 없습니다.">
            선택한 상태의 신청이 없습니다.
          </StateNote>
        ) : (
          applications.map((a) => {
            const open = expanded === a.id;
            return (
              <div
                key={a.id}
                className="rounded-[18px] border border-hairline bg-canvas"
              >
                <button
                  onClick={() => setExpanded(open ? null : a.id)}
                  className="flex w-full items-center justify-between gap-4 p-5 text-left"
                >
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-[17px] font-semibold">{a.name}</span>
                    <span className="text-[14px] text-ink-48">{a.email}</span>
                    <span className="text-[14px] text-ink-48">
                      접수 {new Date(a.created_at).toLocaleDateString("ko-KR")}
                    </span>
                  </div>
                  {open ? (
                    <ChevronUp size={18} className="shrink-0 text-ink-48" />
                  ) : (
                    <ChevronDown size={18} className="shrink-0 text-ink-48" />
                  )}
                </button>

                {open ? (
                  <div className="border-t border-divider px-5 pb-5 pt-4">
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Detail label="휴대폰" value={a.phone ?? "—"} />
                      <Detail label="투자 경험" value={a.experience ?? "—"} />
                      <Detail label="신청 동기" value={a.motivation ?? "—"} />
                      {a.rejection_reason ? (
                        <Detail label="거절 사유" value={a.rejection_reason} />
                      ) : null}
                    </dl>

                    {filter === "pending" ? (
                      <>
                        {rejecting === a.id ? (
                          <div className="mt-4 space-y-2">
                            <input
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                              className="h-11 w-full rounded-[8px] border border-hairline px-3.5 text-[15px] outline-none focus:border-guard"
                              placeholder="거절 사유를 입력하세요"
                            />
                            <div className="flex gap-2">
                              <Button
                                variant="primary"
                                disabled={isPending}
                                onClick={() => handleReject(a.id, a.name)}
                              >
                                거절 확정
                              </Button>
                              <Button
                                variant="text"
                                onClick={() => {
                                  setRejecting(null);
                                  setRejectReason("대상 조건 미충족");
                                }}
                              >
                                취소
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-4 flex gap-2">
                            <Button
                              variant="primary"
                              disabled={isPending}
                              onClick={() => handleApprove(a.id, a.name)}
                            >
                              <Check size={16} /> 승인
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={isPending}
                              onClick={() => setRejecting(a.id)}
                            >
                              <X size={16} /> 거절
                            </Button>
                          </div>
                        )}
                      </>
                    ) : null}

                    {filter === "approved" ? (
                      <div className="mt-4">
                        <Button
                          variant="secondary"
                          disabled={isPending}
                          onClick={() => handleResendInvite(a.id)}
                        >
                          <RefreshCw size={15} /> 초대 이메일 재발송
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-[14px] text-ink-48">{label}</dt>
      <dd className="text-[15px]">{value}</dd>
    </div>
  );
}
