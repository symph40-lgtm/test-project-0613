// MT-CS 코스피200 전수 검증 — 발주 2026-08-16 (docs/mt-crosssection-prereg.md 사전 등록 → 이 스크립트).
//   npx tsx scripts/mt-crosssection.ts [--refresh]
// ⚠ **채점 전용.** v0.4.2 동결 구성 그대로 200종목 × 3년. 재튜닝 절대 금지 — 파라미터·눈금·부품 무변경.
//    이 파일은 lib/mt를 호출만 하고 MT_CONFIG를 읽지도 쓰지도 않는다 (엔진 상수는 lib/mt/config.ts 그대로).
// 데이터: 네이버 fchart 800봉 (.predict-cache/mt-cs/ 캐시) · 시총 네이버 polling · 클러스터 보정 lift · 종목군 분해.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
try {
  for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* 시세 경로는 .env 없이도 동작 */ }

const CACHE = resolve(process.cwd(), ".predict-cache/mt-cs");
const REFRESH = process.argv.includes("--refresh");
const ZZS = [15, 20, 25];
const EVENT_MATCH = 10;
const CLUSTER_DAYS = 5;
const MIN_FIRES = 10;
const MIN_BARS = 400;
const PART_KEYS = ["S1_1", "S1_2", "S1_3", "S1_4", "S2_1", "S2_2", "S2_3", "S2_4", "S3_1", "S3_2", "S3_3", "S3_4", "S4_1", "S4_2", "S4_3"];
const UNSTABLE = ["S1_2", "S1_4", "S2_1", "S3_4"];
const WOLF = ["S1_1", "S1_3", "S3_1", "S4_2", "S4_3"];
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" };

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Pivot = { idx: number; date: string; kind: "trough" | "peak" };

function zigzag(closes: { date: string; close: number }[], thPct: number): Pivot[] {
  const out: Pivot[] = [];
  let dir: "up" | "down" | null = null, ext = 0;
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i].close, e = closes[ext].close, chg = ((c - e) / e) * 100;
    if (dir === null) { if (Math.abs(chg) >= thPct) { dir = chg > 0 ? "up" : "down"; out.push({ idx: ext, date: closes[ext].date, kind: chg > 0 ? "trough" : "peak" }); ext = i; } continue; }
    if (dir === "up") { if (c > e) ext = i; else if (((c - closes[ext].close) / closes[ext].close) * 100 <= -thPct) { out.push({ idx: ext, date: closes[ext].date, kind: "peak" }); dir = "down"; ext = i; } }
    else { if (c < e) ext = i; else if (((c - closes[ext].close) / closes[ext].close) * 100 >= thPct) { out.push({ idx: ext, date: closes[ext].date, kind: "trough" }); dir = "up"; ext = i; } }
  }
  return out;
}

