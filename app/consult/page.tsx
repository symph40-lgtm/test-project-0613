import { PageShell, Disclaimer } from "../_components/Shell";
import { getConsultHistory } from "./actions";
import ConsultClient from "./_client";

export const dynamic = "force-dynamic";

export default async function ConsultPage() {
  const history = await getConsultHistory(20);
  return (
    <PageShell title="전문가 Q&A (AI)" width="default">
      <p className="text-[15px] leading-relaxed text-ink-80">
        주식·시장에 대해 질문하면 <b>ChatGPT(OpenAI)</b>와 <b>Claude</b> 두 AI가 애널리스트 관점으로 답합니다.
        답변을 비교해 보고, ‘시황 반영’을 켠 질문은 이후 장중 시황 해설·컨설팅에 참고 자료로 들어갑니다.
      </p>
      <ConsultClient initialHistory={history} />
      <Disclaimer />
    </PageShell>
  );
}
