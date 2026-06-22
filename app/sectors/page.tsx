import { PageShell, Disclaimer } from "../_components/Shell";
import { fetchSectorFlows } from "@/lib/market/sectors";
import SectorsClient from "./SectorsClient";

// 방문할 때마다 최신 수급으로 — 지속 모니터링
export const dynamic = "force-dynamic";

export default async function SectorsPage() {
  const sectors = await fetchSectorFlows();
  return (
    <PageShell title="유망 섹터 모니터" width="default">
      <p className="text-[15px] leading-relaxed text-ink-80">
        반도체 외 섹터의 <b>외국인·기관 수급</b>과 모멘텀을 모니터링해, 단기적으로 떠오를 가능성이 있는 섹터와
        매수 타이밍을 코칭합니다. 방문할 때마다 최신 수급으로 갱신됩니다.
      </p>
      <SectorsClient sectors={sectors} />
      <Disclaimer />
    </PageShell>
  );
}
