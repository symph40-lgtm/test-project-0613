"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSectorHint, calculateRiskLevel } from "@/lib/positions";

export type SavePositionsRow = {
  ticker: string;
  symbol?: string | null; // 자동완성으로 확정된 Yahoo 심볼
  weight: string;
  leverage: boolean;
};

export async function savePositions(rows: SavePositionsRow[]): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/apply");

  const validRows = rows.filter((r) => r.ticker.trim() && Number(r.weight) > 0);

  if (validRows.length === 0) redirect("/briefing");
  if (validRows.length > 10) {
    throw new Error("최대 10개까지만 등록할 수 있습니다.");
  }

  // 현재 저장된 ticker 목록 조회
  const { data: existing } = await supabase
    .from("positions")
    .select("ticker")
    .eq("user_id", user.id);

  const existingTickers = existing?.map((r) => r.ticker) ?? [];
  const newTickers = validRows.map((r) => r.ticker.trim());
  const toDelete = existingTickers.filter((t) => !newTickers.includes(t));

  // 제거된 종목 삭제
  if (toDelete.length > 0) {
    await supabase
      .from("positions")
      .delete()
      .eq("user_id", user.id)
      .in("ticker", toDelete);
  }

  // UPSERT
  for (const row of validRows) {
    const ticker = row.ticker.trim();
    const weight = Number(row.weight);
    const is_leverage = row.leverage;
    const sector = getSectorHint(ticker);
    const risk_level = calculateRiskLevel({ weight, is_leverage });

    await supabase.from("positions").upsert(
      {
        user_id: user.id,
        ticker,
        // name 컬럼에 확정된 Yahoo 심볼 저장 (시세 조회 정확도용)
        name: row.symbol ?? null,
        weight,
        is_leverage,
        sector,
        risk_level,
      },
      { onConflict: "user_id,ticker" },
    );
  }

  redirect("/briefing");
}

export async function getPositionsForOnboarding(): Promise<
  { ticker: string; weight: number; is_leverage: boolean }[]
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data } = await supabase
    .from("positions")
    .select("ticker, weight, is_leverage")
    .eq("user_id", user.id)
    .order("created_at");

  return (data ?? []) as { ticker: string; weight: number; is_leverage: boolean }[];
}
