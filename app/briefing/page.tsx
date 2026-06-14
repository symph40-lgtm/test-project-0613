import { getBriefing } from "./actions";
import BriefingClient from "./BriefingClient";

export default async function BriefingPage() {
  const snapshot = await getBriefing();
  return <BriefingClient snapshot={snapshot} />;
}
