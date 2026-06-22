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
        섹터별 <b>수급·거래대금·상대강도·차트</b>를 100점 조건표로 채점합니다. <b>반도체</b>는 항목별 점수로
        보유 관점의 매수/매도(과열·차익·비중조절)를 진단하고, <b>반도체 외</b>에서는 단기 주도 가능성이 있는 섹터를 발굴합니다.
        방문할 때마다 최신 데이터로 갱신됩니다.
      </p>
      <SectorsClient sectors={sectors} />
      <Disclaimer />
    </PageShell>
  );
}
