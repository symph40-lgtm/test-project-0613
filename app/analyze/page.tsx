import { PageShell, Disclaimer } from "../_components/Shell";
import AnalyzeClient from "./_client";

export default function AnalyzePage() {
  return (
    <PageShell title="종목 단기 분석" width="default">
      <p className="text-[15px] text-ink-80">
        종목을 입력하면 매크로·섹터·밸류에이션(PER)·기술적 차트(이동평균·RSI·추세)를 종합해
        단기(수일~수주) 방향을 분석합니다.
      </p>
      <AnalyzeClient />
      <Disclaimer />
    </PageShell>
  );
}
