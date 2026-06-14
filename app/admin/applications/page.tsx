"use client";

import { useState } from "react";
import { Check, X, ChevronDown, ChevronUp } from "lucide-react";
import { PageShell } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { StateNote } from "../../_components/primitives";
import { applications } from "../../_data/mock";

type Decision = "대기" | "승인" | "거절";

export default function AdminApplicationsPage() {
  const [filter, setFilter] = useState<Decision>("대기");
  const [decisions, setDecisions] = useState<Record<string, Decision>>(
    Object.fromEntries(applications.map((a) => [a.email, a.status])),
  );
  const [expanded, setExpanded] = useState<string | null>(applications[0]?.email ?? null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const counts: Record<Decision, number> = { 대기: 0, 승인: 0, 거절: 0 };
  for (const a of applications) counts[decisions[a.email]]++;

  const visible = applications.filter((a) => decisions[a.email] === filter);

  function decide(email: string, name: string, d: Decision) {
    setDecisions((prev) => ({ ...prev, [email]: d }));
    setRejecting(null);
    setToast(`${name} 신청을 ${d} 처리했습니다. 결과 통지를 발송합니다.`);
    setTimeout(() => setToast(null), 2600);
  }

  return (
    <PageShell title="이용 신청 관리" badge="관리자" width="wide">
      {/* 상태 필터 */}
      <div className="flex flex-wrap gap-2">
        {(["대기", "승인", "거절"] as Decision[]).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full border px-4 py-1.5 text-[14px] ${
              filter === s
                ? "border-guard bg-guard text-white"
                : "border-hairline text-ink-80"
            }`}
          >
            {s} {counts[s]}
          </button>
        ))}
      </div>

      {toast ? (
        <div className="mt-4 rounded-[11px] border border-guard/30 bg-pearl p-3 text-[14px] text-ink-80">
          {toast}
        </div>
      ) : null}

      <div className="mt-5 space-y-3">
        {visible.length === 0 ? (
          <StateNote title="검토할 신청이 없습니다.">
            선택한 상태의 신청이 없습니다.
          </StateNote>
        ) : (
          visible.map((a) => {
            const open = expanded === a.email;
            return (
              <div key={a.email} className="rounded-[18px] border border-hairline bg-canvas">
                <button
                  onClick={() => setExpanded(open ? null : a.email)}
                  className="flex w-full items-center justify-between gap-4 p-5 text-left"
                >
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-[17px] font-semibold">{a.name}</span>
                    <span className="text-[14px] text-ink-48">{a.email}</span>
                    <span className="text-[14px] text-ink-48">접수 {a.date}</span>
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
                      <Detail label="휴대폰" value={a.phone} />
                      <Detail label="투자 경험" value={a.experience} />
                      <Detail label="신청 동기" value={a.motive} />
                      <Detail label="통지" value="승인 시 자동 발송" />
                    </dl>

                    {rejecting === a.email ? (
                      <div className="mt-4 space-y-2">
                        <input
                          defaultValue="대상 조건 미충족"
                          className="h-11 w-full rounded-[8px] border border-hairline px-3.5 text-[15px] outline-none focus:border-guard"
                          placeholder="거절 사유를 입력하세요"
                        />
                        <div className="flex gap-2">
                          <Button variant="primary" onClick={() => decide(a.email, a.name, "거절")}>
                            거절 확정
                          </Button>
                          <Button variant="text" onClick={() => setRejecting(null)}>
                            취소
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 flex gap-2">
                        <Button variant="primary" onClick={() => decide(a.email, a.name, "승인")}>
                          <Check size={16} /> 승인
                        </Button>
                        <Button variant="secondary" onClick={() => setRejecting(a.email)}>
                          <X size={16} /> 거절
                        </Button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <p className="mt-6 text-[13px] text-ink-48">
        관리자 권한이 없는 사용자는 이 화면에 접근할 수 없습니다. 결정은 신청자 상태·권한에
        즉시 반영되고 결과 통지가 발송됩니다. (목업 · 더미 데이터)
      </p>
    </PageShell>
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
