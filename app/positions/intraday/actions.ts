"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { calculateRiskLevel } from "@/lib/positions";

export type FillType = "매도" | "매수" | "신규";

export type Fill = {
  type: FillType;
  ticker: string;
  detail: string;
};

// detail에서 비중 숫자(%) 파싱 — "비중 8%", "8%" 형태 처리
function parseWeightFromDetail(detail: string): number | null {
  const match = detail.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

// detail에서 축소 비율 파싱 — "50% 축소" 형태
function parseReductionFromDetail(detail: string): number | null {
  const match = detail.match(/(\d+(?:\.\d+)?)\s*%\s*축소/);
  return match ? Number(match[1]) / 100 : null;
}

export async function applyFills(fills: Fill[]): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  const validFills = fills.filter((f) => f.ticker.trim());

  for (const fill of validFills) {
    const ticker = fill.ticker.trim();

    if (fill.type === "신규") {
      const weight = parseWeightFromDetail(fill.detail) ?? 5;
      const risk_level = calculateRiskLevel({ weight, is_leverage: false });

      await supabase.from("positions").upsert(
        {
          user_id: user.id,
          ticker,
          weight,
          is_leverage: false,
          risk_level,
        },
        { onConflict: "user_id,ticker" },
      );
    } else if (fill.type === "매도" || fill.type === "매수") {
      // 기존 종목 조회
      const { data: current } = await supabase
        .from("positions")
        .select("id, weight, is_leverage, pnl")
        .eq("user_id", user.id)
        .eq("ticker", ticker)
        .single();

      if (!current) continue;

      let newWeight = current.weight;

      if (fill.type === "매도") {
        const reduction = parseReductionFromDetail(fill.detail);
        if (reduction !== null) {
          newWeight = current.weight * (1 - reduction);
        } else {
          // "전량 매도" 처리
          const isFull = /전량|100%/.test(fill.detail);
          if (isFull) {
            await supabase
              .from("positions")
              .delete()
              .eq("id", current.id)
              .eq("user_id", user.id);
            continue;
          }
          const explicitWeight = parseWeightFromDetail(fill.detail);
          if (explicitWeight !== null) newWeight = explicitWeight;
        }
      } else {
        // 매수: detail에서 추가 비중 파싱
        const added = parseWeightFromDetail(fill.detail);
        if (added !== null) {
          newWeight = current.weight + added;
        }
      }

      newWeight = Math.max(0, Math.round(newWeight * 100) / 100);

      if (newWeight === 0) {
        await supabase
          .from("positions")
          .delete()
          .eq("id", current.id)
          .eq("user_id", user.id);
      } else {
        const risk_level = calculateRiskLevel({
          weight: newWeight,
          is_leverage: current.is_leverage,
          pnl: current.pnl,
        });

        await supabase
          .from("positions")
          .update({ weight: newWeight, risk_level })
          .eq("id", current.id)
          .eq("user_id", user.id);
      }
    }
  }

  // 오늘 briefing_snapshots 캐시 삭제 → /briefing 재방문 시 갱신된 포지션으로 재판단
  const today = new Date().toISOString().slice(0, 10);
  await supabase
    .from("briefing_snapshots")
    .delete()
    .eq("user_id", user.id)
    .eq("date", today);

  redirect("/briefing");
}

export async function getUpdatedPositions(): Promise<
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
