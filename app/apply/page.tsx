"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Disclaimer } from "../_components/Shell";
import { Button } from "../_components/Button";
import { Field, StateNote } from "../_components/primitives";

export default function ApplyPage() {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 데모 토글: 동일 연락처 기존 신청 안내 상태를 미리 볼 수 있게 한다.
  const [existing, setExisting] = useState(false);

  function handleSubmit() {
    if (!agreed || submitting) return;
    setSubmitting(true);
    // 목업: 실제 제출 없이 잠시 후 상태 화면으로 이동
    setTimeout(() => router.push("/apply/status"), 700);
  }

  return (
    <PageShell title="이용 신청" width="narrow">
      <p className="text-[17px] leading-[1.47] text-ink-80">
        승인 후 개인화 리스크 코칭을 이용할 수 있습니다.
      </p>

      {existing ? (
        <div className="mt-6">
          <StateNote tone="info" title="이미 신청하신 연락처입니다.">
            새 신청 대신 현재 상태를 확인하세요.
          </StateNote>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => router.push("/apply/status")}
          >
            내 신청 상태 보기
          </Button>
        </div>
      ) : (
        <div className="mt-8 space-y-5">
          <Field label="이름" placeholder="홍길동" required />
          <Field label="이메일" type="email" placeholder="hong@example.com" required />
          <Field label="휴대폰" type="tel" placeholder="010-0000-0000" required />
          <Field
            label="투자 경험"
            placeholder="예: 3년 / 국내·미국장"
            hint="검토 참고용 (선택)"
          />
          <Field
            label="신청 동기"
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
              개인정보 수집·이용에 동의합니다. <span className="text-guard">(필수)</span>
            </span>
          </label>

          <div className="flex flex-col items-stretch gap-3 pt-2 sm:flex-row sm:justify-between sm:items-center">
            <button
              type="button"
              onClick={() => setExisting(true)}
              className="text-left text-[13px] text-ink-48 underline-offset-2 hover:underline"
            >
              이미 신청하셨나요?
            </button>
            <Button
              variant="primary"
              size="lg"
              disabled={!agreed || submitting}
              onClick={handleSubmit}
            >
              {submitting ? "신청 중…" : "신청하기"}
            </Button>
          </div>
        </div>
      )}

      <Disclaimer />
    </PageShell>
  );
}
