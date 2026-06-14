import { getLatestAlert } from "./actions";
import IntradayAlertClient from "./IntradayAlertClient";

export default async function IntradayAlertPage() {
  const alert = await getLatestAlert();
  return <IntradayAlertClient alert={alert} />;
}
