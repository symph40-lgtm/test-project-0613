import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CircleDot, CheckCircle2, XCircle } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { ButtonLink } from "../../_components/Button";
import { Card, Field, MetaRow, StateNote } from "../../_components/primitives";
import { getApplicationStatus } from "../actions";
import type { ApplicationStatus } from "../actions";

export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const cookieEmail = cookieStore.get("applicant_email")?.value;
  const email = cookieEmail || params.email;

  if (!email) {
    return (
      <PageShell title="신청 상태" width="narrow">
        <EmailLookupForm />
        <Disclaimer />
      </PageShell>
    );
  }

  const application = await getApplicationStatus(email);

  if (!application) {
    return (
      <PageShell title="신청 상태" width="narrow">
        <EmailLookupForm notFound />
        <Disclaimer />
      </PageShell>
    );
  }

  return (
    <PageShell title="신청 상태" width="narrow">
      <ApplicationStatusCard application={application} />
      <Disclaimer />
    </PageShell>
  );
}

function ApplicationStatusCard({ application }: { application: ApplicationStatus }) {
  const { status, rejection_reason, created_at } = application;

  const meta = {
    pending: {
      icon: CircleDot,
      title: "신청 상태: 대기 중",
      desc: "신청이 접수되었습니다. 관리자 검토 후 결과를 알려드립니다.",
    },
    approved: {
      icon: CheckCircle2,
      title: "승인되었습니다",
      desc: "초대 이메일을 확인해 서비스에 진입하세요. 이메일이 오지 않았다면 스팸함을 확인해주세요.",
    },
    rejected: {
      icon: XCircle,
      title: "신청이 거절되었습니다",
      desc: "이번에는 대상 조건을 충족하지 못했습니다.",
    },
  }[status];

  const Icon = meta.icon;
  const formattedDate = new Date(created_at).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Icon size={20} className="text-guard" />
        <h2 className="text-[21px] font-semibold tracking-[0.231px]">{meta.title}</h2>
      </div>
      <p className="mt-2 text-[17px] leading-[1.47] text-ink-80">{meta.desc}</p>

      <div className="mt-5 border-t border-divider pt-4">
        <MetaRow label="접수일" value={formattedDate} />
        <MetaRow label="통지 채널" value="이메일 초대" />
        {status === "rejected" && rejection_reason ? (
          <MetaRow label="거절 사유" value={rejection_reason} />
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {status === "approved" ? (
          <ButtonLink variant="primary" size="lg" href="/onboarding">
            시작하기
          </ButtonLink>
        ) : null}
        {status === "pending" ? (
          <Link
            href="/apply/status"
            className="inline-flex items-center gap-2 rounded-full border border-guard px-[22px] py-[11px] text-[17px] text-guard transition-transform active:scale-95"
          >
            상태 새로고침
          </Link>
        ) : null}
        {status === "rejected" ? (
          <Link
            href="/apply"
            className="text-[17px] text-guard transition-transform active:scale-95"
          >
            다시 신청하기
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

function EmailLookupForm({ notFound }: { notFound?: boolean }) {
  return (
    <div className="space-y-5">
      {notFound ? (
        <StateNote tone="error" title="신청 내역을 찾을 수 없습니다.">
          입력한 이메일로 신청 내역이 없습니다. 이메일을 확인하거나 새로 신청해주세요.
        </StateNote>
      ) : (
        <p className="text-[17px] leading-[1.47] text-ink-80">
          신청 시 입력한 이메일로 현재 상태를 조회합니다.
        </p>
      )}

      <form method="get" action="/apply/status" className="space-y-4">
        <Field
          label="이메일"
          name="email"
          type="email"
          placeholder="hong@example.com"
          required
        />
        <div className="flex gap-3">
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-full bg-guard px-[22px] py-[11px] text-[17px] text-white transition-transform active:scale-95"
          >
            상태 조회
          </button>
          <Link
            href="/apply"
            className="inline-flex items-center justify-center px-[22px] py-[11px] text-[17px] text-guard"
          >
            신청하기
          </Link>
        </div>
      </form>
    </div>
  );
}
