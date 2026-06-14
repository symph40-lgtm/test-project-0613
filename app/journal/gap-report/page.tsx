import { getGapReport } from "./actions";
import GapReportClient from "./GapReportClient";

export default async function GapReportPage() {
  const report = await getGapReport();
  return <GapReportClient report={report} />;
}
