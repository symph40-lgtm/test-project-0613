import Link from "next/link";
import { ShieldCheck, TrendingUp, BellRing, NotebookPen } from "lucide-react";
import { GlobalNav } from "./_components/Shell";
import { ButtonLink } from "./_components/Button";
import { createClient } from "@/lib/supabase/server";

// 로그인 상태에 따라 항상 최신으로 렌더링 (캐시 방지)
export const dynamic = "force-dynamic";

const features = [
  {
    icon: TrendingUp,
    title: "아침 브리핑",
    desc: "실시간 시세·금리·반도체 흐름을 분석해 오늘의 장세와 권장 자세를 알려줍니다.",
  },
  {
    icon: ShieldCheck,
    title: "위험선·원칙 관리",
    desc: "보유 종목의 위험을 점검하고, 흔들릴 때 지킬 원칙을 미리 설정합니다.",
  },
  {
    icon: BellRing,
    title: "장중 알림",
    desc: "급락·반등 등 위험 조건이 발생하면 이메일·문자로 즉시 알려드립니다.",
  },
  {
    icon: NotebookPen,
    title: "행동 기록·복기",
    desc: "판단과 실제 행동을 기록해, 무엇이 잘 맞았고 어긋났는지 되돌아봅니다.",
  },
];

// 로그인 사용자용 전체 바로가기
const menuGroups = [
  {
    title: "브리핑",
    items: [
      { name: "아침 브리핑", href: "/briefing" },
      { name: "판단 근거", href: "/briefing/evidence" },
      { name: "마감 전 판단", href: "/briefing/preclose" },
    ],
  },
  {
    title: "시장 · 알림 · 분석",
    items: [
      { name: "레버리지·인버스 신호", href: "/signal" },
      { name: "장중 시황 요약", href: "/market/intraday" },
      { name: "종목 단기 분석", href: "/analyze" },
      { name: "유망 섹터 모니터", href: "/sectors" },
      { name: "전문가 Q&A (AI)", href: "/consult" },
      { name: "장중 알림", href: "/alerts/intraday" },
    ],
  },
  {
    title: "포지션 · 원칙",
    items: [
      { name: "포트폴리오", href: "/positions" },
      { name: "장중 포지션 변경", href: "/positions/intraday" },
      { name: "위험선 / 알림 설정", href: "/positions/risk-line" },
      { name: "매매 원칙", href: "/principles" },
    ],
  },
  {
    title: "행동 기록 · 인사이트",
    items: [
      { name: "투자 메모", href: "/notes" },
      { name: "행동 기록", href: "/journal" },
      { name: "판단 갭 리포트", href: "/journal/gap-report" },
      { name: "유사 상황 회상", href: "/journal/similar" },
      { name: "개인화 인사이트", href: "/journal/insights" },
      { name: "오판 분석", href: "/journal/misjudgment" },
    ],
  },
];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen flex-col">
      <GlobalNav />
      <main className="mx-auto w-full max-w-[920px] px-4 py-16 sm:px-6 sm:py-20">
        <p className="flex items-center gap-1.5 text-[14px] font-semibold tracking-[0.04em] text-guard">
          <ShieldCheck size={16} /> 스탁가드
        </p>
        <h1 className="mt-3 max-w-[32rem] text-[40px] font-semibold leading-[1.1] tracking-[-0.374px] headline-tight sm:text-[48px]">
          시장이 흔들릴 때,
          <br />
          숫자와 원칙으로 행동을 붙잡습니다.
        </h1>
        <p className="mt-4 max-w-[34rem] text-[17px] leading-[1.47] text-ink-80">
          실시간 시세와 AI 분석으로 개인 투자자의 리스크를 코칭합니다. 충동적 매매 대신,
          미리 정한 원칙과 오늘의 위험 신호에 근거해 판단할 수 있도록 돕습니다.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {user ? (
            <ButtonLink href="/briefing" variant="primary" size="lg">
              오늘 브리핑 보기
            </ButtonLink>
          ) : (
            <>
              <ButtonLink href="/apply" variant="primary" size="lg">
                이용 신청
              </ButtonLink>
              <ButtonLink href="/login" variant="secondary" size="lg">
                로그인
              </ButtonLink>
            </>
          )}
        </div>

        {user ? (
          /* 로그인 사용자: 전체 바로가기 */
          <div className="mt-14">
            <h2 className="text-[14px] font-semibold uppercase tracking-[0.04em] text-ink-48">
              전체 메뉴
            </h2>
            <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
              {menuGroups.map((g) => (
                <section key={g.title} className="rounded-[18px] border border-hairline bg-canvas p-5">
                  <h3 className="text-[13px] font-semibold text-ink-48">{g.title}</h3>
                  <ul className="mt-2 space-y-1">
                    {g.items.map((it) => (
                      <li key={it.href}>
                        <Link
                          href={it.href}
                          className="block rounded-[8px] px-2 py-2 text-[16px] hover:bg-pearl hover:text-guard"
                        >
                          {it.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        ) : (
          /* 비로그인: 기능 소개 */
          <div className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {features.map((f) => (
              <div key={f.title} className="rounded-[18px] border border-hairline bg-canvas p-6">
                <f.icon size={22} className="text-guard" />
                <h3 className="mt-3 text-[18px] font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-[15px] leading-snug text-ink-80">{f.desc}</p>
              </div>
            ))}
          </div>
        )}

        <p className="mt-12 text-[13px] leading-relaxed text-ink-48">
          스탁가드는 저장한 원칙과 현재 위험 조건에 근거한 리스크 코칭을 제공하며, 투자 권유나
          매매 지시가 아닙니다. 최종 판단과 책임은 본인에게 있습니다.
        </p>
      </main>
    </div>
  );
}
