// 레버리지·인버스 신호 시스템 대시보드 (M7).
// 기획: docs/signal-system-master-spec.md (v2.4) · docs/signal-system-ext-modules.md (v1.0)
// 서버에서 6월 재현 검증(순수 함수)을 돌려 내려주고, 실시간 판정은 클라이언트가 60초 폴링.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runBacktest } from "@/lib/signal/backtest";
import SignalClient from "./SignalClient";

export const dynamic = "force-dynamic";

export default async function SignalPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const backtest = runBacktest();

  return <SignalClient backtest={backtest} />;
}
