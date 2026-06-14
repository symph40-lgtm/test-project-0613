import { getPositionsForOnboarding } from "./actions";
import OnboardingClient from "./OnboardingClient";

export default async function OnboardingPage() {
  const initialPositions = await getPositionsForOnboarding();
  return <OnboardingClient initialPositions={initialPositions} />;
}
