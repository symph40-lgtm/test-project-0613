// MT 부품 반쪽 안정성 진단 — 발주자 승인 2026-08-16 (규칙 변경 아님·재설계 쿼터 미소모).
//   npx tsx scripts/mt-stability.ts
// 전/후반 1.5년 분할로 부품별 lift 순위 일관성 채점 (부검 MT_AUTOPSY.md 제2부와 동일 채점기: ±10일 창·무작위 기준선·지그재그 3벌).
// 사전 등록 판정: 양쪽 일관 lift>1 = 강건 유지 / 한쪽만 = 0.25표 추가 강등 상신 / 양쪽 미달 = 기존 강등 확인.
// ⚠ 이것은 홀드아웃 검증이 아니다 (전 구간 성적 기지득 — "분리는 채점 전에만 유효하다"). 기존 판정의 강건성 확인일 뿐이다.

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
try {
  for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* 시세 경로는 .env 없이도 동작 */ }

const SYMS = ["005930", "000660", "KOSPI200"] as const;
const ZZS = [15, 20, 25];
const EVENT_MATCH = 10;
const MIN_FIRES = 10;
const PART_KEYS = ["S1_1", "S1_2", "S1_3", "S1_4", "S2_1", "S2_2", "S2_3", "S2_4", "S3_1", "S3_2", "S3_3", "S3_4", "S4_1", "S4_2", "S4_3"];

type Pivot = { idx: number; kind: "trough" | "peak" };
function zigzag(closes: number[], thPct: number): Pivot[] {
  const out: Pivot[] = [];
  let dir: "up" | "down" | null = null, ext = 0;
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i], e = closes[ext], chg = ((c - e) / e) * 100;
    if (dir === null) { if (Math.abs(chg) >= thPct) { dir = chg > 0 ? "up" : "down"; out.push({ idx: ext, kind: chg > 0 ? "trough" : "peak" }); ext = i; } continue; }
    if (dir === "up") { if (c > e) ext = i; else if (((c - closes[ext]) / closes[ext]) * 100 <= -thPct) { out.push({ idx: ext, kind: "peak" }); dir = "down"; ext = i; } }
    else { if (c < e) ext = i; else if (((c - closes[ext]) / closes[ext]) * 100 >= thPct) { out.push({ idx: ext, kind: "trough" }); dir = "up"; ext = i; } }
  }
  return out;
}

