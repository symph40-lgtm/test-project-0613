"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Field, StateNote } from "../../_components/primitives";
import { lookupByEmail } from "../actions";

export default function EmailLookupForm({ notFound }: { notFound?: boolean }) {
  const [state, formAction, pending] = useActionState(lookupByEmail, null);

  return (
    <div className="space-y-5">
      {notFound ? (
        <StateNote tone="error" title="신청 내역을 찾을 수 없습니다.">
          입력한 이메일로 신청 내역이 없습니다. 이메일을 확인하거나 새로 신청해주세요.
        </StateNote>
      ) : (
        <p className="text-[17px] leading-[1.47] text-ink-80">
          신청 시 입력한 이메일로 현재 상태를 조회합니다.
        </p>
      )}

      <form action={formAction} className="space-y-4">
        <Field
          label="이메일"
          name="email"
          type="email"
          placeholder="hong@example.com"
          required
        />

        {state?.error ? <StateNote tone="error" title={state.error} /> : null}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center justify-center rounded-full bg-guard px-[22px] py-[11px] text-[17px] text-white transition-transform active:scale-95 disabled:opacity-40"
          >
            {pending ? "조회 중…" : "상태 조회"}
          </button>
          <Link
            href="/apply"
            className="inline-flex items-center justify-center px-[22px] py-[11px] text-[17px] text-guard"
          >
            신청하기
          </Link>
        </div>
      </form>
    </div>
  );
}
