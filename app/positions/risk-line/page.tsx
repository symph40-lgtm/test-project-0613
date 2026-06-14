import { PageShell, Disclaimer } from "../../_components/Shell";
import { getRiskLines } from "./actions";
import { getAlertChannels } from "./alert-actions";
import RiskLineClient from "./RiskLineClient";
import AlertChannelSection from "./AlertChannelSection";

export default async function RiskLinePage() {
  const [lines, channels] = await Promise.all([
    getRiskLines(),
    getAlertChannels(),
  ]);

  return (
    <PageShell title="위험선 / 알림 설정" width="narrow">
      <RiskLineClient
        initialLines={lines}
        channelSection={<AlertChannelSection initialChannels={channels} />}
      />
      <Disclaimer />
    </PageShell>
  );
}
