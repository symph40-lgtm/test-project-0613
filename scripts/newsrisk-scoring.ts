// AI 정성 판단(newsRisk)의 실제 예측력 채점 (사용자 질문 2026-08-08 "너는 요인들을 분석해서
// 애널리스트처럼 점도표로 판단할 실력이 있는가"):
//   npx tsx scripts/newsrisk-scoring.ts
// 이 시스템은 이미 매일 AI 판단을 기록해왔다 — predict_daily_days.macro.newsRisk(하방 위험 0~10,
// 구글뉴스 6질의 → claude-haiku)와 predict_case_days.cause(원인 텍스트).
// 스펙에 "게이트 아님 — 60일 라이브 채점 후 승격 검토"로 사전 등록돼 있으므로, 그 채점을 지금 한다.
// 검증: newsRisk 점수와 이후 수익(label_r1·r3)의 관계 — 높을수록 실제로 더 떨어졌나?
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

type Row = { date: string; symbol: string; macro: { newsRisk?: number | { score?: number; note?: string } } | null; label_r1: number | null; label_r3: number | null; source: string };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await sb.from("predict_daily_days").select("date,symbol,macro,label_r1,label_r3,source").order("date");
  if (error) { console.error(error); return; }
  const rows = (data ?? []) as Row[];
  const score = (r: Row): number | null => {
    const v = r.macro?.newsRisk;
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && typeof v.score === "number") return v.score;
    return null;
  };
  const withNR = rows.filter(r => score(r) !== null);
  console.log(`전체 ${rows.length}행 · newsRisk 기록 ${withNR.length}행`);
  if (!withNR.length) {
    console.log("newsRisk가 기록된 행이 없음 — macro 필드 샘플:");
    for (const r of rows.slice(-3)) console.log(`  ${r.date} ${r.symbol}: ${JSON.stringify(r.macro)?.slice(0, 300)}`);
    return;
  }
  for (const sym of [...new Set(withNR.map(r => r.symbol))]) {
    const g = withNR.filter(r => r.symbol === sym && r.label_r1 !== null);
    if (g.length < 5) { console.log(`\n${sym}: 채점 가능 ${g.length}행 — 부족`); continue; }
    console.log(`\n════ ${sym} — newsRisk 채점 ${g.length}일 (${g[0].date}~${g[g.length - 1].date}) ════`);
    const vals = g.map(r => score(r)!);
    console.log(`  점수 분포: 최소 ${Math.min(...vals)} · 최대 ${Math.max(...vals)} · 평균 ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}`);
    // 구간별 이후 수익 — 하방 위험이 높다고 판단한 날이 실제로 더 떨어졌나
    for (const [lb, f] of [["낮음(0~3)", (v: number) => v <= 3], ["중간(4~6)", (v: number) => v >= 4 && v <= 6], ["높음(7~10)", (v: number) => v >= 7]] as [string, (v: number) => boolean][]) {
      const h = g.filter(r => f(score(r)!));
      if (!h.length) { console.log(`  ${lb.padEnd(12)} 0일`); continue; }
      const r1 = h.map(r => r.label_r1!), r3 = h.filter(r => r.label_r3 !== null).map(r => r.label_r3!);
      console.log(`  ${lb.padEnd(12)} ${String(h.length).padStart(3)}일 · 익일 평균 ${s2(r1.reduce((a, b) => a + b, 0) / r1.length).padStart(7)}% (하락일 ${pctOf(r1.filter(x => x < 0).length, r1.length)}) · 3일 평균 ${r3.length ? s2(r3.reduce((a, b) => a + b, 0) / r3.length) : "—"}`);
    }
    // 상관계수 (점수 높을수록 수익 낮아야 = 음의 상관이 나와야 유효)
    const corr = (xs: number[], ys: number[]) => {
      const n = xs.length; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sx = 0, sy = 0;
      for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
      return sx > 0 && sy > 0 ? sxy / Math.sqrt(sx * sy) : 0;
    };
    const g3 = g.filter(r => r.label_r3 !== null);
    console.log(`  상관계수: newsRisk vs 익일수익 ${corr(g.map(r => score(r)!), g.map(r => r.label_r1!)).toFixed(3)} · vs 3일수익 ${g3.length ? corr(g3.map(r => score(r)!), g3.map(r => r.label_r3!)).toFixed(3) : "—"}  (음수여야 유효)`);
  }
  // 사례 메모리 cause 축적 현황
  const { data: cases } = await sb.from("predict_case_days").select("date,cause,tags,next_ss,next_hx").order("date", { ascending: false }).limit(10);
  const withCause = (cases ?? []).filter((c: { cause?: string | null }) => c.cause);
  console.log(`\n════ 사례 메모리 cause(AI 원인 텍스트) 최근 ${(cases ?? []).length}건 중 기록 ${withCause.length}건 ════`);
  for (const c of withCause.slice(0, 5)) console.log(`  ${(c as { date: string }).date}: ${String((c as { cause: string }).cause).slice(0, 110)}`);
}
main();
