import { getPersonalizationSettings, generateInsights } from "./actions";
import InsightsClient from "./InsightsClient";

export default async function InsightsPage() {
  const [settings, insights] = await Promise.all([
    getPersonalizationSettings(),
    generateInsights(),
  ]);
  return <InsightsClient settings={settings} insights={insights} />;
}
