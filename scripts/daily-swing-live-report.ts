// 일봉 스윙(predict-daily) 라이브 성과 요약 (사용자 질문 2026-08-08 "일봉 예측 모델들 성과 어때?"):
//   npx tsx scripts/daily-swing-live-report.ts
// predict_daily_days 실제 기록만 읽어 ①시스템(판정 스탠스) 성과 ②7모델 방향적중 ③최근 구간을 낸다.
// 백필분(source=backfill)과 라이브분(live)을 분리 — 라이브가 실제 성적이다.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

type Row = {
  date: string; symbol: string; stance: string; exposure: number; base_exposure: number;
  model_stances: Record<string, string> | null; gates: string[] | null;
  label_r1: number | null; label_r3: number | null;
  close_px: number | null; source: string;
};
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

// 스탠스가 방향을 맞췄나 (long이면 상승, short이면 하락이 적중 / flat은 채점 제외)
function hit(stance: string, r: number | null): boolean | null {
  if (r === null || !isFinite(r)) return null;
  if (stance === "long") return r > 0;
  if (stance === "short") return r < 0;
  return null;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await sb
    .from("predict_daily_days")
    .select("date,symbol,stance,exposure,base_exposure,model_stances,gates,label_r1,label_r3,close_px,source")
    .order("date", { ascending: true });
  if (error) { console.error(error); return; }
  const rows = (data ?? []) as Row[];
  if (!rows.length) { console.log("기록 없음"); return; }

  for (const sym of [...new Set(rows.map((r) => r.symbol))]) {
    const all = rows.filter((r) => r.symbol === sym);
    const live = all.filter((r) => r.source === "live");
    const bf = all.filter((r) => r.source !== "live");
    console.log(`\n════ ${sym} — 전체 ${all.length}행 (라이브 ${live.length} · 백필 ${bf.length}) ════`);
    console.log(`  기간: ${all[0].date} ~ ${all[all.length - 1].date} · 라이브 ${live.length ? `${live[0].date} ~ ${live[live.length - 1].date}` : "없음"}`);

    for (const [label, set] of [["라이브", live], ["백필(대조)", bf]] as [string, Row[]][]) {
      const scored = set.filter((r) => r.label_r3 !== null);
      if (!scored.length) { console.log(`  ${label}: 채점된 행 없음 (${set.length}행 중 label_r3 미기입 ${set.length}건)`); continue; }
      // ① 시스템 스탠스 방향적중
      const h3 = scored.map((r) => hit(r.stance, r.label_r3)).filter((x): x is boolean => x !== null);
      const h1 = scored.map((r) => hit(r.stance, r.label_r1)).filter((x): x is boolean => x !== null);
      // ② 비중 반영 수익 (exposure × r1을 매일 — 근사 경제성)
      const expRet = scored.reduce((a, r) => a + (r.exposure ?? 0) * (r.label_r1 ?? 0), 0);
      const bh = scored.reduce((a, r) => a + (r.label_r1 ?? 0), 0);
      const stances = scored.reduce((m: Record<string, number>, r) => { m[r.stance] = (m[r.stance] ?? 0) + 1; return m; }, {});
      console.log(`  ── ${label} (채점 ${scored.length}일) ──`);
      console.log(`    스탠스 분포: ${Object.entries(stances).map(([k, v]) => `${k} ${v}일`).join(" · ")} · 평균 비중 ${(scored.reduce((a, r) => a + (r.exposure ?? 0), 0) / scored.length * 100).toFixed(0)}%`);
      console.log(`    시스템 방향적중: r3 ${pctOf(h3.filter(Boolean).length, h3.length)} (${h3.filter(Boolean).length}/${h3.length}) · r1 ${pctOf(h1.filter(Boolean).length, h1.length)} (${h1.filter(Boolean).length}/${h1.length})`);
      console.log(`    누적(익일수익 합·근사): 시스템(비중반영) ${s1(expRet)}% vs 항상보유 ${s1(bh)}% · 차이 ${s1(expRet - bh)}%p`);
      // ③ 모델별 방향적중 (r3)
      const models = [...new Set(scored.flatMap((r) => Object.keys(r.model_stances ?? {})))];
      if (models.length) {
        console.log(`    ── 모델별 r3 방향적중 (flat 제외) ──`);
        const stats = models.map((m) => {
          const hs = scored.map((r) => hit((r.model_stances ?? {})[m] ?? "flat", r.label_r3)).filter((x): x is boolean => x !== null);
          const ret = scored.reduce((a, r) => a + ((r.model_stances ?? {})[m] === "long" ? (r.label_r1 ?? 0) : 0), 0);
          return { m, n: hs.length, w: hs.filter(Boolean).length, ret };
        }).sort((a, b) => (b.n ? b.w / b.n : 0) - (a.n ? a.w / a.n : 0));
        for (const s of stats) {
          console.log(`      ${s.m.padEnd(14)} ${pctOf(s.w, s.n).padStart(4)} (${s.w}/${s.n})  · long일 익일수익 합 ${s1(s.ret)}%`);
        }
      }
      // ④ 게이트 발동
      const gated = scored.filter((r) => (r.gates ?? []).length > 0);
      if (gated.length) {
        const cnt: Record<string, number> = {};
        for (const r of gated) for (const g of r.gates ?? []) { const k = g.split("(")[0]; cnt[k] = (cnt[k] ?? 0) + 1; }
        console.log(`    게이트 발동 ${gated.length}일: ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      }
    }
    // 최근 10일 라이브 흐름
    const recent = live.slice(-10);
    if (recent.length) {
      console.log(`  ── 최근 라이브 ${recent.length}일 ──`);
      for (const r of recent) {
        console.log(`    ${r.date} ${r.stance.padEnd(5)} 비중 ${Math.round((r.exposure ?? 0) * 100).toString().padStart(3)}% · r1 ${r.label_r1 === null ? "  —  " : s2(r.label_r1).padStart(6)} · r3 ${r.label_r3 === null ? "  —  " : s2(r.label_r3).padStart(6)}${(r.gates ?? []).length ? ` · ${(r.gates ?? []).join(",")}` : ""}`);
      }
    }
  }
}
main();