async function main() {
  const { fetchMtBars, fetchSoxByDate, fetchCauseTextByDate } = await import("../lib/mt/data");
  const { computeMtDay } = await import("../lib/mt/engine");
  const { PART_NAMES, MT_CONFIG, MT_ENGINE_VER } = await import("../lib/mt/config");
  type Bar = import("../lib/mt/types").Bar;
  type MtDay = import("../lib/mt/types").MtDay;
  type PhaseKey = import("../lib/mt/types").PhaseKey;

  const bars: Record<string, Bar[]> = {};
  for (const s of SYMS) bars[s] = await fetchMtBars(s, 800);
  const dates = [...new Set(SYMS.flatMap((s) => bars[s].map((b) => b.date)))].sort();
  const soxByDate = await fetchSoxByDate(dates, dates[0]);
  const causeTextByDate = await fetchCauseTextByDate();
  const closeMap = (b: Bar[]) => new Map(b.map((x) => [x.date, x.close]));

  const days: Record<string, MtDay[]> = {};
  const pivots: Record<string, Record<number, Pivot[]>> = {};
  for (const s of SYMS) {
    const b = bars[s];
    days[s] = [];
    for (let i = 80; i < b.length; i++) {
      days[s].push(computeMtDay(s, b, i, {
        c1: { soxByDate, causeTextByDate },
        indexCloseByDate: s === "KOSPI200" ? undefined : closeMap(bars.KOSPI200),
        leaderCloseByDate: s === "KOSPI200" ? [closeMap(bars["005930"]), closeMap(bars["000660"])] : undefined,
        breadth: null, flow: null, mode: "retro",
      }));
    }
    pivots[s] = {};
    for (const z of ZZS) pivots[s][z] = zigzag(b.map((x) => x.close), z).filter((p) => p.idx >= 80);
  }
  // 분할점: 전 구간(80~끝)의 중앙 인덱스 — 3종목 공통 날짜 기준
  const n = bars["005930"].length;
  const midIdx = Math.floor((80 + n) / 2);
  const midDate = bars["005930"][midIdx].date;

  const liftOf = (pk: string, z: number, half: "front" | "back"): { lift: number | null; fires: number } => {
    const panel = pk.slice(0, 2) as PhaseKey;
    const target: "trough" | "peak" | "uptrend" = panel === "S3" ? "peak" : panel === "S2" ? "uptrend" : "trough";
    let fires = 0, hits = 0, avail = 0, nullHits = 0;
    for (const s of SYMS) {
      const b = bars[s];
      const idxOf = new Map(b.map((x, k) => [x.date, k]));
      const pv = pivots[s][z];
      const segs: { a: number; b: number }[] = [];
      for (let k = 0; k + 1 < pv.length; k++) if (pv[k].kind === "trough") segs.push({ a: pv[k].idx, b: pv[k + 1].idx });
      const inT = (i: number) => target === "uptrend" ? segs.some((g) => i >= g.a && i <= g.b) : pv.some((q) => q.kind === target && Math.abs(q.idx - i) <= EVENT_MATCH);
      for (const d of days[s]) {
        const inHalf = half === "front" ? d.date < midDate : d.date >= midDate;
        if (!inHalf) continue;
        const p = d.panels[panel].parts.find((x) => x.key === pk);
        if (!p?.available) continue;
        avail++;
        const i = idxOf.get(d.date)!;
        if (inT(i)) nullHits++;
        if ((p.fill ?? 0) >= 0.6) { fires++; if (inT(i)) hits++; }
      }
    }
    const hr = fires ? hits / fires : null, nr = avail ? nullHits / avail : null;
    return { lift: hr != null && nr ? hr / nr : null, fires };
  };

  const out: string[] = [];
  const say = (t = "") => { console.log(t); out.push(t); };
  say(`# MT 부품 반쪽 안정성표 (발주자 승인 2026-08-16 — 규칙 변경 아님·재설계 쿼터 미소모)`);
  say();
  say(`- 엔진 ${MT_ENGINE_VER} · 구간 ${bars["005930"][80].date}~${bars["005930"][n - 1].date} · 분할점 **${midDate}** (전반 ${midIdx - 80}일 / 후반 ${n - midIdx}일)`);
  say(`- 채점기 = 부검 제2부와 동일 (±${EVENT_MATCH}일 창 · 무작위 기준선 대비 lift · 지그재그 15/20/25% 3벌). 발화 ${MIN_FIRES} 미만인 반쪽은 "판정 불가".`);
  say(`- **사전 등록 판정**: 양쪽 3벌 일관 lift>1 → 강건 유지 / 한쪽만 lift>1 → **0.25표 추가 강등 상신** / 양쪽 미달 → 기존 강등 확인.`);
  say(`- ⚠ 홀드아웃 검증이 아니다 ("분리는 채점 전에만 유효하다"). 이미 확정된 강등 판정이 반쪽에서도 서는지 보는 강건성 확인.`);
  say();
  say(`| 부품 | 현 상태 | 전반 lift (15/20/25) | 후반 lift (15/20/25) | 전반 | 후반 | 판정 | 상신 |`);
  say(`|---|---|---|---|---|---|---|---|`);
  const AP = MT_CONFIG.approved;
  const summary: Record<string, number> = { 강건: 0, 한쪽: 0, 미달: 0, 불가: 0 };
  const submissions: string[] = [];
  for (const pk of PART_KEYS) {
    const f = ZZS.map((z) => liftOf(pk, z, "front"));
    const bk = ZZS.map((z) => liftOf(pk, z, "back"));
    const fmt = (arr: { lift: number | null; fires: number }[]) => arr.map((x) => (x.fires < MIN_FIRES ? `—(n=${x.fires})` : x.lift == null ? "—" : x.lift.toFixed(2))).join(" / ");
    const okSide = (arr: { lift: number | null; fires: number }[]) =>
      arr.every((x) => x.fires >= MIN_FIRES) ? (arr.every((x) => (x.lift ?? 0) > 1.0) ? "○" : "✗") : "판정 불가";
    const fs = okSide(f), bs = okSide(bk);
    const wolf = (AP.wolfParts as readonly string[]).includes(pk);
    const state = wolf ? "늑대소년(0.5표)" : "1표";
    let verdict: string, sub: string;
    if (fs === "판정 불가" || bs === "판정 불가") { verdict = "**판정 불가** (반쪽 표본 부족)"; sub = "—"; summary.불가++; }
    else if (fs === "○" && bs === "○") { verdict = "**강건 유지**"; sub = wolf ? "강등 재심 후보 (양쪽 lift>1인데 늑대소년 — 발주자 확인)" : "유지"; summary.강건++; }
    else if (fs === "○" || bs === "○") { verdict = "**한쪽만**"; sub = `**0.25표 추가 강등 상신** (${wolf ? "0.5→0.25" : "1→0.75"})`; summary.한쪽++; submissions.push(`${pk} ${PART_NAMES[pk]}: ${wolf ? "0.5→0.25표" : "1→0.75표"}`); }
    else { verdict = "양쪽 미달"; sub = wolf ? "기존 강등 확인" : "**신규 강등 후보** (양쪽 lift<1인데 1표 — 발주자 확인)"; summary.미달++; if (!wolf) submissions.push(`${pk} ${PART_NAMES[pk]}: 1표인데 양쪽 미달 — 강등 검토`); }
    say(`| ${pk} ${PART_NAMES[pk]} | ${state} | ${fmt(f)} | ${fmt(bk)} | ${fs} | ${bs} | ${verdict} | ${sub} |`);
  }
  say();
  say(`요약: 강건 ${summary.강건} · 한쪽만 ${summary.한쪽} · 양쪽 미달 ${summary.미달} · 판정 불가 ${summary.불가} (15부품)`);
  say();
  say(`## 상신 목록 (실행은 발주자 승인 후)`);
  if (submissions.length) submissions.forEach((x, i) => say(`${i + 1}. ${x}`));
  else say(`- 없음`);
  say();
  say(`## 확정 후: 부품 구성 동결 (v0.4.2 — 발주자 판정 4)`);
  say(`- 이후 개선은 **라이브 전진 검증만**. 월간 재캘리브레이션(§4.2)은 **라이브 데이터 축적분으로만** 가동 (3년 소급 표본은 IC 산출에 쓰지 않는다).`);
  writeFileSync(resolve(process.cwd(), "docs/mt-stability.md"), out.join("\n") + "\n", "utf8");
  console.log("\n→ docs/mt-stability.md 기록");
}
main();
