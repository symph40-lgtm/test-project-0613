// E-섀도 MT 조건 병기 (발주서 WORKORDER_MT_v04 §5 사다리 2단계 · §6 DoD).
// ⚠ 판정 무개입: G1A의 이벤트 밤 E-섀도 기록에 "MT 일치 시 E-Low 요건 충족" **판정 병기만** 얹는다.
//    사다리 2단계 정식 진입은 백필 ⓓ 관문 통과가 조건인데 현재 미통과(docs/mt-backfill-60d.md)이므로,
//    이 병기는 **기록 전용 표본 축적**이며 관문 미통과 사실을 문자열에 함께 남긴다.

import { MT_CONFIG } from "./config";
import type { MtDay } from "./types";

export type MtEShadow = {
  date: string; mt: number; phase_top: string; agree: boolean | null;
  strong: boolean; phase_aligned: boolean; e_low_by_mt: boolean; note: string;
};

/** MT 기준 E-Low 요건 판정 (F-Low 설계 문서 §2 ③④⑤와 같은 조건을 이벤트 밤에 적용) */
export function mtEShadowFromDay(day: MtDay, dir: "UP" | "DOWN" | null): MtEShadow {
  const mt = day.tone.mt;
  const agree = dir == null || mt === 0 ? null : (dir === "UP") === (mt > 0);
  const strong = Math.abs(mt) >= MT_CONFIG.tone.strengthStrong;
  const P = day.phase.P;
  const phaseAligned = mt > 0 ? P.S1 + P.S2 >= 0.6 : P.S3 + P.S4 >= 0.6;
  const ok = agree === true && strong && phaseAligned;
  const misses = [
    agree === null ? "MT 무방향" : agree ? null : "MT 충돌",
    strong ? null : `강도 부족(|MT| ${Math.abs(mt).toFixed(2)} < ${MT_CONFIG.tone.strengthStrong})`,
    phaseAligned ? null : "국면 불일치",
  ].filter((x): x is string => !!x);
  return {
    date: day.date, mt, phase_top: day.phase.top, agree, strong, phase_aligned: phaseAligned,
    e_low_by_mt: ok,
    note: ok
      ? `MT 일치·강도 ${Math.abs(mt).toFixed(2)}·국면 정합 → E-Low 요건 충족 (가상·기록 전용 — ⓓ 관문 미통과 상태)`
      : `E-Low 요건 미충족 (${misses.join(" · ")})`,
  };
}

/** 저장된 mt_days에서 해당 일자 행을 찾아 병기값 산출 (없으면 null — G1A 판정에 영향 없음) */
export async function mtEShadowNote(symbol: string, date: string, dir: "UP" | "DOWN" | null): Promise<MtEShadow | null> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data } = await createAdminClient().from("mt_days").select("*").eq("symbol", symbol).eq("date", date).maybeSingle();
    return data ? mtEShadowFromDay(data as MtDay, dir) : null;
  } catch {
    return null;   // 마이그레이션 037 미적용 등 — 병기 생략
  }
}
