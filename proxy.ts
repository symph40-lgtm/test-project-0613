import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROTECTED_PREFIXES = [
  "/briefing",
  "/positions",
  "/journal",
  "/onboarding",
  "/alerts",
  "/market",
  "/principles",
];

const ADMIN_PREFIX = "/admin";

export async function proxy(req: NextRequest) {
  let supabaseResponse = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request: req });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // 세션 갱신 — createServerClient 직후 바로 호출해야 함
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;
  const isAdmin = pathname.startsWith(ADMIN_PREFIX);
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));

  // 미인증 — 보호 경로 접근 시 /login으로 리다이렉트
  if (!user) {
    if (isProtected || isAdmin) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return supabaseResponse;
  }

  // 인증됨 — 관리자 경로
  if (isAdmin) {
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (roleData?.role !== "admin") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return supabaseResponse;
  }

  // 인증됨 — 일반 보호 경로
  if (isProtected) {
    const { data: app } = await supabase
      .from("applications")
      .select("status")
      .eq("email", user.email!)
      .maybeSingle();

    if (app?.status !== "approved") {
      return NextResponse.redirect(new URL("/apply/status", req.url));
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // static 파일, 이미지, favicon 제외
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
