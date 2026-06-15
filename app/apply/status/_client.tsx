"use client";

import { useState, useActionState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "../../_components/Button";
import { Field, StateNote } from "../../_components/primitives";
import { lookupByEmail } from "../actions";

export function RefreshButton() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  return (
    <Button
      variant="secondary"
      onClick={() => {
        setRefreshing(true);
        router.refresh();
        setTimeout(() => setRefreshing(false), 800);
      }}
    >
      <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
      {refreshing ? "확인 중…" : "상태 새로고침"}
    </Button>
  );
}

export function EmailLookupForm() {
  const [state, action, pending] = useActionState(lookupByEmail, null);
  return (
    <form action={action} className="mt-6 space-y-4">
      <Field
        name="email"
        label="이메일"
        type="email"
        placeholder="신청 시 입력한 이메일"
        required
      />
      {state?.error ? <StateNote tone="error" title={state.error} /> : null}
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "조회 중…" : "상태 조회"}
      </Button>
    </form>
  );
}
