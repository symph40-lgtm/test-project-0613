"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { logout } from "@/app/login/actions";

export function NavAuth() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then((res: { data: { user: unknown } }) => {
      setSignedIn(!!res.data.user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: string, session: Session | null) => {
      setSignedIn(!!session?.user);
    });

    return () => subscription.unsubscribe();
  }, []);

  // 초기 로딩 중에는 아무것도 표시하지 않음 (깜빡임 방지)
  if (signedIn === null) return null;

  if (signedIn) {
    return (
      <>
        <Link href="/briefing" className="hidden hover:text-white sm:inline">
          브리핑
        </Link>
        <Link href="/positions" className="hidden hover:text-white sm:inline">
          포트폴리오
        </Link>
        <Link href="/journal" className="hidden hover:text-white sm:inline">
          행동 기록
        </Link>
        <form action={logout}>
          <button type="submit" className="text-white/60 hover:text-white">
            로그아웃
          </button>
        </form>
      </>
    );
  }

  return (
    <>
      <Link href="/apply" className="text-guard-on-dark hover:text-white">
        이용 신청
      </Link>
      <Link href="/login" className="text-white/80 hover:text-white">
        로그인
      </Link>
    </>
  );
}
