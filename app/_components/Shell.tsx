import Link from "next/link";
import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { NavAuth } from "./NavAuth";

/* 얇은 검정 글로벌 내비 — 모든 페이지 상단 고정 */
export function GlobalNav() {
  return (
    <header className="sticky top-0 z-30 flex h-11 items-center justify-between bg-black px-4 text-white sm:px-6">
      <Link href="/" className="flex items-center gap-1.5 text-[12px] tracking-[-0.12px]">
        <ShieldCheck size={14} className="text-guard-on-dark" />
        <span className="font-semibold">스탁가드</span>
      </Link>
      <nav className="flex items-center gap-5 text-[12px] tracking-[-0.12px] text-white/80">
        <NavAuth />
      </nav>
    </header>
  );
}

/* 서피스별 서브내비 — 좌측 화면명, 우측 CTA */
export function SubNav({
  title,
  right,
  badge,
}: {
  title: string;
  right?: ReactNode;
  badge?: string;
}) {
  return (
    <div className="sticky top-11 z-20 flex h-[52px] items-center justify-between border-b border-hairline bg-parchment/80 px-4 backdrop-blur-md backdrop-saturate-150 sm:px-6">
      <div className="flex items-center gap-2">
        <h1 className="text-[21px] font-semibold tracking-[0.231px]">{title}</h1>
        {badge ? (
          <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-normal text-white">
            {badge}
          </span>
        ) : null}
      </div>
      {right ? <div className="flex items-center gap-3">{right}</div> : null}
    </div>
  );
}

/* 표준 페이지 셸: 글로벌 내비 + 서브내비 + 중앙 콘텐츠 폭 */
export function PageShell({
  title,
  subNavRight,
  badge,
  children,
  width = "default",
}: {
  title: string;
  subNavRight?: ReactNode;
  badge?: string;
  children: ReactNode;
  width?: "narrow" | "default" | "wide" | "full";
}) {
  const widthClass =
    width === "narrow"
      ? "max-w-[560px]"
      : width === "wide"
        ? "max-w-[1100px]"
        : width === "full"
          ? "max-w-none"
          : "max-w-[820px]";
  return (
    <div className="flex min-h-screen flex-col">
      <GlobalNav />
      <SubNav title={title} right={subNavRight} badge={badge} />
      <main className="flex-1">
        <div className={`mx-auto w-full px-4 py-8 sm:px-6 sm:py-10 ${widthClass}`}>
          {children}
        </div>
      </main>
    </div>
  );
}

/* 면책 푸터 — 투자 조언 단정 회피 */
export function Disclaimer() {
  return (
    <p className="mt-8 text-[12px] leading-relaxed text-ink-48">
      스탁가드는 저장한 원칙과 현재 위험 조건에 근거한 리스크 코칭을 제공하며, 투자 권유나
      매매 지시가 아닙니다. 최종 판단과 책임은 본인에게 있습니다.
    </p>
  );
}
