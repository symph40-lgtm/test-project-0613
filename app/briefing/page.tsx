import { getBriefing } from "./actions";
import { hasTodayBookmark } from "./preclose/actions";
import BriefingClient from "./BriefingClient";

export default async function BriefingPage() {
  const [snapshot, hasBookmark] = await Promise.all([
    getBriefing(),
    hasTodayBookmark(),
  ]);
  return <BriefingClient snapshot={snapshot} hasBookmark={hasBookmark} />;
}
