import { PageShell, Disclaimer } from "../../_components/Shell";
import { getUpdatedPositions } from "./actions";
import IntradayClient from "./IntradayClient";

export default async function IntradayPositionPage() {
  const positions = await getUpdatedPositions();

  return (
    <PageShell title="장중 포지션 변경" width="narrow">
      <IntradayClient initialPositions={positions} />
      <Disclaimer />
    </PageShell>
  );
}
