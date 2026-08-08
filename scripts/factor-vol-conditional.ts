// Phase 1-C — '미장 약세일 × 변동성 급등' 조건부 셀 확인검정 (docs/factor-quant-plan.md):
//   npx tsx scripts/factor-vol-conditional.ts
//
// 왜 이걸 하는가 — 독립 지표 2개가 같은 셀에서 같은 답을 냈다:
//   VIX  증분(factor-vix-incremental): SOX 하위⅓에서만 유지 +0.61(하닉)/+0.32(삼전), 중위 역전·상위 소멸
//   VXN  증분(factor-market-risk)    : SOX 하위⅓에서만 유지 +0.65(하닉)/+0.48(삼전), 중위·상위 소멸
// 서로 다른 변동성 지수가 같은 조건부 셀에서 같은 부호·비슷한 크기로 나오면 우연으로 보기 어렵다.
// VIX에서 발견하고 VXN에서 재현된 셈이므로, 여기서는 그 셀을 **사전 고정**하고 제대로 검정한다.
//
// 관문:
//   ① 셀 안 순열검정 p<0.05 (2종목)
//   ② 구간 분해(전체/3년/1년) 부호 유지
//   ③ **워크포워드** — 앞 절반에서만 셀 임계·방향을 정하고 뒤 절반으로 검증. 사후 발견 셀의 최대 약점이 여기다.
//   ④ 실무성 — 셀 빈도(며칠에 한 번 오는가)와 1일 기대 리프트
// 셀은 전체의 1/3이므로 표본이 줄어든다. n과 p를 같이 보고 판단한다.
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

