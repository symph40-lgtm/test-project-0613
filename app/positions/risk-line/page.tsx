import { PageShell, Disclaimer } from "../../_components/Shell";
import { Card, SectionLabel } from "../../_components/primitives";
import { getRiskLines } from "./actions";
import RiskLineClient from "./RiskLineClient";

// 알림 채널 섹션은 T006에서 실제 DB 연결 예정 — 현재는 placeholder
function ChannelPlaceholder() {
  return (
    <Card className="mt-4">
      <SectionLabel>알림 채널</SectionLabel>
      <p className="text-[14px] text-ink-48">
        알림 채널 인증은 아래 설정에서 완료해주세요.
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-3 py-2">
          <span className="w-14 shrink-0 text-[14px] text-ink-48">이메일</span>
          <span className="flex-1 text-[15px] text-ink-48">미등록</span>
        </div>
        <div className="flex items-center gap-3 py-2">
          <span className="w-14 shrink-0 text-[14px] text-ink-48">휴대폰</span>
          <span className="flex-1 text-[15px] text-ink-48">서비스 준비 중</span>
        </div>
      </div>
    </Card>
  );
}

export default async function RiskLinePage() {
  const lines = await getRiskLines();

  return (
    <PageShell title="위험선 / 알림 설정" width="narrow">
      <RiskLineClient
        initialLines={lines}
        channelSection={<ChannelPlaceholder />}
      />
      <Disclaimer />
    </PageShell>
  );
}
