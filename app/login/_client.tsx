"use client";

import { useActionState } from "react";
import { login } from "./actions";
import { Field, StateNote } from "../_components/primitives";
import { Button } from "../_components/Button";

export default function LoginForm() {
  const [state, action, pending] = useActionState(login, null);

  return (
    <form action={action} className="space-y-4">
      <Field name="email" label="이메일" type="email" placeholder="가입한 이메일" required />
      <Field name="password" label="비밀번호" type="password" placeholder="비밀번호" required />
      {state?.error ? <StateNote tone="error" title={state.error} /> : null}
      <Button type="submit" variant="primary" disabled={pending} className="w-full">
        {pending ? "로그인 중…" : "로그인"}
      </Button>
    </form>
  );
}
