import { PageShell, Disclaimer } from "../_components/Shell";
import { getPrinciples } from "./actions";
import PrinciplesClient from "./PrinciplesClient";

export default async function PrinciplesPage() {
  const items = await getPrinciples();

  return (
    <PageShell title="매매 원칙" width="narrow">
      <PrinciplesClient initialItems={items} />
      <Disclaimer />
    </PageShell>
  );
}
