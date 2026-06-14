import { PageShell } from "../../_components/Shell";
import { getApplications } from "./actions";
import ApplicationsClient from "./ApplicationsClient";

type Filter = "pending" | "approved" | "rejected";

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const params = await searchParams;
  const filter = (params.filter ?? "pending") as Filter;

  if (!["pending", "approved", "rejected"].includes(filter)) {
    return null;
  }

  const applications = await getApplications(filter);

  return (
    <PageShell title="이용 신청 관리" badge="관리자" width="wide">
      <ApplicationsClient applications={applications} filter={filter} />

      <p className="mt-6 text-[13px] text-ink-48">
        관리자 권한이 없는 사용자는 이 화면에 접근할 수 없습니다. 승인 시 신청자에게
        초대 이메일이 발송됩니다.
      </p>
    </PageShell>
  );
}
