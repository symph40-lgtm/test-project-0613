import Link from "next/link";
import { ShieldCheck, TrendingUp, BellRing, NotebookPen } from "lucide-react";
import { GlobalNav } from "./_components/Shell";
import { ButtonLink } from "./_components/Button";
import { createClient } from "@/lib/supabase/server";

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

        <div className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="rounded-[18px] border border-hairline bg-canvas p-6">
              <f.icon size={22} className="text-guard" />
              <h3 className="mt-3 text-[18px] font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-[15px] leading-snug text-ink-80">{f.desc}</p>
            </div>
          ))}
        </div>

        <p className="mt-12 text-[13px] leading-relaxed text-ink-48">
          스탁가드는 저장한 원칙과 현재 위험 조건에 근거한 리스크 코칭을 제공하며, 투자 권유나
          매매 지시가 아닙니다. 최종 판단과 책임은 본인에게 있습니다.
        </p>
      </main>
    </div>
  );
}
