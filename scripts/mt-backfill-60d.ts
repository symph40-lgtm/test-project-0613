// MT 60일 백필 + §4.1 첫 보고 ⓐ~ⓓ — 발주서 WORKORDER_MT_v04 §4.1 / 스펙 §5.1
//   npx tsx scripts/mt-backfill-60d.ts [--save] [--days 60]
// 두 벌 산출 (발주자 보충 조건 ①): 전체(A+B+C) / A+B만.
// 저장은 --save 일 때만 (마이그레이션 037 적용 후). 미적용이어도 보고서는 나온다.

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
try {
  for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* 시세 경로는 .env 없이도 동작 */ }

const DAYS = Number(process.argv.find((a) => a.startsWith("--days"))?.split("=")[1] ?? process.argv[process.argv.indexOf("--days") + 1]) || 60;
const SAVE = process.argv.includes("--save");
const SYMS = ["005930", "000660", "KOSPI200"] as const;
const NAME: Record<string, string> = { "005930": "삼성전자", "000660": "하이닉스", KOSPI200: "코스피200" };
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

async function main() {
  const { loadMtUniverse } = await import("../lib/mt/service");
  const { computeMtDay, labelDirection } = await import("../lib/mt/engine");
  const { c1Series, c1ForDay, gradeMix } = await import("../lib/mt/c1");
  const { ftdAtDay } = await import("../lib/mt/panels");
  const { computeBox } = await import("../lib/mt/phase");
  const { mtOneLine } = await import("../lib/mt/report");
  const { MT_CONFIG } = await import("../lib/mt/config");
  type MtDay = import("../lib/mt/types").MtDay;
  type Bar = import("../lib/mt/types").Bar;

  const u = await loadMtUniverse(400);
  const closeMap = (bars: Bar[]) => new Map(bars.map((b) => [b.date, b.close]));
  const out: string[] = [];
  const say = (s = "") => { console.log(s); out.push(s); };

  const full: Record<string, MtDay[]> = {};
  const ab: Record<string, MtDay[]> = {};

  for (const symbol of SYMS) {
    const bars = u.bars[symbol];
    const from = Math.max(80, bars.length - DAYS);
    const mk = (allowGrades: ("A" | "B" | "C")[]) => {
      const days: MtDay[] = [];
      for (let i = from; i < bars.length; i++) {
        days.push(computeMtDay(symbol, bars, i, {
          c1: { soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate, allowGrades },
          indexCloseByDate: symbol === "KOSPI200" ? undefined : closeMap(u.bars.KOSPI200),
          leaderCloseByDate: symbol === "KOSPI200" ? [closeMap(u.bars["005930"]), closeMap(u.bars["000660"])] : undefined,
          breadth: null, flow: null, mode: "backfill",
        }));
      }
      return days;
    };
    full[symbol] = mk(["A", "B", "C"]);
    ab[symbol] = mk(["A", "B"]);
    // 방향 라벨 소급
    for (const d of full[symbol]) {
      const i = bars.findIndex((b) => b.date === d.date);
      d.labels = { dir5d: labelDirection(bars, i, d.tone.mt), gate: null, resilience: null };
    }
  }

  say(`# MT 60일 백필 보고 (§4.1)`);
  say(`- 산출: ${new Date().toISOString().slice(0, 10)} · 구간 ${full["005930"][0].date} ~ ${full["005930"][full["005930"].length - 1].date} (${full["005930"].length} 거래일)`);
  say(`- 엔진 ${MT_CONFIG ? full["005930"][0].meta.engine_ver : ""} · 두 벌 산출: 전체(A+B+C) / A+B만`);
  say();

  // ── 등급 구성비 (발주자 보충 조건 ③)
  say(`## 0. C1 등급 구성비`);
  say(`| 대상 | A | B | C | 미분류 |`);
  say(`|---|---|---|---|---|`);
  for (const s of SYMS) {
    const bars = u.bars[s];
    const mix = gradeMix(c1Series(bars, bars.length - 1, DAYS, s, { soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate }));
    say(`| ${NAME[s]} | ${mix.A}% | ${mix.B}% | ${mix.C}% | ${mix.none}% |`);
  }
  say();

  // ── B-C 일치율 (조건 ② — A 표본 0이므로 대리 보고)
  say(`## 0-1. 등급 교차 일치율 (조건 ②)`);
  let aN = 0, bN = 0, bcAgree = 0;
  const ratioPairs: [number, number][] = [];
  for (const s of SYMS) {
    const bars = u.bars[s];
    for (let i = Math.max(80, bars.length - DAYS); i < bars.length; i++) {
      const ctxAll = { soxByDate: u.soxByDate, causeTextByDate: u.causeTextByDate };
      const b = c1ForDay(bars, i, s, { ...ctxAll, allowGrades: ["A", "B"] });
      const c = c1ForDay(bars, i, s, { ...ctxAll, allowGrades: ["C"] });
      if (b.grade === "A") aN++;
      if (b.grade !== "B" || c.grade !== "C") continue;
      bN++;
      if (b.materialDir === c.materialDir) bcAgree++;
      if (b.ratio != null && c.ratio != null) ratioPairs.push([b.ratio, c.ratio]);
    }
  }
  const corr = (() => {
    if (ratioPairs.length < 3) return null;
    const xs = ratioPairs.map((p) => p[0]), ys = ratioPairs.map((p) => p[1]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let n = 0, dx = 0, dy = 0;
    xs.forEach((x, k) => { n += (x - mx) * (ys[k] - my); dx += (x - mx) ** 2; dy += (ys[k] - my) ** 2; });
    return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : null;
  })();
  say(`- A등급(컨센서스) 표본 **${aN}일** → A-C 일치율 산출 대기 (컨센서스 미입력 — 입력 즉시 자동 산출)`);
  say(`- **B-C 일치율 (대리)**: 재료 방향 일치 ${bcAgree}/${bN} = **${bN ? Math.round((bcAgree / bN) * 100) : 0}%** · 배율 상관 ${corr == null ? "—" : corr.toFixed(2)} (n=${ratioPairs.length})`);
  say();

  // ── ⓐ 7/31 전후 MT 부호 전환
  say(`## ⓐ 7/31 전후 MT 부호 전환 (발주자 가설 검증 1호)`);
  say(`| 일자 | ${SYMS.map((s) => NAME[s]).join(" | ")} |`);
  say(`|---|---|---|---|`);
  const window = full["005930"].filter((d) => d.date >= "2026-07-24" && d.date <= "2026-08-07").map((d) => d.date);
  for (const date of window) {
    const cells = SYMS.map((s) => {
      const d = full[s].find((x) => x.date === date);
      return d ? `${d.tone.mt >= 0 ? "+" : ""}${d.tone.mt.toFixed(2)} (${d.phase.top})` : "—";
    });
    say(`| ${date.slice(5)} | ${cells.join(" | ")} |`);
  }
  for (const s of SYMS) {
    const seq = full[s].filter((d) => d.date >= "2026-07-24" && d.date <= "2026-08-07");
    const flips = seq.filter((d, k) => k > 0 && Math.sign(d.tone.mt) !== Math.sign(seq[k - 1].tone.mt) && d.tone.mt !== 0);
    say(`- ${NAME[s]}: 부호 전환 ${flips.length}회 ${flips.map((f) => `${f.date.slice(5)}(→${f.tone.mt >= 0 ? "+" : "−"})`).join(" ") || "— 없음"}`);
  }
  say();

  // ── ⓑ 7/29·31 FTD 판정
  say(`## ⓑ 7/29·7/31 대량거래일의 확인일(FTD) 판정`);
  for (const s of SYMS) {
    const bars = u.bars[s];
    for (const date of ["2026-07-29", "2026-07-31"]) {
      const i = bars.findIndex((b) => b.date === date);
      if (i < 0) { say(`- ${NAME[s]} ${date}: 거래일 아님`); continue; }
      const r = ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100;
      const vol20 = bars.slice(i - 20, i).reduce((a, b) => a + b.volume, 0) / 20;
      const { hit, nearestLow } = ftdAtDay(bars, i);
      say(`- **${NAME[s]} ${date}**: 등락 ${pct(r)} · 거래량 ${(bars[i].volume / vol20).toFixed(2)}×20일평균 · 전일대비 ${bars[i].volume > bars[i - 1].volume ? "증가" : "감소"}`);
      say(`  - **그날 자체의 확인일 판정: ${hit ? (hit.strong ? "성립(대량 확인)" : "부분 충족") : "불성립"}**` +
        (hit ? ` — ${hit.lowDate} 바닥 시도 +${hit.day}일차` :
          nearestLow ? ` — 직전 바닥 시도 ${nearestLow.date}의 **+${nearestLow.dayDiff}일차**라 O'Neil 4~7일차 창 ${nearestLow.dayDiff < 4 ? "이전" : "이후"} (확인일 조건 자체가 열리지 않음)`
            : " — 탐색 범위(40일) 안에 20일 신저가(바닥 시도)가 없음"));
      const d = full[s].find((x) => x.date === date);
      const s13 = d?.panels.S1.parts.find((p) => p.key === "S1_3");
      say(`  - 그날 S1③ 부품값: ${s13?.fill ?? "—"} — ${s13?.detail ?? "—"}`);
    }
  }
  say();

  // ── ⓒ 박스 상·하단
  say(`## ⓒ 횡보 박스 자동 산출값 (최신일 ${full["005930"][full["005930"].length - 1].date} 기준)`);
  say(`| 대상 | 20일 박스 | 폭 | 유효 | 60일 박스 | 폭 | 유효 | 채택 | 위치 |`);
  say(`|---|---|---|---|---|---|---|---|---|`);
  for (const s of SYMS) {
    const bars = u.bars[s];
    const b = computeBox(bars, bars.length - 1);
    const f = (x: number) => Math.round(x).toLocaleString();
    say(`| ${NAME[s]} | ${f(b.n20.low)}~${f(b.n20.high)} | ${b.n20.widthPct}% | ${b.n20.valid ? "✓" : "✗"} | ${f(b.n60.low)}~${f(b.n60.high)} | ${b.n60.widthPct}% | ${b.n60.valid ? "✓" : "✗"} | ${b.primary ?? "없음(추세)"} | ${b.positionPct ?? "—"}% |`);
  }
  const validRate = SYMS.map((s) => {
    const bars = u.bars[s];
    let v = 0, n = 0;
    for (let i = Math.max(80, bars.length - DAYS); i < bars.length; i++) { n++; if (computeBox(bars, i).primary) v++; }
    return `${NAME[s]} ${Math.round((v / n) * 100)}%`;
  });
  say(`- 60일 중 박스 유효 비율: ${validRate.join(" · ")} — 무효일은 §3.3대로 20일 고·저가로 가격 확인 대체`);
  say();

  // ── ⓓ 관문
  say(`## ⓓ 관문 — "MT 일치 밤 적중률 > 충돌 밤"`);
  // ⓓ-1 정의 그대로: G1A T2 방향과의 일치/충돌
  const g1a = new Map<string, { dir: string | null; L1: number | null }>();
  try {
    const { createAdminClient } = await import("../lib/supabase/admin");
    const { data } = await createAdminClient().from("g1a_days").select("date,symbol,t2,labels").order("date", { ascending: false }).limit(200);
    for (const r of (data ?? []) as { date: string; symbol: string; t2: { verdict?: { direction?: string; gap_score?: number } } | null; labels: { L1?: number | null } | null }[]) {
      const v = r.t2?.verdict;
      const dir = v?.direction && v.direction !== "NEUTRAL" ? v.direction
        : v?.gap_score != null ? (v.gap_score >= 0.5 ? "UP" : v.gap_score <= -0.5 ? "DOWN" : null) : null;
      g1a.set(`${r.date}|${r.symbol}`, { dir, L1: r.labels?.L1 ?? null });
    }
  } catch { /* DB 없이 실행 시 ⓓ-1 생략 */ }

  const gateTable = (days: Record<string, MtDay[]>, tag: string) => {
    let agN = 0, agHit = 0, cfN = 0, cfHit = 0;
    for (const s of ["005930", "000660"] as const) {
      for (const d of days[s]) {
        const g = g1a.get(`${d.date}|${s}`);
        if (!g?.dir || g.L1 == null) continue;
        const mtSign = d.tone.mt > 0.02 ? 1 : d.tone.mt < -0.02 ? -1 : 0;
        if (!mtSign) continue;
        const agree = (g.dir === "UP") === (mtSign > 0);
        const hit = Math.abs(g.L1) < 0.3 ? null : (g.dir === "UP" ? g.L1 > 0 : g.L1 < 0);
        if (hit == null) continue;
        if (agree) { agN++; if (hit) agHit++; } else { cfN++; if (hit) cfHit++; }
      }
    }
    const r = (h: number, n: number) => (n ? `${Math.round((h / n) * 100)}% (${h}/${n})` : "표본 0");
    // 최소 표본 규약: 일치·충돌 각 10밤 미만이면 방향이 맞아도 "판정 불가"로 쓴다 (우연 배제 불가)
    const MIN_N = 10;
    const verdict = agN < MIN_N || cfN < MIN_N
      ? `**판정 불가 (표본 부족 — 각 ${MIN_N}밤 필요, 현재 ${agN}·${cfN})**`
      : agHit / agN > cfHit / cfN ? "**성립**" : "미성립";
    say(`- **${tag}** 일치 밤 ${r(agHit, agN)} vs 충돌 밤 ${r(cfHit, cfN)} → ${verdict}`);
    return { agN, cfN };
  };
  say(`### ⓓ-1 정의 그대로 (G1A T2 방향 대비) — g1a_days 보유 밤만`);
  const n1 = gateTable(full, "전체(A+B+C)");
  gateTable(ab, "A+B만");
  say(`  - ⚠ G1A는 2026-08-05부터 가동 — 60일 구간 대부분에 T2 판정이 없다 (사용 가능 밤 일치 ${n1.agN} + 충돌 ${n1.cfN}).`);

  // ⓓ-2 대리: MT 부호 vs 실제 익일 갭 (60일 전 구간)
  say(`### ⓓ-2 대리 지표 (MT 부호 vs 실제 익일 갭) — 60일 전 구간`);
  const gapTable = (days: Record<string, MtDay[]>, tag: string) => {
    const rows: string[] = [];
    for (const s of SYMS) {
      const bars = u.bars[s];
      let upN = 0, upHit = 0, dnN = 0, dnHit = 0;
      for (const d of days[s]) {
        const i = bars.findIndex((b) => b.date === d.date);
        if (i < 0 || i + 1 >= bars.length) continue;
        const gap = ((bars[i + 1].open - bars[i].close) / bars[i].close) * 100;
        if (Math.abs(gap) < 0.3) continue;                    // G1A flatBand 준용
        const sign = d.tone.mt > 0.02 ? 1 : d.tone.mt < -0.02 ? -1 : 0;
        if (!sign) continue;
        if (sign > 0) { upN++; if (gap > 0) upHit++; } else { dnN++; if (gap < 0) dnHit++; }
      }
      const r = (h: number, n: number) => (n ? `${Math.round((h / n) * 100)}% (${h}/${n})` : "표본 0");
      rows.push(`| ${NAME[s]} | ${r(upHit, upN)} | ${r(dnHit, dnN)} |`);
    }
    say(`**${tag}**`);
    say(`| 대상 | MT>0 밤 갭상승 적중 | MT<0 밤 갭하락 적중 |`);
    say(`|---|---|---|`);
    rows.forEach(say);
  };
  gapTable(full, "전체(A+B+C)");
  gapTable(ab, "A+B만");
  say();

  // ── 방향 라벨(5일) 요약
  say(`## 부가 — 방향 라벨 (MT 부호 vs 이후 5거래일)`);
  for (const s of SYMS) {
    const ls = full[s].map((d) => d.labels?.dir5d).filter((x): x is NonNullable<typeof x> => !!x && x.hit != null);
    const hit = ls.filter((x) => x.hit).length;
    say(`- ${NAME[s]}: ${ls.length}일 채점 · 적중 ${hit} = ${ls.length ? Math.round((hit / ls.length) * 100) : 0}%`);
  }
  say();
  say(`## 최신일 카드 줄`);
  for (const s of SYMS) say(`- ${mtOneLine(full[s][full[s].length - 1])}`);

  // ── 종합 판정 (관문) + 발주자 결정 요청
  say();
  say(`## 종합 — 2단계 진입 관문 판정`);
  let posN = 0, posHit = 0, negN = 0, negHit = 0;
  for (const s of SYMS) {
    const bars = u.bars[s];
    for (const d of full[s]) {
      const i = bars.findIndex((b) => b.date === d.date);
      if (i < 0 || i + 1 >= bars.length) continue;
      const gap = ((bars[i + 1].open - bars[i].close) / bars[i].close) * 100;
      if (Math.abs(gap) < 0.3) continue;
      const sign = d.tone.mt > 0.02 ? 1 : d.tone.mt < -0.02 ? -1 : 0;
      if (sign > 0) { posN++; if (gap > 0) posHit++; } else if (sign < 0) { negN++; if (gap < 0) negHit++; }
    }
  }
  const baseUp = (() => {   // 기준선: 그냥 "항상 갭상승"으로 찍었을 때의 적중률 (상승장 편향 보정용)
    let n = 0, h = 0;
    for (const s of SYMS) {
      const bars = u.bars[s];
      for (const d of full[s]) {
        const i = bars.findIndex((b) => b.date === d.date);
        if (i < 0 || i + 1 >= bars.length) continue;
        const gap = ((bars[i + 1].open - bars[i].close) / bars[i].close) * 100;
        if (Math.abs(gap) < 0.3) continue;
        n++; if (gap > 0) h++;
      }
    }
    return { n, h, rate: n ? h / n : 0 };
  })();
  say(`- ⓓ-1 (정의 그대로): **판정 불가** — G1A 가동일(2026-08-05) 이후 밤만 존재해 표본이 각 3밤.`);
  say(`- ⓓ-2 (대리, 3종목 합산): MT>0 밤 갭상승 ${posN ? Math.round((posHit / posN) * 100) : 0}% (${posHit}/${posN}) · MT<0 밤 갭하락 ${negN ? Math.round((negHit / negN) * 100) : 0}% (${negHit}/${negN})`);
  say(`- 기준선(무조건 갭상승 베팅): ${Math.round(baseUp.rate * 100)}% (${baseUp.h}/${baseUp.n}) — 구간이 강한 상승장이라 **상방 편향이 크다**`);
  const edgeUp = posN ? posHit / posN - baseUp.rate : 0;
  const edgeDn = negN ? negHit / negN - (1 - baseUp.rate) : 0;
  say(`- 기준선 대비 초과: MT>0 ${(edgeUp * 100).toFixed(1)}%p · MT<0 ${(edgeDn * 100).toFixed(1)}%p`);
  say(`- **관문 판정: 미통과(보류)** — ⓓ-1은 표본 부족으로 판정 불가, ⓓ-2는 기준선 대비 초과분이 ${Math.abs(edgeUp * 100) < 5 && Math.abs(edgeDn * 100) < 5 ? "±5%p 이내로 미미" : "존재하나 표본·편향 보정 전"}. 사다리 2단계(섀도) 진입은 **표본 축적 후 재심사**.`);
  say();
  say(`## 발주자 결정 요청 (백필이 드러낸 것)`);
  say(`1. **박스 유효율 0%** — 20일 폭이 삼전 31.6%·하닉 46.2%·K200 29.6%로, 스펙 §3.3의 고정 문턱(20일 ≤15%·60일 ≤30%)이 이 변동성 국면에서 영구 무효다. 전 구간 "박스 없음(추세)"으로 §1.4 가격 확인이 항상 20일 고·저가 대체로 돌아간다. 대안: **폭 문턱을 변동성 상대값으로**(예: 20일 폭 ≤ 2.5 × RV20의 20일 환산) 바꾸는 안 — 등록 상수 변경이라 승인 필요.`);
  say(`2. **C1 등급 C 의존 80%** — B-C 방향 일치율 67%·배율 상관 0.89. 등급 C 신뢰도의 1차 근거는 확보했으나 A 표본은 0이다. 컨센서스 입력 경로(수동)를 언제 열지 결정 필요.`);
  say(`3. **ⓓ 관문 표본** — 정의 그대로의 ⓓ는 G1A T2 판정 밤이 쌓여야 한다(현재 6밤). 관문 재심사 시점을 "T2 판정 밤 각 10밤 확보 시"로 두는 안.`);

  // 저장
  if (SAVE) {
    try {
      const { mtTablesReady, upsertMtDays } = await import("../lib/mt/store");
      if (await mtTablesReady()) {
        let n = 0;
        for (const s of SYMS) n += await upsertMtDays(full[s]);
        say(`\n저장: mt_days ${n}행 (전체 벌 — meta.mode=backfill)`);
      } else say(`\n저장 생략: 마이그레이션 037 미적용`);
    } catch (e) { say(`\n저장 실패: ${(e as Error).message}`); }
  }

  writeFileSync(resolve(process.cwd(), "docs/mt-backfill-60d.md"), out.join("\n") + "\n", "utf8");
  console.log("\n→ docs/mt-backfill-60d.md 기록");
}
main();
