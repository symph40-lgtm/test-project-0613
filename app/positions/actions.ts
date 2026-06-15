"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSectorHint, calculateRiskLevel } from "@/lib/positions";

export type PositionRow = {
  id: string;
  ticker: string;
  name: string | null;
  weight: number;
  is_leverage: boolean;
  sector: string | null;
  pnl: number | null;
  risk_level: "취약" | "주의" | "안정" | null;
};

export async function getPositions(): Promise<PositionRow[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("positions")
    .select("id, ticker, name, weight, is_leverage, sector, pnl, risk_level")
    .eq("user_id", user.id)
    .order("created_at");

  return (data ?? []) as PositionRow[];
}

export async function addPosition(formData: FormData): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  const ticker = (formData.get("ticker") as string)?.trim();
  const symbol = ((formData.get("symbol") as string) ?? "").trim() || null;
  const weight = Number(formData.get("weight"));
  const is_leverage = formData.get("is_leverage") === "true";

  if (!ticker) return { error: "종목명을 입력해주세요." };
  if (!weight || weight <= 0) return { error: "비중을 입력해주세요." };

  // 현재 종목 수 확인
  const { count } = await supabase
    .from("positions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if ((count ?? 0) >= 10) return { error: "최대 10개까지만 등록할 수 있습니다." };

  const sector = getSectorHint(ticker);
  const risk_level = calculateRiskLevel({ weight, is_leverage });

  const { error } = await supabase.from("positions").upsert(
    // name 컬럼에 확정된 Yahoo 심볼 저장 (시세 조회 정확도용)
    { user_id: user.id, ticker, name: symbol, weight, is_leverage, sector, risk_level },
    { onConflict: "user_id,ticker" },
  );

  if (error) return { error: "저장 중 오류가 발생했습니다." };

  revalidatePath("/positions");
  return {};
}

export async function updatePosition(
  id: string,
  patch: { pnl?: number | null; weight?: number; is_leverage?: boolean; sector?: string | null },
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  // 위험도 재계산을 위해 현재 행 조회
  const { data: current } = await supabase
    .from("positions")
    .select("weight, is_leverage, pnl")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!current) return { error: "종목을 찾을 수 없습니다." };

  const merged = {
    weight: patch.weight ?? current.weight,
    is_leverage: patch.is_leverage ?? current.is_leverage,
    pnl: patch.pnl !== undefined ? patch.pnl : current.pnl,
  };

  const risk_level = calculateRiskLevel(merged);

  const { error } = await supabase
    .from("positions")
    .update({ ...patch, risk_level })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return { error: "수정 중 오류가 발생했습니다." };

  revalidatePath("/positions");
  return {};
}

export async function deletePosition(id: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/apply");

  const { error } = await supabase
    .from("positions")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return { error: "삭제 중 오류가 발생했습니다." };

  revalidatePath("/positions");
  return {};
}