async function fred(id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED}&file_type=json&observation_start=2014-01-01`);
  if (!r.ok) return out;
  const j = await r.json() as { observations?: { date: string; value: string }[] };
  for (const o of j.observations ?? []) { const v = parseFloat(o.value); if (isFinite(v)) out.set(o.date, v); }
  return out;
}
function asOf(m: Map<string, number>, keys: string[], date: string): number | null {
  let lo = 0, hi = keys.length - 1, best: string | null = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] <= date) { best = keys[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best ? m.get(best)! : null;
}
function permP(a: number[], b: number[], iters = 6000): number {
  const obs = a.reduce((x, y) => x + y, 0) / a.length - b.reduce((x, y) => x + y, 0) / b.length;
  const all = [...a, ...b], nA = a.length;
  let seed = 20260808, ge = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    const s = all.slice();
    for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
    const d = s.slice(0, nA).reduce((x, y) => x + y, 0) / nA - s.slice(nA).reduce((x, y) => x + y, 0) / (s.length - nA);
    if (d >= obs) ge++;
  }
  return ge / iters;
}

type Row = { date: string; t0: number; t1: number; t2: number; soxCh: number; vix: number; vxn: number };
type H = "t0" | "t1" | "t2";

async function build(sym: string, vix: Map<string, number>, vk: string[], vxn: Map<string, number>, xk: string[], sox: Map<string, number>, sk: string[]): Promise<Row[]> {
  const bars = await fetchDailyPredict(sym, 2600);
  const rows: Row[] = [];
  for (let i = 6; i < bars.length - 1; i++) {
    const c = bars[i], p5 = bars[i - 5], n = bars[i + 1];
    if (!(c.close > 0) || !(n.open > 0) || !(n.close > 0)) continue;
    const s = asOf(sox, sk, c.date), s5 = asOf(sox, sk, p5.date);
    const v = asOf(vix, vk, c.date), v5 = asOf(vix, vk, p5.date);
    const x = asOf(vxn, xk, c.date), x5 = asOf(vxn, xk, p5.date);
    if (s == null || s5 == null || v == null || v5 == null || x == null || x5 == null || !s5 || !v5 || !x5) continue;
    rows.push({
      date: c.date,
      t0: ((n.open - c.close) / c.close) * 100,
      t1: ((n.close - n.open) / n.open) * 100,
      t2: ((n.close - c.close) / c.close) * 100,
      soxCh: ((s - s5) / s5) * 100,
      vix: ((v - v5) / v5) * 100,
      vxn: ((x - x5) / x5) * 100,
    });
  }
  return rows;
}

// 셀 안에서 '변동성 하위½ − 상위½' 수익 차이. 가설대로면 양수(변동성 낮을수록 다음날 좋다).
function cellTest(cell: Row[], vol: "vix" | "vxn", h: H) {
  const s = cell.slice().sort((a, b) => a[vol] - b[vol]);
  const half = Math.floor(s.length / 2);
  const lo = s.slice(0, half), hi = s.slice(s.length - half);
  const mLo = lo.reduce((a, r) => a + r[h], 0) / lo.length;
  const mHi = hi.reduce((a, r) => a + r[h], 0) / hi.length;
  return { diff: mLo - mHi, mLo, mHi, p: permP(lo.map(r => r[h]), hi.map(r => r[h])), n: cell.length };
}

function run(name: string, rows: Row[]) {
  console.log(`\n════ ${name} — 전체 ${rows.length}일 (${rows[0].date} ~ ${rows[rows.length - 1].date}) ════`);
  // 셀 정의: SOX 5일변화 하위⅓ (사전 고정)
  const srt = rows.slice().sort((a, b) => a.soxCh - b.soxCh);
  const cut = srt[Math.floor(srt.length / 3)].soxCh;
  const cell = rows.filter(r => r.soxCh <= cut);
  console.log(`  셀 = SOX 5일변화 ≤ ${cut.toFixed(2)}% (미장 약세 하위⅓) · ${cell.length}일 · 전체의 ${Math.round(cell.length / rows.length * 100)}% (약 ${(rows.length / cell.length).toFixed(1)}일에 1회)`);

  for (const vol of ["vix", "vxn"] as const) {
    console.log(`  ── ${vol.toUpperCase()} 5일변화 (셀 안 하위½ − 상위½) ──`);
    for (const h of ["t0", "t1", "t2"] as H[]) {
      const r = cellTest(cell, vol, h);
      console.log(`     ${h.toUpperCase()} 저변동성일 ${s2(r.mLo)}% · 고변동성일 ${s2(r.mHi)}% · 차이 ${s2(r.diff)}%p · p=${r.p.toFixed(3)} ${r.p < 0.05 && r.diff > 0 ? "★유의" : ""}`);
    }
  }

  // ★가장 중요한 반론 — 셀 안에서도 VIX가 그저 'SOX 낙폭의 정밀 측정치'일 수 있다.
  // 셀(SOX ≤ -0.80%)은 -1%도 -20%도 함께 담는다. 고변동성일이 곧 깊은 낙폭일이라면 이건 여전히 SOX 재포장이다.
  // → 셀 '안에서 다시' SOX 3분위로 쪼개고, 각 하위분위 안에서 변동성이 여전히 갭을 나누는지 본다.
  {
    const baseT0 = cell.reduce((a, r) => a + r.t0, 0) / cell.length;
    console.log(`  ── 셀 내부 SOX 재통제 (T0) · 셀 평균 갭 ${s2(baseT0)}% · 셀 안 SOX↔VXN 상관 ${(() => {
      const xs = cell.map(r => r.soxCh), ys = cell.map(r => r.vxn);
      const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sx = 0, sy = 0;
      for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
      return (sxy / Math.sqrt(sx * sy)).toFixed(3);
    })()} ──`);
    const inner = cell.slice().sort((a, b) => a.soxCh - b.soxCh);
    const q = Math.floor(inner.length / 3);
    const subs: [string, Row[]][] = [
      ["셀내 SOX 최악⅓", inner.slice(0, q)],
      ["셀내 SOX 중간⅓", inner.slice(q, 2 * q)],
      ["셀내 SOX 완만⅓", inner.slice(2 * q)],
    ];
    for (const vol of ["vix", "vxn"] as const) {
      let keep = 0;
      const parts: string[] = [];
      for (const [lb, g] of subs) {
        const r = cellTest(g, vol, "t0");
        if (r.diff > 0) keep++;
        parts.push(`${lb} n=${g.length} ${s2(r.diff)}%p(p=${r.p.toFixed(2)})`);
      }
      console.log(`     ${vol.toUpperCase()}: ${parts.join(" · ")} → ${keep}/3 유지 ${keep === 3 ? "★SOX 재포장 아님" : "— SOX 낙폭의 재측정 의심"}`);
    }
  }

  // 구간 분해 — T0만 (1관문에서 T0가 주 후보)
  console.log(`  ── 구간 분해 (T0 · 셀 안) ──`);
  for (const [lb, from] of [["전체", "2000-01-01"], ["최근3년", "2023-08-01"], ["최근1년", "2025-08-01"]] as [string, string][]) {
    const g = cell.filter(r => r.date >= from);
    if (g.length < 40) { console.log(`     ${lb.padEnd(8)} n=${g.length} 부족`); continue; }
    const a = cellTest(g, "vxn", "t0"), b = cellTest(g, "vix", "t0");
    console.log(`     ${lb.padEnd(8)} n=${g.length} · VXN 차이 ${s2(a.diff)}%p · VIX 차이 ${s2(b.diff)}%p ${a.diff > 0 && b.diff > 0 ? "(양측 유지)" : "(무너짐)"}`);
  }

  // 워크포워드 — 앞 절반에서 셀 임계·방향 확정, 뒤 절반 검증
  console.log(`  ── 워크포워드 (앞 절반으로 임계 결정 → 뒤 절반 검증) ──`);
  const mid = Math.floor(rows.length / 2);
  const tr = rows.slice(0, mid), te = rows.slice(mid);
  const trS = tr.slice().sort((a, b) => a.soxCh - b.soxCh);
  const trCut = trS[Math.floor(trS.length / 3)].soxCh;
  const trCell = tr.filter(r => r.soxCh <= trCut);
  for (const vol of ["vix", "vxn"] as const) {
    const trV = trCell.slice().sort((a, b) => a[vol] - b[vol]);
    const volCut = trV[Math.floor(trV.length / 2)][vol]; // 앞 절반의 중앙값을 임계로 고정
    const inS = tr.filter(r => r.soxCh <= trCut);
    const rTr = cellTest(inS, vol, "t0");
    const teCell = te.filter(r => r.soxCh <= trCut);
    const lo = teCell.filter(r => r[vol] <= volCut), hi = teCell.filter(r => r[vol] > volCut);
    if (lo.length < 20 || hi.length < 20) { console.log(`     ${vol.toUpperCase()} 검정구간 표본 부족 (저 ${lo.length}/고 ${hi.length})`); continue; }
    const mLo = lo.reduce((a, r) => a + r.t0, 0) / lo.length, mHi = hi.reduce((a, r) => a + r.t0, 0) / hi.length;
    const p = permP(lo.map(r => r.t0), hi.map(r => r.t0));
    console.log(`     ${vol.toUpperCase()} 학습(${tr[0].date}~${tr[mid - 1].date}) 차이 ${s2(rTr.diff)}%p → 검증(${te[0].date}~${te[te.length - 1].date}) 저 ${s2(mLo)}%/고 ${s2(mHi)}% · 차이 ${s2(mLo - mHi)}%p · p=${p.toFixed(3)} ${mLo - mHi > 0 ? (p < 0.05 ? "★검증 통과(유의)" : "(부호만 유지)") : "(검증 실패)"}`);
  }
}

// 좁힌 셀 확인검정 — 셀 내부 재통제에서 효과가 'SOX 최악⅓'에만 몰렸으므로 거기만 다시 본다.
// 좁히는 행위 자체가 사후 선택이므로, 여기서는 워크포워드를 주 판정 근거로 삼는다.
function narrow(name: string, rows: Row[]) {
  const pctile = (arr: Row[], p: number) => arr.slice().sort((a, b) => a.soxCh - b.soxCh)[Math.floor(arr.length * p)].soxCh;
  const cut = pctile(rows, 1 / 9);
  const c2 = rows.filter(r => r.soxCh <= cut);
  const baseAll = rows.reduce((a, r) => a + r.t0, 0) / rows.length;
  console.log(`\n──── ${name} · 좁힌 셀 = SOX 5일변화 ≤ ${cut.toFixed(2)}% (하위 11%) ────`);
  console.log(`     ${c2.length}일 · 약 ${(rows.length / c2.length).toFixed(1)}일에 1회 · 전체 평균 갭 ${s2(baseAll)}% · 이 셀 평균 갭 ${s2(c2.reduce((a, r) => a + r.t0, 0) / c2.length)}%`);
  for (const vol of ["vix", "vxn"] as const) {
    for (const h of ["t0", "t1"] as H[]) {
      const r = cellTest(c2, vol, h);
      const s = c2.slice().sort((a, b) => a[vol] - b[vol]);
      const hi = s.slice(s.length - Math.floor(s.length / 2));
      const down = hi.filter(x => x[h] < 0).length;
      console.log(`     ${vol.toUpperCase()} ${h.toUpperCase()} 저변동 ${s2(r.mLo)}% · 고변동 ${s2(r.mHi)}% · 차이 ${s2(r.diff)}%p · p=${r.p.toFixed(3)} · 고변동일 하락비율 ${Math.round(down / hi.length * 100)}% (n=${hi.length})`);
    }
  }
  // 구간 분해
  for (const [lb, from] of [["최근3년", "2023-08-01"], ["최근1년", "2025-08-01"]] as [string, string][]) {
    const g = c2.filter(r => r.date >= from);
    if (g.length < 30) { console.log(`     ${lb} n=${g.length} 부족`); continue; }
    console.log(`     ${lb} n=${g.length} · VXN 차이 ${s2(cellTest(g, "vxn", "t0").diff)}%p · VIX 차이 ${s2(cellTest(g, "vix", "t0").diff)}%p`);
  }
  // 워크포워드 — 임계 2개(SOX 하위11%, 변동성 중앙값) 모두 앞 절반에서만 결정
  const mid = Math.floor(rows.length / 2);
  const tr = rows.slice(0, mid), te = rows.slice(mid);
  const trCut = pctile(tr, 1 / 9);
  for (const vol of ["vix", "vxn"] as const) {
    const trCell = tr.filter(r => r.soxCh <= trCut).sort((a, b) => a[vol] - b[vol]);
    const vCut = trCell[Math.floor(trCell.length / 2)][vol];
    const teCell = te.filter(r => r.soxCh <= trCut);
    const lo = teCell.filter(r => r[vol] <= vCut), hi = teCell.filter(r => r[vol] > vCut);
    if (lo.length < 15 || hi.length < 15) { console.log(`     WF ${vol.toUpperCase()} 표본 부족 (저 ${lo.length}/고 ${hi.length})`); continue; }
    const mLo = lo.reduce((a, r) => a + r.t0, 0) / lo.length, mHi = hi.reduce((a, r) => a + r.t0, 0) / hi.length;
    const p = permP(lo.map(r => r.t0), hi.map(r => r.t0));
    console.log(`     WF ${vol.toUpperCase()} 검증 저 ${s2(mLo)}%(n=${lo.length}) · 고 ${s2(mHi)}%(n=${hi.length}) · 차이 ${s2(mLo - mHi)}%p · p=${p.toFixed(3)} ${mLo - mHi > 0 ? (p < 0.05 ? "★통과(유의)" : "(부호만)") : "(실패)"}`);
  }
}

async function main() {
  if (!FRED) { console.error("FRED_API_KEY 없음"); return; }
  const vix = await fred("VIXCLS"), vxn = await fred("VXNCLS");
  const vk = [...vix.keys()].sort(), xk = [...vxn.keys()].sort();
  const r = await yf.chart("^SOX", { period1: new Date("2014-01-01"), interval: "1d" });
  const sox = new Map<string, number>();
  for (const q of r.quotes ?? []) {
    if (q.close == null) continue;
    sox.set((q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), q.close);
  }
  const sk = [...sox.keys()].sort();
  console.log(`VIX ${vix.size}일 · VXN ${vxn.size}일 · SOX ${sox.size}일`);
  for (const [sym, name] of [["000660", "SK하이닉스"], ["005930", "삼성전자"]] as [string, string][]) {
    const rows = await build(sym, vix, vk, vxn, xk, sox, sk);
    run(name, rows);
    narrow(name, rows);
  }
  console.log(`\n  ※ 셀은 사후 발견이다. 워크포워드 검증구간에서 부호와 유의성이 함께 살아야만 채택 후보로 올린다.`);
  console.log(`  ※ 용도는 방향 예측이 아니라 T0(프리장 진입 보류) 판단·비중 게이트다. T1 주력은 별도.`);
}
main();
