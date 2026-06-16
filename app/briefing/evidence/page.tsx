import { getBriefing } from "../actions";
import { createClient } from "@/lib/supabase/server";
import { fetchHoldingsFlow, toKrCode, type StockFlow } from "@/lib/market/naver-flow";
import EvidenceClient from "./EvidenceClient";

export const dynamic = "force-dynamic";

export default async function EvidencePage() {
  const snapshot = await getBriefing();

  // 보유 한국 종목 수급(외국인·기관 순매매) 조회
  let supplyFlows: StockFlow[] = [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: positions } = await supabase
        .from("positions")
        .select("ticker, name, weight")
        .eq("user_id", user.id)
        .order("weight", { ascending: false });

      const krHoldings = (positions ?? [])
        .map((p) => {
          const code = toKrCode(p.name as string | null, p.ticker);
          return code ? { ticker: p.ticker, code } : null;
        })
        .filter((v): v is { ticker: string; code: string } => v !== null);

      if (krHoldings.length > 0) {
        supplyFlows = await fetchHoldingsFlow(krHoldings, 6);
      }
    }
  } catch {
    supplyFlows = [];
  }

  return <EvidenceClient snapshot={snapshot} supplyFlows={supplyFlows} />;
}
