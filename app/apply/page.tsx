"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { PageShell, Disclaimer } from "../_components/Shell";
import { Button } from "../_components/Button";
import { Field, StateNote } from "../_components/primitives";
import { submitApplication } from "./actions";

export default function ApplyPage() {
  const [agreed, setAgreed] = useState(false);
  const [state, formAction, pending] = useActionState(submitApplication, null);

  return (
    <PageShell title="이용 신청" width="narrow">
      <p className="text-[17px] leading-[1.47] text-ink-80">
        승인 후 개인화 리스크 코칭을 이용할 수 있습니다.
      </p>

      <form action={formAction} className="mt-8 space-y-5">
        <Field label="이름" name="name" placeholder="홍길동" required />
        <Field
          label="이메일"
          name="email"
          type="email"
          placeholder="hong@example.com"
          required
        />
        <Field label="휴대폰" name="phone" type="tel" placeholder="010-0000-0000" />
        <Field
          label="투자 경험"
          name="experience"
          placeholder="예: 3년 / 국내·미국장"
          hint="검토 참고용 (선택)"
        />
        <Field
          label="신청 동기"
          name="motivation"
          placeholder="예: 변동장 대응이 어려워서"
          hint="검토 참고용 (선택)"
        />

        <label className="flex items-start gap-2.5 pt-2">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 size-5 accent-guard"
          />
          <span className="text-[15px] leading-snug">
            개인정보 수집·이용에 동의합니다.{" "}
            <span className="text-guard">(필수)</span>
          </span>
        </label>

        {state?.error ? (
          <StateNote tone="error" title={state.error} />
        ) : null}

        <div className="flex flex-col items-stretch gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href="/apply/status"
            className="text-left text-[13px] text-ink-48 underline-offset-2 hover:underline"
          >
            이미 신청하셨나요?
          </Link>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={!agreed || pending}
          >
            {pending ? "신청 중…" : "신청하기"}
          </Button>
        </div>
      </form>

      <Disclaimer />
    </PageShell>
  );
}
