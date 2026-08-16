// E-섀도 MT 조건 병기 — 2026-08-14 밤 MT 재구성 소급 표본 (발주서 §5 사다리 2단계 · §6 DoD)
//   npx tsx scripts/mt-eshadow-0814.ts [--date 2026-08-14] [--save]
// --save 는 g1a_days 해당 행의 t2.e_shadow.mt 에 소급 병기한다 (기록 전용 — 판정·라벨 무접촉).

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
try {
  for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* .env 없으면 DB 조회분만 결측 */ }

const DATE = process.argv[process.argv.indexOf("--date") + 1]?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? "2026-08-14";
const SAVE = process.argv.includes("--save");
const NAME: Record<string, string> = { "005930": "삼성전자", "000660": "하이닉스", KOSPI200: "코스피200" };

async function main() {
  const { loadMtUniverse } = await import("../lib/mt/service");
  const { computeMtSeries } = await import("../lib/mt/engine");
  const { mtEShadowFromDay } = await import("../lib/mt/eshadow");
  const { mtOneLine } = await import("../lib/mt/report");
  type Bar = import("../lib/mt/types").Bar;

  const u = await loadMtUniverse(400);
  const closeMap = (b: Bar[]) => new Map(b.map((x) => [x.date, x.close]));
  const out: string[] = [];
  const say = (s = "") => { console.log(s); out.push(s); };

  // 그날 T2 방향 (g1a_days) — 없으면 방향 없음으로 병기
  const t2dir = new Map<string, "UP" | "DOWN" | null>();
  const t2info = new Map<string, string>();
  try {
    const { createAdminClient } = await import("../lib/supabase/admin");
    const { data } = await createAdminClient().from("g1a_days").select("symbol,t2").eq("date", DATE);
    for (const r of (data ?? []) as { symbol: string; t2: { verdict?: { direction?: string; gap_score?: number; abstain_reason?: string | null } } | null }[]) {
      const v = r.t2?.verdict;
      const gs = v?.gap_score ?? null;
      t2dir.set(r.symbol, v?.direction === "UP" || v?.direction === "DOWN" ? v.direction
        : gs != null ? (gs >= 0.5 ? "UP" : gs <= -0.5 ? "DOWN" : null) : null);
      t2info.set(r.symbol, `GapScore ${gs ?? "—"} · ${v?.abstain_reason ?? "보류 없음"}`);
    }
  } catch { /* DB 없이도 MT 재구성분은 나온다 */ }

  say(`# E-섀도 MT 조건 병기 — ${DATE} 밤 소급 표본`);
  say(`- 발주서 §5 사다리 2단계 산출물. **기록 전용**: 백필 ⓓ 관문이 아직 미통과라(docs/mt-backfill-60d.md) 정식 섀도 진입이 아니라 표본 축적이다.`);
  say(`- 엔진·데이터는 라이브와 동일 경로 (lib/mt) — 재구성값과 라이브값이 갈리지 않는다.`);
  say();

  for (const symbol of ["005930", "000660", "KOSPI200"] as const) {
    const bars = u.bars[symbol];
    const i = bars.findIndex((b) => b.date === DATE);
    if (i < 0) { say(`## ${NAME[symbol]}: ${DATE} 거래일 아님`); continue; }
    const series = computeMtSeries(symbol, bars, Math.max(80, i - 30), {
      c1: { soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate },
      indexCloseByDate: symbol === "KOSPI200" ? undefined : closeMap(u.bars.KOSPI200),
      leaderCloseByDate: symbol === "KOSPI200" ? [closeMap(u.bars["005930"]), closeMap(u.bars["000660"])] : undefined,
      breadth: null, flow: null, mode: "backfill",
    });
    const day = series.find((d) => d.date === DATE)!;
    const dir = t2dir.get(symbol) ?? null;
    const e = mtEShadowFromDay(day, dir);
    say(`## ${NAME[symbol]}`);
    say(`- MT 줄: ${mtOneLine(day)}`);
    say(`- T2: ${t2info.get(symbol) ?? "판정 없음(로그 미보유)"} → 방향 ${dir ?? "없음"}`);
    say(`- **E-섀도 MT 병기**: 일치 ${e.agree == null ? "판정 불가" : e.agree ? "○" : "✗"} · 강도 ${e.strong ? "○" : "✗"}(|MT| ${Math.abs(e.mt).toFixed(2)}) · 국면 정합 ${e.phase_aligned ? "○" : "✗"} → **${e.e_low_by_mt ? "E-Low 요건 충족(가상)" : "요건 미충족"}**`);
    say(`  - ${e.note}`);
    // 8/14는 금요일 — F-Low 설계안(docs/mt-flow-design.md §2)이 발효돼 있었다면 어떻게 됐을지 병기 (가정 판정)
    if (new Date(DATE + "T00:00:00Z").getUTCDay() === 5 && symbol !== "KOSPI200") {
      const info = t2info.get(symbol) ?? "";
      const onlyFriday = info.includes("보류2 금요일");
      say(`- **F-Low 가정 판정** (설계 문서 §2 — 미등록·미발효): 금요일 ○ · 다른 보류 ${onlyFriday ? "없음 ○" : "있음 ✗"} · MT 순방향 ${e.agree ? "○" : "✗"} · |MT| ≥ 0.5 ${e.strong ? "○" : "✗"} · 국면 정합 ${e.phase_aligned ? "○" : "✗"} → **${onlyFriday && e.agree && e.strong && e.phase_aligned ? "발동했을 밤 (1/12 가상)" : "미발동"}**`);
    }
    say();

    if (SAVE && symbol !== "KOSPI200") {
      try {
        const { createAdminClient } = await import("../lib/supabase/admin");
        const admin = createAdminClient();
        const { data } = await admin.from("g1a_days").select("t2").eq("date", DATE).eq("symbol", symbol).maybeSingle();
        const t2 = (data?.t2 ?? null) as Record<string, unknown> | null;
        if (!t2) { say(`  - 저장 생략: ${DATE} ${symbol} g1a_days 행 없음`); continue; }
        const es = (t2.e_shadow ?? {}) as Record<string, unknown>;
        t2.e_shadow = { ...es, mt: e, retrospective: true };
        const { error } = await admin.from("g1a_days").update({ t2, updated_at: new Date().toISOString() }).eq("date", DATE).eq("symbol", symbol);
        say(`  - 저장: ${error ? `실패 ${error.message}` : "g1a_days.t2.e_shadow.mt 소급 병기 완료 (retrospective=true)"}`);
      } catch (err) { say(`  - 저장 실패: ${(err as Error).message}`); }
    }
  }

  writeFileSync(resolve(process.cwd(), "docs/mt-eshadow-0814.md"), out.join("\n") + "\n", "utf8");
  console.log("\n→ docs/mt-eshadow-0814.md 기록");
}
main();
