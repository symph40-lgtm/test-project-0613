import { PageShell } from "../_components/Shell";
import LoginForm from "./_client";

export default function LoginPage() {
  return (
    <PageShell title="로그인" width="narrow">
      <div className="rounded-[18px] border border-hairline bg-canvas p-6">
        <p className="mb-6 text-[14px] text-ink-48">
          초대 이메일로 설정한 비밀번호로 로그인하세요.
        </p>
        <LoginForm />
      </div>
      <p className="mt-4 text-center text-[14px] text-ink-48">
        아직 신청 전이라면{" "}
        <a href="/apply" className="text-guard underline">
          이용 신청
        </a>
        을 먼저 해주세요.
      </p>
    </PageShell>
  );
}
