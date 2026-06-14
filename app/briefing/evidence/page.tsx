import { getBriefing } from "../actions";
import EvidenceClient from "./EvidenceClient";

export default async function EvidencePage() {
  const snapshot = await getBriefing();
  return <EvidenceClient snapshot={snapshot} />;
}
