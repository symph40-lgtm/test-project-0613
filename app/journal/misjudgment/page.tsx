import { getMisjudgmentData } from "./actions";
import MisjudgmentClient from "./MisjudgmentClient";

export default async function MisjudgmentPage() {
  const data = await getMisjudgmentData();
  return <MisjudgmentClient data={data} />;
}
