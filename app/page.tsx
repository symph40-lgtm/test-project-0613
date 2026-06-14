import Link from "next/link";
import { GlobalNav } from "./_components/Shell";

const groups = [
  {
    title: "이용 신청 · 승인 게이트",
    screens: [
      { id: "S001", name: "이용 신청", href: "/apply" },
      { id: "S002", name: "승인 대기 / 상태", href: "/apply/status" },
      { id: "S003", name: "관리자 신청 관리", href: "/admin/applications" },
    ],
  },
  {
    title: "개장 전 방어 브리핑",
    screens: [
      { id: "S004", name: "환영 / 빠른 등록", href: "/onboarding" },
      { id: "S005", name: "아침 브리핑 대시보드", href: "/briefing" },
      { id: "S006", name: "근거 상세", href: "/briefing/evidence" },
    ],
  },
  {
    title: "포지션 등록 · 원칙 설정",
    screens: [
      { id: "S007", name: "포지션 관리", href: "/positions" },
      { id: "S008", name: "위험선 / 알림 설정", href: "/positions/risk-line" },
      { id: "S009", name: "매매 원칙", href: "/principles" },
    ],
  },
  {
    title: "장중 알림 · 마감 전 판단",
    screens: [
      { id: "S010", name: "장중 알림", href: "/alerts/intraday" },
      { id: "S011", name: "장중 포지션 변경", href: "/positions/intraday" },
      { id: "S012", name: "장중 시황 요약", href: "/market/intraday" },
      { id: "S013", name: "마감 전 판단", href: "/briefing/preclose" },
    ],
  },
  {
    title: "행동 기록 · 인사이트",
    screens: [
      { id: "S014", name: "행동 기록 입력", href: "/journal" },
      { id: "S015", name: "판단 갭 리포트", href: "/journal/gap-report" },
      { id: "S016", name: "유사 상황 회상", href: "/journal/similar" },
      { id: "S017", name: "개인화 인사이트", href: "/journal/insights" },
      { id: "S018", name: "오판 분석 리포트", href: "/journal/misjudgment" },
    ],
  },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <GlobalNav />
      <main className="mx-auto w-full max-w-[1100px] px-4 py-12 sm:px-6">
        <p className="text-[14px] font-semibold tracking-[0.04em] text-guard">
          스탁가드 · 목업
        </p>
        <h1 className="mt-2 max-w-[28rem] text-[40px] font-semibold leading-[1.1] tracking-[-0.374px] headline-tight">
          시장이 흔들릴 때, 숫자와 원칙으로 행동을 붙잡습니다.
        </h1>
        <p className="mt-3 max-w-[34rem] text-[17px] leading-[1.47] text-ink-80">
          18개 화면의 프론트엔드 목업입니다. 흐름 순서대로 화면을 검토할 수 있습니다.
          모든 데이터는 더미이며 실제 시세·판단이 아닙니다.
        </p>

        <div className="mt-10 space-y-10">
          {groups.map((g) => (
            <section key={g.title}>
              <h2 className="text-[14px] font-semibold uppercase tracking-[0.04em] text-ink-48">
                {g.title}
              </h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {g.screens.map((s) => (
                  <Link
                    key={s.id}
                    href={s.href}
                    className="group rounded-[18px] border border-hairline bg-canvas p-5 transition-colors hover:border-guard"
                  >
                    <span className="text-[12px] font-semibold tabular-nums text-ink-48">
                      {s.id}
                    </span>
                    <p className="mt-1 text-[17px] font-semibold group-hover:text-guard">
                      {s.name}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
