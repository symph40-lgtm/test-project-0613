import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PATHS = [
  "/briefing",
  "/positions",
  "/journal",
  "/onboarding",
  "/alerts",
  "/market",
  "/principles",
];

const ADMIN_PATHS = ["/admin"];

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // 세션 갱신 (쿠키 새로고침 포함)
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const isAdminPath = ADMIN_PATHS.some((p) => pathname.startsWith(p));
  const isProtectedPath = PROTECTED_PATHS.some((p) => pathname.startsWith(p));

  // /admin/* 관리자 게이트
  if (isAdminPath) {
    if (!user) {
      return NextResponse.redirect(new URL("/apply", request.url));
    }

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .single();

    if (roleData?.role !== "admin") {
      return NextResponse.redirect(new URL("/", request.url));
    }

    return supabaseResponse;
  }

  // 핵심 기능 경로 보호
  if (isProtectedPath) {
    if (!user) {
      return NextResponse.redirect(new URL("/apply", request.url));
    }

    const { data: appData } = await supabase
      .from("applications")
      .select("status")
      .eq("email", user.email!)
      .single();

    if (appData?.status !== "approved") {
      return NextResponse.redirect(new URL("/apply/status", request.url));
    }

    return supabaseResponse;
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
