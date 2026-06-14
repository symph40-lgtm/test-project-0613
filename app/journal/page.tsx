import { getTodayGuidance } from "./actions";
import JournalClient from "./JournalClient";

export default async function JournalPage() {
  const guidance = await getTodayGuidance();
  return <JournalClient guidance={guidance} />;
}
