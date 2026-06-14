import { PageShell, Disclaimer } from "../_components/Shell";
import { ButtonLink } from "../_components/Button";
import { getPositions } from "./actions";
import PositionsClient from "./PositionsClient";

export default async function PositionsPage() {
  const positions = await getPositions();

  return (
    <PageShell
      title="포트폴리오"
      width="wide"
      subNavRight={
        <ButtonLink href="/positions/risk-line" variant="primary">
          위험선 추천 받기
        </ButtonLink>
      }
    >
      <PositionsClient initialPositions={positions} />

      <div className="mt-6 sm:hidden">
        <ButtonLink href="/positions/risk-line" variant="primary">
          위험선 추천 받기
        </ButtonLink>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
