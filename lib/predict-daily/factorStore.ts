// 팩터 일일 스냅샷 저장 (docs/factor-quant-plan.md Phase 0 · 마이그레이션 033)
// 지금까지 계산만 하고 버리던 값들을 매일 한 행으로 남긴다 — 저장이 없으면 60일 뒤에도 검증을 시작할 수 없다.
// 이 모듈은 '기록 전용'이다. 어떤 판정에도 관여하지 않으며 실패는 삼켜 본 흐름을 막지 않는다.
// 채점 라벨(T0~T3)은 다음 거래일 이후 소급 기입 — predict_daily_days와 동일 사상(크론 결번에 강함).

import { createAdminClient } from "@/lib/supabase/admin";
import type { DailyBar, MacroSnap, Stance } from "./types";

export type FactorCell = { v: number | null; dir: -1 | 0 | 1; str?: number; src: string };

// 방향 부호: '주가에 우호적'이면 +1. 금리·달러·유가 상승은 하방(-1)이 관례(축1 정의와 동일).
const sgn = (v: number | null | undefined, up: number, dn: number, invert = false): -1 | 0 | 1 => {
  if (v == null || !isFinite(v)) return 0;
  const d = v >= up ? 1 : v <= dn ? -1 : 0;
  return (invert ? (-d as -1 | 0 | 1) : d);
};

export function buildFactors(macro: MacroSnap | null, stances: Record<string, Stance>): Record<string, FactorCell> {
  const f: Record<string, FactorCell> = {};
  const m = macro;
  // ── 매크로 (축1 C계열과 같은 부호 규약)
  f.sox = { v: m?.sox ?? null, dir: sgn(m?.sox, 0.5, -0.5), src: "yahoo:^SOX" };
  f.fxChg = { v: m?.fxChg ?? null, dir: sgn(m?.fxChg, 0.3, 0.05, true), src: "yahoo:KRW=X" };
  f.fxLevel = { v: m?.fxLevel ?? null, dir: 0, src: "yahoo:KRW=X" };
  f.y10Chg = { v: m?.y10Chg ?? null, dir: sgn(m?.y10Chg, 0.03, -0.03, true), src: "yahoo:^TNX" };
  f.y10 = { v: m?.y10 ?? null, dir: 0, src: "yahoo:^TNX" };
  f.dxyChg = { v: m?.dxyChg ?? null, dir: sgn(m?.dxyChg, 0.3, -0.3, true), src: "yahoo:DX-Y.NYB" };
  f.wtiChg = { v: m?.wtiChg ?? null, dir: sgn(m?.wtiChg, 2, -2, true), src: "yahoo:CL=F" };
  // ── 52주 위치·구간 게이트 (이미 판정에 쓰이는 것 — 기록도 남긴다)
  f.zoneFx = { v: m?.zoneFx ? 1 : 0, dir: m?.zoneFx ? -1 : 0, src: "calc" };
  f.zoneDxy = { v: m?.zoneDxy ? 1 : 0, dir: m?.zoneDxy ? -1 : 0, src: "calc" };
  f.fxPos52 = { v: m?.fxPos52 ?? null, dir: 0, src: "calc" };
  f.y10Pos52 = { v: m?.y10Pos52 ?? null, dir: 0, src: "calc" };
  // ── 수급 (표시 전용이지만 기록은 남겨야 나중에 검정 가능)
  f.kospiFrgnCash = { v: m?.kospiFlow?.cash ?? null, dir: sgn(m?.kospiFlow?.cash, 1, -1), src: "naver" };
  f.kospiFrgnCash3 = { v: m?.kospiFlow?.cash3 ?? null, dir: sgn(m?.kospiFlow?.cash3, 1, -1), src: "naver" };
  f.kospiFrgnFut3 = { v: m?.kospiFlow?.fut3 ?? null, dir: sgn(m?.kospiFlow?.fut3, 1, -1), src: "naver" };
  // ── 환경 점수판
  f.envScore = { v: m?.envScore ?? null, dir: 0, src: "calc" };
  // ── 모델 스탠스 (7모델) — 가격 팩터 대조군
  for (const [k, v] of Object.entries(stances)) {
    f[`m_${k}`] = { v: v === "long" ? 1 : v === "short" ? -1 : 0, dir: v === "long" ? 1 : v === "short" ? -1 : 0, src: "model" };
  }
  return f;
}

export async function upsertFactorDay(date: string, symbol: string, factors: Record<string, FactorCell>, scores: Record<string, unknown>): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("predict_factor_days").upsert(
      { date, symbol, factors, scores, source: "live" },
      { onConflict: "date,symbol" },
    );
  } catch { /* 기록 전용 — 실패해도 판정에 영향 없음 */ }
}

// 라벨 소급 기입: 저장된 과거 행에 T0~T3를 채운다. bars는 최신순 아님(오름차순) 가정.
export async function labelFactorDays(symbol: string, bars: DailyBar[]): Promise<number> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("predict_factor_days")
      .select("date,t0_gap,t1_roc,t2_rcc,t3_r3")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(30);
    const rows = (data ?? []) as { date: string; t0_gap: number | null; t3_r3: number | null }[];
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    let n = 0;
    for (const r of rows) {
      if (r.t0_gap !== null && r.t3_r3 !== null) continue;   // 이미 완전히 채워짐
      const i = idx.get(r.date);
      if (i === undefined) continue;
      const cur = bars[i], nx = bars[i + 1];
      if (!nx) continue;
      const patch: Record<string, number | string> = {
        t0_gap: ((nx.open - cur.close) / cur.close) * 100,
        t1_roc: ((nx.close - nx.open) / nx.open) * 100,
        t2_rcc: ((nx.close - cur.close) / cur.close) * 100,
        labeled_at: new Date().toISOString(),
      };
      const n3 = bars[i + 3];
      if (n3) patch.t3_r3 = ((n3.close - cur.close) / cur.close) * 100;
      await admin.from("predict_factor_days").update(patch).eq("date", r.date).eq("symbol", symbol);
      n++;
    }
    return n;
  } catch { return 0; }
}