async function fetchConstituents(): Promise<{ code: string; name: string }[]> {
  const f = resolve(CACHE, "constituents.json");
  if (!REFRESH && existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const out: { code: string; name: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://finance.naver.com/sise/entryJongmok.naver?&page=${page}`, { headers: H, cache: "no-store" });
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    for (const m of html.matchAll(/code=(\d{6})"[^>]*>([^<]+)</g)) if (!out.some((c) => c.code === m[1])) out.push({ code: m[1], name: m[2].trim() });
  }
  writeFileSync(f, JSON.stringify(out), "utf8");
  return out;
}

async function fetchBars(code: string): Promise<Bar[]> {
  const f = resolve(CACHE, `${code}.json`);
  if (!REFRESH && existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const res = await fetch(`https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=800&requestType=0`, { headers: { ...H, Referer: "https://m.stock.naver.com/" }, cache: "no-store" });
  const xml = await res.text();
  const bars: Bar[] = [];
  for (const m of xml.matchAll(/<item data="([^"]+)"/g)) {
    const [d, o, h, l, c, v] = m[1].split("|");
    if (!/^\d{8}$/.test(d)) continue;
    const b = { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, open: +o, high: +h, low: +l, close: +c, volume: isFinite(+v) ? +v : 0 };
    if ([b.open, b.high, b.low, b.close].every((x) => isFinite(x) && x > 0)) bars.push(b);
  }
  writeFileSync(f, JSON.stringify(bars), "utf8");
  return bars;
}

async function fetchCap(code: string): Promise<number | null> {
  const f = resolve(CACHE, `cap_${code}.json`);
  if (!REFRESH && existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  try {
    const res = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, { headers: { ...H, Referer: "https://m.stock.naver.com/" }, cache: "no-store" });
    const j = (await res.json()) as { datas?: { marketValueFullRaw?: string }[] };
    const v = j.datas?.[0]?.marketValueFullRaw;
    const n = v ? Number(v) : null;
    writeFileSync(f, JSON.stringify(n), "utf8");
    return n;
  } catch { return null; }
}

const median = (xs: number[]) => { const a = xs.filter((x) => isFinite(x)).sort((p, q) => p - q); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const pct = (x: number | null, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const { fetchSoxByDate, fetchCauseTextByDate } = await import("../lib/mt/data");
  const { computeMtDay } = await import("../lib/mt/engine");
  const { PART_NAMES, MT_ENGINE_VER } = await import("../lib/mt/config");
  const { regressBeta } = await import("../lib/mt/indicators");
  type MtDay = import("../lib/mt/types").MtDay;
  type PhaseKey = import("../lib/mt/types").PhaseKey;

  const cons = await fetchConstituents();
  console.log(`구성종목 ${cons.length}`);
  const k200 = await (async () => {
    const f = resolve(CACHE, "KPI200.json");
    if (!REFRESH && existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Bar[];
    const b = await fetchBars("KPI200"); return b;
  })();
  const k200Close = new Map(k200.map((b) => [b.date, b.close]));
  const dates = k200.map((b) => b.date);
  const soxByDate = await fetchSoxByDate(dates, dates[0]);
  const causeTextByDate = await fetchCauseTextByDate();

  // ── 종목별 산출
  type Stock = { code: string; name: string; bars: Bar[]; days: MtDay[]; cap: number | null; beta: number | null; pivots: Record<number, Pivot[]> };
  const stocks: Stock[] = [];
  const excluded: string[] = [];
  let done = 0;
  for (const c of cons) {
    const bars = await fetchBars(c.code);
    if (bars.length < MIN_BARS) { excluded.push(`${c.name}(${c.code}) ${bars.length}봉`); continue; }
    const cap = await fetchCap(c.code);
    const days: MtDay[] = [];
    for (let i = 80; i < bars.length; i++) {
      days.push(computeMtDay(c.code as never, bars, i, {
        c1: { soxByDate, causeTextByDate }, indexCloseByDate: k200Close, breadth: null, flow: null, mode: "retro",
      }));
    }
    const xs: number[] = [], ys: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const k0 = k200Close.get(bars[i - 1].date), k1 = k200Close.get(bars[i].date);
      if (k0 && k1) { xs.push((k1 / k0 - 1) * 100); ys.push((bars[i].close / bars[i - 1].close - 1) * 100); }
    }
    const pivots: Record<number, Pivot[]> = {};
    for (const z of ZZS) pivots[z] = zigzag(bars.map((b) => ({ date: b.date, close: b.close })), z).filter((p) => p.idx >= 80);
    stocks.push({ code: c.code, name: c.name, bars, days, cap, beta: regressBeta(xs, ys), pivots });
    if (++done % 25 === 0) console.log(`  ${done}/${cons.length} 산출`);
  }

  // ── 클러스터 (사전 등록 §3): 같은 벌·같은 kind의 전환이 ±5거래일 안에 겹치면 종목 수와 무관하게 1 클러스터.
  //    각 전환 사건(종목×날짜)에 "그 사건이 속한 클러스터의 사건 수 k"를 매겨 기여를 1/k로 나눈다.
  //    (초판은 요약행의 클러스터 수를 고유 날짜 수로 세어 "사건 수 = 클러스터 수"로 표시됐다 — 가중치 자체는 정상이었고 요약행만 교정. 재실행 결과 히트맵·판정 동일 확인.)
  const clusterSize: Record<number, Map<string, number>> = {};   // z → "code|date|kind" → k
  const clusterStats: Record<number, { events: number; clusters: number; maxK: number }> = {};
  for (const z of ZZS) {
    const events: { code: string; date: string; kind: string; idx: number }[] = [];
    for (const s of stocks) for (const p of s.pivots[z]) events.push({ code: s.code, date: p.date, kind: p.kind, idx: dates.indexOf(p.date) });
    const m = new Map<string, number>();
    let clusters = 0, maxK = 0;
    for (const kind of ["trough", "peak"]) {
      const ev = events.filter((e) => e.kind === kind).sort((a, b) => a.idx - b.idx);
      let start = -1, bucket: typeof ev = [];
      const flush = () => { if (bucket.length) { clusters++; maxK = Math.max(maxK, bucket.length); for (const e of bucket) m.set(`${e.code}|${e.date}|${e.kind}`, bucket.length); } };
      for (const e of ev) {
        if (start < 0 || e.idx - start > CLUSTER_DAYS) { flush(); start = e.idx; bucket = [e]; }
        else bucket.push(e);
      }
      flush();
    }
    clusterSize[z] = m;
    clusterStats[z] = { events: events.length, clusters, maxK };
  }
  const clusterCount = (z: number) => clusterStats[z];

  // ── 부품 lift (종목별, 보정/무보정)
  type Lift = { raw: number | null; adj: number | null; fires: number };
  const liftOf = (s: Stock, pk: string, z: number): Lift => {
    const panel = pk.slice(0, 2) as PhaseKey;
    const target: "trough" | "peak" | "uptrend" = panel === "S3" ? "peak" : panel === "S2" ? "uptrend" : "trough";
    const pv = s.pivots[z];
    const idxOf = new Map(s.bars.map((b, k) => [b.date, k]));
    const segs: { a: number; b: number; w: number }[] = [];
    for (let k = 0; k + 1 < pv.length; k++) if (pv[k].kind === "trough") segs.push({ a: pv[k].idx, b: pv[k + 1].idx, w: 1 / (clusterSize[z].get(`${s.code}|${pv[k].date}|trough`) ?? 1) });
    // 날짜 i가 목표 창 안인가 + 그 사건의 클러스터 가중 (여러 사건이 겹치면 최대 가중)
    const hitW = (i: number): number => {
      if (target === "uptrend") { const g = segs.find((x) => i >= x.a && i <= x.b); return g ? g.w : 0; }
      let best = 0;
      for (const q of pv) if (q.kind === target && Math.abs(q.idx - i) <= EVENT_MATCH) best = Math.max(best, 1 / (clusterSize[z].get(`${s.code}|${q.date}|${q.kind}`) ?? 1));
      return best;
    };
    let fires = 0, hits = 0, avail = 0, nullHits = 0, wFires = 0, wHits = 0, wAvail = 0, wNull = 0;
    for (const d of s.days) {
      const p = d.panels[panel].parts.find((x) => x.key === pk);
      if (!p?.available) continue;
      const i = idxOf.get(d.date)!;
      const hw = hitW(i);
      const inT = hw > 0;
      // 가중: 목표 창 안 날은 클러스터 가중, 밖 날은 1 (기준선 분모도 같은 가중)
      const w = inT ? hw : 1;
      avail++; wAvail += w; if (inT) { nullHits++; wNull += w; }
      if ((p.fill ?? 0) >= 0.6) { fires++; wFires += w; if (inT) { hits++; wHits += w; } }
    }
    const raw = fires && avail && nullHits ? (hits / fires) / (nullHits / avail) : null;
    const adj = wFires && wAvail && wNull ? (wHits / wFires) / (wNull / wAvail) : null;
    return { raw, adj, fires };
  };

  const out: string[] = [];
  const say = (t = "") => { console.log(t); out.push(t); };
  say(`# MT-CS 코스피200 전수 검증 (cross-section) — 채점 전용`);
  say();
  say(`- 산출 ${new Date().toISOString().slice(0, 10)} · 엔진 **${MT_ENGINE_VER} 동결 구성 그대로** (재튜닝 없음 — 사전 등록서 docs/mt-crosssection-prereg.md)`);
  say(`- 채점기 = 부검 제2부·안정성 진단과 동일 (±${EVENT_MATCH}일 창 · 무작위 기준선 lift · 지그재그 15/20/25%)`);
  say();
  say(`## 1. 표본 회계`);
  say(`- 코스피200 구성종목 ${cons.length} (네이버 entryJongmok, ${new Date().toISOString().slice(0, 10)} 구성 — **생존 편향**: 3년 전 편입 종목이 아니라 오늘 편입 종목이다. 3년 사이 편출된 부진 종목이 빠져 있어 성적이 상향 편향될 수 있음)`);
  say(`- 채점 종목 **${stocks.length}** · 제외 ${excluded.length} (봉 < ${MIN_BARS}): ${excluded.join(", ") || "없음"}`);
  for (const z of ZZS) {
    const cc = clusterCount(z);
    say(`- 지그재그 ${z}%: 전환 사건 ${cc.events}건(종목×날짜) → **클러스터 ${cc.clusters}개** (±${CLUSTER_DAYS}일 군집 — 독립 표본 수의 상한 · 최대 군집 ${cc.maxK}종목)`);
  }
  say(`- 시총: 네이버 marketValueFullRaw (${stocks.filter((s) => s.cap != null).length}종목 확보) · β: 3년 일간수익률 ~ K200 회귀`);
  say(`- C1: 등급 C(전일밤 ^SOX × β_SOX) 전 종목 동일 적용 — 비반도체 업종에는 재료 정의가 약함. C1 파생 4부품은 투표 제외 상태(승인분), 여기서는 톤 경로 fill로 채점.`);
  say(`- C3: 일봉 CLV 20일 평균 (라이브 전용 막판 1시간 성분만 결측) · C5: 전 구간 결측 · C4: 상대강도`);
  say();

  // ── 종목군
  const capMed = median(stocks.map((s) => s.cap ?? NaN));
  const betaMed = median(stocks.map((s) => s.beta ?? NaN));
  const groups: Record<string, (s: Stock) => boolean> = {
    "전체": () => true,
    "시총 상": (s) => s.cap != null && capMed != null && s.cap >= capMed,
    "시총 중": (s) => s.cap != null && capMed != null && s.cap < capMed,
    "β 상": (s) => s.beta != null && betaMed != null && s.beta >= betaMed,
    "β 하": (s) => s.beta != null && betaMed != null && s.beta < betaMed,
    "삼전·하닉": (s) => s.code === "005930" || s.code === "000660",
    "나머지": (s) => s.code !== "005930" && s.code !== "000660",
  };

  // 부품 × 종목 lift 캐시 (z=20 주, 15·25 병기)
  const L: Record<number, Record<string, Map<string, Lift>>> = {};
  for (const z of ZZS) { L[z] = {}; for (const pk of PART_KEYS) { L[z][pk] = new Map(); for (const s of stocks) L[z][pk].set(s.code, liftOf(s, pk, z)); } }

  say(`## 2. 부품 × 종목군 lift 히트맵 (지그재그 20% · 클러스터 **보정** lift 중앙값 / 괄호 = 무보정)`);
  say(`| 부품 | ${Object.keys(groups).join(" | ")} |`);
  say(`|---|${Object.keys(groups).map(() => "---").join("|")}|`);
  for (const pk of PART_KEYS) {
    const cells = Object.values(groups).map((f) => {
      const arr = stocks.filter(f).map((s) => L[20][pk].get(s.code)!).filter((x) => x.fires >= MIN_FIRES);
      const a = median(arr.map((x) => x.adj ?? NaN)), r = median(arr.map((x) => x.raw ?? NaN));
      return a == null ? "—" : `**${a.toFixed(2)}** (${r?.toFixed(2) ?? "—"})`;
    });
    say(`| ${pk} ${PART_NAMES[pk]} | ${cells.join(" | ")} |`);
  }
  say();

  say(`## 3. 부품별 판정 (사전 등록 §4 — 보정 lift>1 종목 비율, 지그재그 20% 주 · 15/25 병기)`);
  say(`| 부품 | 현 상태 | lift>1 비율 (15/20/25) | 판정 가능 종목 | 상위 20% 집중? | **판정** |`);
  say(`|---|---|---|---|---|---|`);
  const verdicts: Record<string, string> = {};
  for (const pk of PART_KEYS) {
    const ratio = (z: number) => {
      const arr = stocks.map((s) => ({ s, l: L[z][pk].get(s.code)! })).filter((x) => x.l.fires >= MIN_FIRES && x.l.adj != null);
      return { n: arr.length, r: arr.length ? arr.filter((x) => (x.l.adj as number) > 1).length / arr.length : null, arr };
    };
    const r15 = ratio(15), r20 = ratio(20), r25 = ratio(25);
    // 종목 특이: lift>1 종목이 상위 20%(lift 순) 안에 몰리고 그 안에 삼전·하닉 포함
    const sorted = [...r20.arr].sort((a, b) => (b.l.adj as number) - (a.l.adj as number));
    const top20 = sorted.slice(0, Math.ceil(sorted.length * 0.2));
    const above = r20.arr.filter((x) => (x.l.adj as number) > 1);
    const concentrated = above.length > 0 && above.every((x) => top20.includes(x)) && top20.some((x) => x.s.code === "005930" || x.s.code === "000660");
    const state = UNSTABLE.includes(pk) ? "unstable(1표)" : WOLF.includes(pk) ? "늑대소년" : "1표";
    let v: string;
    if (r20.r == null || r20.n < 20) v = "판정 불가";
    else if (r20.r >= 0.6) v = "**보편 강건**";
    else if (r20.r < 0.4) v = "**강등 확정**";
    else if (concentrated) v = "**종목 특이**";
    else v = "중간(부분 강건)";
    verdicts[pk] = v;
    say(`| ${pk} ${PART_NAMES[pk]} | ${state} | ${pct(r15.r)} / **${pct(r20.r)}** / ${pct(r25.r)} | ${r20.n} | ${concentrated ? "예" : "아니오"} | ${v} |`);
  }
  say();

  say(`## 4. 삼전·하닉 이상치 여부 (부품별 보정 lift의 200종목 분포 내 분위, 지그재그 20%)`);
  say(`| 부품 | 삼성전자 lift (분위) | 하이닉스 lift (분위) | 200종목 중앙값 | 해석 |`);
  say(`|---|---|---|---|---|`);
  for (const pk of PART_KEYS) {
    const all = stocks.map((s) => L[20][pk].get(s.code)!).filter((x) => x.fires >= MIN_FIRES && x.adj != null).map((x) => x.adj as number).sort((a, b) => a - b);
    const q = (v: number | null) => (v == null || !all.length ? "—" : `${v.toFixed(2)} (${Math.round((all.filter((x) => x <= v).length / all.length) * 100)}p)`);
    const ss = L[20][pk].get("005930"), hx = L[20][pk].get("000660");
    const ssq = ss && ss.fires >= MIN_FIRES ? ss.adj : null, hxq = hx && hx.fires >= MIN_FIRES ? hx.adj : null;
    const med = median(all);
    const both = ssq != null && hxq != null;
    const hi = both && med != null && ssq > med && hxq > med, lo = both && med != null && ssq < med && hxq < med;
    say(`| ${pk} ${PART_NAMES[pk]} | ${q(ssq)} | ${q(hxq)} | ${med?.toFixed(2) ?? "—"} | ${!both ? "표본 부족" : hi ? "둘 다 중앙값 위 (3종목 성적이 관대했음)" : lo ? "둘 다 중앙값 아래 (3종목 성적이 가혹했음)" : "혼재"} |`);
  }
  say();

  say(`## 5. unstable 4부품 최종 판정 상신 (사전 등록 §4 별도 기준)`);
  say(`| 부품 | 전수 판정 | 상신 |`);
  say(`|---|---|---|`);
  for (const pk of UNSTABLE) {
    const v = verdicts[pk];
    const sub = v.includes("보편 강건") ? "**1표 확정 + unstable 플래그 해제**"
      : v.includes("중간") ? "1표 유지 + 플래그 유지 → 라이브 전진 검증 이송"
      : v.includes("종목 특이") ? "**0.5표 강등 상신**"
      : v.includes("강등 확정") ? "**0.5표 강등 확정 상신** (늑대소년 동급)"
      : "판정 불가 — 플래그 유지";
    say(`| ${pk} ${PART_NAMES[pk]} | ${v} | ${sub} |`);
  }
  say();
  say(`### 늑대소년·기강등 부품 중 전수에서 보편 강건이 나온 것 (자동 복권 없음 — 재심 후보 상신만)`);
  const revive = [...WOLF, "S2_2", "S2_3", "S2_4"].filter((pk) => verdicts[pk]?.includes("보편 강건"));
  say(revive.length ? revive.map((pk) => `- ${pk} ${PART_NAMES[pk]}`).join("\n") : "- 없음");
  say();

  // ── 톤 방향 200종목 분포
  say(`## 6. 톤 방향 라벨의 200종목 분포 (MT 부호 vs 이후 5거래일, |수익률|≥0.5%)`);
  const rates: { code: string; name: string; rate: number; n: number }[] = [];
  for (const s of stocks) {
    let n = 0, h = 0;
    for (const d of s.days) {
      const i = s.bars.findIndex((b) => b.date === d.date);
      if (i < 0 || i + 5 >= s.bars.length) continue;
      const r = ((s.bars[i + 5].close - s.bars[i].close) / s.bars[i].close) * 100;
      const sign = d.tone.mt > 0.02 ? 1 : d.tone.mt < -0.02 ? -1 : 0;
      if (!sign || Math.abs(r) < 0.5) continue;
      n++; if (Math.sign(r) === sign) h++;
    }
    if (n >= 100) rates.push({ code: s.code, name: s.name, rate: h / n, n });
  }
  const rs = rates.map((x) => x.rate).sort((a, b) => a - b);
  const qq = (p: number) => rs[Math.floor(rs.length * p)];
  say(`- 종목 ${rates.length} (채점 밤 ≥100) · 중앙값 **${pct(median(rs))}** · 사분위 ${pct(qq(0.25))} ~ ${pct(qq(0.75))} · 최소 ${pct(rs[0])} · 최대 ${pct(rs[rs.length - 1])}`);
  say(`- 50% 초과 종목 비율: **${pct(rs.filter((x) => x > 0.5).length / rs.length)}** · 54% 이상: ${pct(rs.filter((x) => x >= 0.54).length / rs.length)}`);
  const ss = rates.find((x) => x.code === "005930"), hx = rates.find((x) => x.code === "000660");
  say(`- 삼성전자 ${ss ? pct(ss.rate) : "—"} (${ss ? Math.round((rs.filter((x) => x <= ss.rate).length / rs.length) * 100) : "—"}p) · 하이닉스 ${hx ? pct(hx.rate) : "—"} (${hx ? Math.round((rs.filter((x) => x <= hx.rate).length / rs.length) * 100) : "—"}p)`);
  say(`- 판독: 3종목 54%는 ${median(rs) != null && Math.abs((median(rs) as number) - 0.54) <= 0.02 ? "**보편 수준**(200종목 중앙값과 ±2%p 이내)" : (median(rs) ?? 0) > 0.54 ? "200종목 중앙값보다 **낮다**" : "200종목 중앙값보다 **높다** — 3종목이 관대한 표본"}. 다만 이 구간은 상승장이라 절대 적중률은 상방 편향을 포함한다 (60일 백필의 기준선 논의와 동일).`);
  say();
  say(`## 7. 하지 않은 것 (사전 등록 §7)`);
  say(`- 파라미터·눈금·부품 변경 없음. 200종목 라이브 없음. 결과의 자동 반영 없음 — 위 §3·§5는 **상신**이며 실행은 발주자 승인 후.`);
  writeFileSync(resolve(process.cwd(), "docs/MT_CROSSSECTION.md"), out.join("\n") + "\n", "utf8");
  console.log("\n→ docs/MT_CROSSSECTION.md 기록");
}
main();
