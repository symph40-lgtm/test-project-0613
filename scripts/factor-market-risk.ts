// Phase 1-B — 시장가격형 공개지표 확장 검정 (docs/factor-quant-plan.md · 사용자 지시 2026-08-08 이어서):
//   npx tsx scripts/factor-market-risk.ts
// Phase 1에서 나온 패턴이 출발점이다: **시장가격 지표(VIX·SOX)엔 정보가 있고, 뉴스카운트 지표(EPU·GPR)엔 없다.**
// 그렇다면 아직 안 써본 '무료·일간·미장 마감 기준' 시장가격 지표를 전부 훑는 것이 다음 수순이다.
// 이 지표들은 전날 미장 마감(=국장 09:00 이전)에 값이 확정되므로 기획의 전제(야간 정보로 당일 진입)에 맞는다.
//
// 세 번 기각된 전례가 있으므로 이번엔 처음부터 관문을 세 겹으로 둔다:
//   ① 사전 등록 방향 — 지표별 상승=위험회피 방향을 코드에 박아두고, 사후에 부호를 뒤집지 않는다.
//   ② 양쪽 꼬리 — 상위30%(급등)와 하위30%(급락)가 **둘 다** 예측 방향으로 맞아야 한다. 한쪽만 맞으면 우연이다.
//   ③ 순열검정 p — 상·하위 평균 수익 차이가 라벨 셔플 대비 유의해야 한다.
// 여기를 통과한 것만 SOX 통제 증분 검정(factor-vix-incremental.ts와 같은 방식)으로 넘긴다.
// VIX가 구간분해까지 통과하고도 증분에서 소멸했으므로, 증분 통과 없이는 채택하지 않는다.
//
// ⚠발표 지연: FRED 일간 시리즈는 대부분 익영업일에 갱신된다. 국장 09:00에 실제로 볼 수 있었는지
//   확실치 않은 시리즈는 lagDays를 두어 하루 전 값만 쓴다(룩어헤드 차단).
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const FRED = process.env.FRED_API_KEY;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const si = (x: number) => `${x >= 0 ? "+" : ""}${x}`;

type Spec = {
  id: string;          // FRED series id
  label: string;
  dir: 1 | -1;         // 사전 등록: 이 지표가 '오르면' 다음날 방향 (+1 상승 / -1 하락)
  mode: "pct" | "abs"; // 0을 지나거나 음수가 되는 지표는 절대차분
  lagDays: number;     // 09:00 시점 가용성 보수 처리 (달력일)
  why: string;
};

// 사전 등록 — 이 표는 결과를 보기 전에 확정한 것이다.
const SPECS: Spec[] = [
  { id: "BAMLH0A0HYM2", label: "미 하이일드 스프레드(OAS)", dir: -1, mode: "abs", lagDays: 1, why: "스프레드 확대=위험회피" },
  { id: "BAMLC0A0CM",   label: "미 투자등급 스프레드(OAS)", dir: -1, mode: "abs", lagDays: 1, why: "스프레드 확대=위험회피" },
  { id: "VXNCLS",       label: "VXN 나스닥100 변동성",      dir: -1, mode: "pct", lagDays: 0, why: "VIX보다 기술주에 근접" },
  { id: "DFII10",       label: "10Y 실질금리(TIPS)",        dir: -1, mode: "abs", lagDays: 1, why: "실질금리 상승=밸류에이션 압박" },
  { id: "T10Y2Y",       label: "장단기 금리차(10Y-2Y)",      dir: 1,  mode: "abs", lagDays: 1, why: "스티프닝=경기회복 기대" },
  { id: "DTWEXBGS",     label: "달러지수(broad)",           dir: -1, mode: "pct", lagDays: 1, why: "달러 강세=신흥국 자금 유출" },
  { id: "DEXKOUS",      label: "원/달러 환율",              dir: -1, mode: "pct", lagDays: 1, why: "원화 약세=외인 이탈" },
  { id: "NFCI",         label: "시카고연은 금융상황지수(주)", dir: -1, mode: "abs", lagDays: 7, why: "상승=금융여건 긴축" },
];

async function fred(id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED}&file_type=json&observation_start=2014-01-01`);
  if (!r.ok) { console.log(`  ⚠${id}: HTTP ${r.status}`); return out; }
  const j = await r.json() as { observations?: { date: string; value: string }[] };
  for (const o of j.observations ?? []) { const v = parseFloat(o.value); if (isFinite(v)) out.set(o.date, v); }
  return out;
}

const shift = (date: string, days: number) => {
  if (!days) return date;
  const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
function asOf(m: Map<string, number>, keys: string[], date: string): number | null {
  let lo = 0, hi = keys.length - 1, best: string | null = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] <= date) { best = keys[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best ? m.get(best)! : null;
}

// 순열검정 — 상·하위 그룹 라벨을 섞었을 때 관측된 차이 이상이 나오는 비율 (단측, 사전 등록 방향)
function permP(top: number[], bot: number[], iters = 4000): number {
  const obs = top.reduce((a, b) => a + b, 0) / top.length - bot.reduce((a, b) => a + b, 0) / bot.length;
  const all = [...top, ...bot];
  const nT = top.length;
  let seed = 20260808, ge = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    const a = all.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    const d = a.slice(0, nT).reduce((x, y) => x + y, 0) / nT - a.slice(nT).reduce((x, y) => x + y, 0) / (a.length - nT);
    if (d >= obs) ge++;
  }
  return ge / iters;
}

type Row = { date: string; t0: number; t1: number; t2: number; soxCh: number; f: Record<string, number | null> };

async function build(sym: string, series: Map<string, { spec: Spec; m: Map<string, number>; k: string[] }>, sox: Map<string, number>, sk: string[]): Promise<Row[]> {
  const bars = await fetchDailyPredict(sym, 2600);
  const rows: Row[] = [];
  for (let i = 6; i < bars.length - 1; i++) {
    const c = bars[i], p5 = bars[i - 5], n = bars[i + 1];
    // 네이버 일봉에 시가·종가 0인 결손봉이 섞여 있다 — 나누면 Infinity가 되어 평균을 오염시킨다.
    if (!(c.close > 0) || !(n.open > 0) || !(n.close > 0)) continue;
    const s = asOf(sox, sk, c.date), s5 = asOf(sox, sk, p5.date);
    if (s == null || s5 == null || !s5) continue;
    const f: Record<string, number | null> = {};
    for (const [id, { spec, m, k }] of series) {
      const a = asOf(m, k, shift(c.date, spec.lagDays));
      const b = asOf(m, k, shift(p5.date, spec.lagDays));
      f[id] = a == null || b == null ? null : spec.mode === "pct" ? (b === 0 ? null : ((a - b) / Math.abs(b)) * 100) : a - b;
    }
    rows.push({
      date: c.date,
      t0: ((n.open - c.close) / c.close) * 100,
      t1: ((n.close - n.open) / n.open) * 100,
      t2: ((n.close - c.close) / c.close) * 100,
      soxCh: ((s - s5) / s5) * 100,
      f,
    });
  }
  return rows;
}

type Pass = { id: string; sym: string; horizon: "t0" | "t1" | "t2" };

function univariate(name: string, rows: Row[], specs: Spec[], sym: string, out: Pass[]) {
  const base = { t0: rows.filter(r => r.t0 > 0).length / rows.length, t1: rows.filter(r => r.t1 > 0).length / rows.length, t2: rows.filter(r => r.t2 > 0).length / rows.length };
  console.log(`\n════ ${name} — ${rows.length}일 (${rows[0].date} ~ ${rows[rows.length - 1].date}) · 기저 상승률 T0 ${Math.round(base.t0 * 100)}% · T1 ${Math.round(base.t1 * 100)}% · T2 ${Math.round(base.t2 * 100)}% ════`);
  for (const spec of specs) {
    const valid = rows.filter(r => r.f[spec.id] != null);
    if (valid.length < 300) { console.log(`  ${spec.label} — 커버 ${valid.length}일 부족, 건너뜀`); continue; }
    const srt = valid.slice().sort((a, b) => (a.f[spec.id]! - b.f[spec.id]!));
    const q = Math.floor(srt.length * 0.3);
    const bot = srt.slice(0, q);        // 지표 급락
    const top = srt.slice(srt.length - q); // 지표 급등
    console.log(`  ${spec.label}  [${spec.why} · 방향 ${spec.dir > 0 ? "상승" : "하락"} · 지연 ${spec.lagDays}일 · n=${valid.length}]`);
    for (const t of ["t0", "t1", "t2"] as const) {
      // 사전 등록 방향: 지표 급등 → dir 방향, 지표 급락 → 반대 방향. 둘 다 맞아야 통과.
      const mTop = top.reduce((a, r) => a + r[t] * spec.dir, 0) / top.length;
      const mBot = bot.reduce((a, r) => a + r[t] * -spec.dir, 0) / bot.length;
      const hTop = top.filter(r => r[t] * spec.dir > 0).length / top.length;
      const hBot = bot.filter(r => r[t] * -spec.dir > 0).length / bot.length;
      const bT = spec.dir > 0 ? base[t] : 1 - base[t];
      const lTop = Math.round((hTop - bT) * 100), lBot = Math.round((hBot - (1 - bT)) * 100);
      // 순열검정: 원 수익(부호 미조정) 기준 top-bot 차이가 dir 방향인가
      const p = permP(top.map(r => r[t] * spec.dir), bot.map(r => r[t] * spec.dir));
      const both = lTop > 0 && lBot > 0;
      const ok = both && p < 0.05;
      if (ok) out.push({ id: spec.id, sym, horizon: t });
      console.log(`     ${t.toUpperCase()} 급등측 ${s2(mTop)}%/리프트${si(lTop)} · 급락측 ${s2(mBot)}%/리프트${si(lBot)} · p=${p.toFixed(3)} ${ok ? "★통과" : both ? "(양쪽 양수·유의 아님)" : ""}`);
    }
  }
}

// 2관문 — SOX 통제 후에도 갈리는가 (VIX가 여기서 죽었다)
function incremental(name: string, rows: Row[], spec: Spec, horizon: "t0" | "t1" | "t2") {
  const valid = rows.filter(r => r.f[spec.id] != null);
  const bySox = valid.slice().sort((a, b) => a.soxCh - b.soxCh);
  const q = Math.floor(bySox.length / 3);
  const buckets: [string, Row[]][] = [
    ["SOX 하위⅓(미장 약세)", bySox.slice(0, q)],
    ["SOX 중위⅓", bySox.slice(q, 2 * q)],
    ["SOX 상위⅓(미장 강세)", bySox.slice(2 * q)],
  ];
  let keep = 0;
  console.log(`  ── ${name} · ${spec.label} · ${horizon.toUpperCase()} — SOX 통제 증분 ──`);
  for (const [lb, g] of buckets) {
    const s = g.slice().sort((a, b) => a.f[spec.id]! - b.f[spec.id]!);
    const half = Math.floor(s.length / 2);
    const lowF = s.slice(0, half), highF = s.slice(half);
    // 지표가 낮을수록 dir 반대이므로, (낮은쪽 − 높은쪽) × (−dir) 이 양수여야 신호 유지
    const d = (lowF.reduce((a, r) => a + r[horizon], 0) / lowF.length - highF.reduce((a, r) => a + r[horizon], 0) / highF.length) * -spec.dir;
    if (d > 0) keep++;
    console.log(`     ${lb.padEnd(20)} n=${g.length} · 증분 ${s2(d)}%p ${d > 0 ? "(유지)" : "(소멸/역전)"}`);
  }
  console.log(`     → 3구간 중 ${keep}개 유지 ${keep === 3 ? "★증분 통과" : "— 증분 불충분(SOX 재포장 의심)"}`);
  return keep;
}

// 3관문 — 구간 분해 (전체/3년/1년)
function segments(name: string, rows: Row[], spec: Spec, horizon: "t0" | "t1" | "t2") {
  const valid = rows.filter(r => r.f[spec.id] != null);
  const segs: [string, Row[]][] = [
    ["전체", valid],
    ["최근3년", valid.filter(r => r.date >= "2023-08-01")],
    ["최근1년", valid.filter(r => r.date >= "2025-08-01")],
  ];
  console.log(`  ── ${name} · ${spec.label} · ${horizon.toUpperCase()} — 구간 분해 ──`);
  for (const [lb, g] of segs) {
    if (g.length < 60) { console.log(`     ${lb.padEnd(8)} n=${g.length} 부족`); continue; }
    const s = g.slice().sort((a, b) => a.f[spec.id]! - b.f[spec.id]!);
    const q = Math.floor(s.length * 0.3);
    const bot = s.slice(0, q), top = s.slice(s.length - q);
    const mTop = top.reduce((a, r) => a + r[horizon] * spec.dir, 0) / top.length;
    const mBot = bot.reduce((a, r) => a + r[horizon] * -spec.dir, 0) / bot.length;
    console.log(`     ${lb.padEnd(8)} n=${g.length} · 급등측 ${s2(mTop)}% · 급락측 ${s2(mBot)}% ${mTop > 0 && mBot > 0 ? "(양측 양수)" : "(무너짐)"}`);
  }
}

async function main() {
  if (!FRED) { console.error("FRED_API_KEY 없음 — .env.local 확인"); return; }
  console.log("FRED 시계열 수신 중...");
  const series = new Map<string, { spec: Spec; m: Map<string, number>; k: string[] }>();
  for (const spec of SPECS) {
    const m = await fred(spec.id);
    const k = [...m.keys()].sort();
    console.log(`  ${spec.label.padEnd(24)} ${m.size}개${m.size ? ` (${k[0]} ~ ${k[k.length - 1]})` : " ← 사용 불가"}`);
    if (m.size) series.set(spec.id, { spec, m, k });
  }
  if (!series.size) { console.log("사용 가능한 시리즈 없음"); return; }

  const r = await yf.chart("^SOX", { period1: new Date("2014-01-01"), interval: "1d" });
  const sox = new Map<string, number>();
  for (const q of r.quotes ?? []) {
    if (q.close == null) continue;
    sox.set((q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), q.close);
  }
  const sk = [...sox.keys()].sort();
  console.log(`  SOX ${sox.size}일\n`);

  const specs = [...series.values()].map(v => v.spec);
  const passes: Pass[] = [];
  const store: Record<string, Row[]> = {};
  for (const [sym, name] of [["000660", "SK하이닉스"], ["005930", "삼성전자"]] as [string, string][]) {
    const rows = await build(sym, series, sox, sk);
    store[sym] = rows;
    univariate(name, rows, specs, sym, passes);
  }

  // 2종목 동시 통과만 다음 관문으로
  console.log(`\n══════ 1관문 결과 — 2종목 동시 통과만 진행 ══════`);
  const key = (p: Pass) => `${p.id}|${p.horizon}`;
  const bySym: Record<string, Set<string>> = {};
  for (const p of passes) (bySym[p.sym] ??= new Set()).add(key(p));
  const both = [...(bySym["000660"] ?? [])].filter(k => bySym["005930"]?.has(k));
  if (!both.length) {
    console.log("  2종목 동시 통과 없음 — 이 지표군에서 채택 후보 없음.");
    console.log("  (한 종목만 통과한 것은 기존 방침대로 채택하지 않는다)");
    return;
  }
  for (const k of both) {
    const [id, horizon] = k.split("|") as [string, "t0" | "t1" | "t2"];
    const spec = series.get(id)!.spec;
    console.log(`\n★ 후보: ${spec.label} · ${horizon.toUpperCase()}`);
    for (const [sym, name] of [["000660", "SK하이닉스"], ["005930", "삼성전자"]] as [string, string][]) {
      incremental(name, store[sym], spec, horizon);
      segments(name, store[sym], spec, horizon);
    }
  }
  console.log(`\n  ※ 채택 조건: 1관문(양쪽 꼬리+p<0.05, 2종목) → 2관문(SOX 통제 3구간 유지) → 3관문(구간 분해 무너지지 않음). 셋 다여야 게이트 후보.`);
}
main();
