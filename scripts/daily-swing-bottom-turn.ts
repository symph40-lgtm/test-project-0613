// 바닥권(하락 정지 → 횡보 → 반등) 국면에서 어느 모델이 강한가 (사용자 질문 2026-08-08:
// "하락 추세가 멈추고 횡보하다 반등할 것 같은데, 이런 상황을 잘 잡는 모델은?"):
//   npx tsx scripts/daily-swing-bottom-turn.ts
// 일봉 10.5년(네이버 fchart)으로 ①바닥권 국면 정의 → ②국면 내 모델별 방향적중 ③반등 포착 지연(며칠 늦나,
// 그동안 놓친 상승폭) ④헛신호(반등인 줄 알았는데 더 하락)를 잰다. 미래 정보는 국면 라벨링에만 사용.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, type Stance, type DailyBar } from "../lib/predict-daily/models";

const DAYS = 2600;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

// ── 국면 정의 ────────────────────────────────────────────────────────────
// 하락 국면: 종가가 60일 최고 대비 -12% 이하 && 최근 20일 수익 ≤ -8%
// 그 안에서 '바닥일' = 이후 60일 최저가 되는 날 (사후 라벨 — 채점 기준점으로만 사용)
// 바닥 이후 20일 수익으로 결과 3분류: 반등(≥+8%) / 횡보(-5~+8%) / 추가하락(≤-5%)
type Phase = { botI: number; kind: "반등" | "횡보" | "추가하락"; fwd20: number };

function findBottoms(bars: DailyBar[]): Phase[] {
  const c = bars.map(b => b.close);
  const out: Phase[] = [];
  let lastBot = -999;
  for (let i = 60; i < c.length - 20; i++) {
    const hi60 = Math.max(...c.slice(i - 60, i + 1));
    const r20 = ((c[i] - c[i - 20]) / c[i - 20]) * 100;
    const fromHi = ((c[i] - hi60) / hi60) * 100;
    if (fromHi > -12 || r20 > -8) continue;              // 하락 국면 아님
    const lo = Math.min(...c.slice(Math.max(0, i - 20), i + 21));
    if (c[i] > lo * 1.005) continue;                      // 이 날이 국지 바닥이 아님
    if (i - lastBot < 20) continue;                       // 같은 바닥 중복 제거
    lastBot = i;
    const fwd20 = ((c[i + 20] - c[i]) / c[i]) * 100;
    out.push({ botI: i, kind: fwd20 >= 8 ? "반등" : fwd20 <= -5 ? "추가하락" : "횡보", fwd20 });
  }
  return out;
}

const hit = (s: Stance, r: number) => (s === "long" ? r > 0 : s === "short" ? r < 0 : null);

async function run(sym: string, name: string) {
  const bars = await fetchDailyPredict(sym, DAYS);
  const c = bars.map(b => b.close);
  const stances: Record<string, Stance[]> = {};
  for (const m of MODELS) stances[m.id] = m.run(bars);
  const phases = findBottoms(bars);
  const reb = phases.filter(p => p.kind === "반등");
  console.log(`\n════ ${name} (${bars.length}일 · ${bars[0].date}~${bars[bars.length - 1].date}) ════`);
  console.log(`  바닥권 국면 ${phases.length}건: 반등 ${reb.length} · 횡보 ${phases.filter(p => p.kind === "횡보").length} · 추가하락 ${phases.filter(p => p.kind === "추가하락").length}`);

  // ① 바닥 ±5일 구간에서 모델별 r5 방향적중 (그 국면에서 방향을 맞추는가)
  console.log(`  ── ① 바닥권(바닥일 ±5일) 방향적중 r5 ──`);
  const rows: { id: string; label: string; hit: number; n: number; lag: number[]; miss: number[]; early: number }[] = [];
  for (const m of MODELS) {
    const st = stances[m.id];
    let w = 0, n = 0;
    for (const p of phases) {
      for (let i = Math.max(0, p.botI - 5); i <= Math.min(c.length - 6, p.botI + 5); i++) {
        const r5 = ((c[i + 5] - c[i]) / c[i]) * 100;
        const h = hit(st[i], r5);
        if (h !== null) { n++; if (h) w++; }
      }
    }
    rows.push({ id: m.id, label: m.label, hit: w, n, lag: [], miss: [], early: 0 });
  }

  // ② 반등 포착 지연 — 바닥일 이후 처음 long이 되는 날까지의 거래일 수와 그 사이 상승폭(놓친 폭)
  for (const r of rows) {
    const st = stances[r.id];
    for (const p of reb) {
      let k = -1;
      for (let i = p.botI; i <= Math.min(c.length - 1, p.botI + 30); i++) {
        if (st[i] === "long") { k = i; break; }
      }
      if (k >= 0) { r.lag.push(k - p.botI); r.miss.push(((c[k] - c[p.botI]) / c[p.botI]) * 100); }
      else { r.lag.push(30); r.miss.push(((c[Math.min(c.length - 1, p.botI + 30)] - c[p.botI]) / c[p.botI]) * 100); }
    }
    // ③ 헛신호: 추가하락 국면인데 바닥일 ±3일에 long
    for (const p of phases.filter(x => x.kind === "추가하락")) {
      for (let i = Math.max(0, p.botI - 3); i <= Math.min(c.length - 1, p.botI + 3); i++) if (st[i] === "long") { r.early++; break; }
    }
  }
  const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  rows.sort((a, b) => (b.n ? b.hit / b.n : 0) - (a.n ? a.hit / a.n : 0));
  for (const r of rows) {
    console.log(`    ${r.id.padEnd(10)} 적중 ${pctOf(r.hit, r.n).padStart(4)} (${r.hit}/${r.n}) · 반등 포착 중앙 ${String(med(r.lag)).padStart(2)}거래일·놓친 상승 평균 ${s1(avg(r.miss))}% · 추가하락 국면 헛신호 ${r.early}/${phases.filter(x => x.kind === "추가하락").length}`);
  }

  // ⓪ 사전 조건 기저율 — '바닥일'은 이후 20일 최저를 요구하는 사후 라벨이라 추가하락이 정의상 배제된다.
  // 그래서 그날 관측만으로 판정 가능한 조건(60일 고점比 ≤-12% && 20일 수익 ≤-8%)을 만족한 모든 날의
  // 이후 20일 분포를 따로 낸다 — 이게 "지금 같은 상황에서 무슨 일이 일어났나"의 정직한 기저율.
  {
    const idx: number[] = [];
    for (let i = 60; i < c.length - 20; i++) {
      const hi60 = Math.max(...c.slice(i - 60, i + 1));
      if (((c[i] - hi60) / hi60) * 100 > -12) continue;
      if (((c[i] - c[i - 20]) / c[i - 20]) * 100 > -8) continue;
      idx.push(i);
    }
    const fwd = idx.map(i => ((c[i + 20] - c[i]) / c[i]) * 100);
    const up = fwd.filter(x => x >= 8).length, dn = fwd.filter(x => x <= -5).length;
    // 에피소드 수 (연속일은 같은 국면 — 20일 이상 떨어진 것만 별개로 셈)
    let eps = 0, last = -999;
    for (const i of idx) { if (i - last >= 20) eps++; last = i; }
    console.log(`  ── ⓪ 사전 조건 기저율 (조건 충족일 ${idx.length}일 · 독립 국면 약 ${eps}회) ──`);
    console.log(`    이후 20일: 반등(≥+8%) ${pctOf(up, fwd.length)} · 횡보 ${pctOf(fwd.length - up - dn, fwd.length)} · 추가하락(≤-5%) ${pctOf(dn, fwd.length)} · 평균 ${s1(fwd.reduce((a, b) => a + b, 0) / Math.max(1, fwd.length))}% · 최악 ${Math.min(...fwd).toFixed(1)}%`);
    console.log(`    ── 조건 충족일의 모델별 이후 20일 방향적중 ──`);
    const ms = MODELS.map(m => {
      let w = 0, n = 0;
      for (const i of idx) { const h = hit(stances[m.id][i], ((c[i + 20] - c[i]) / c[i]) * 100); if (h !== null) { n++; if (h) w++; } }
      return { id: m.id, w, n };
    }).sort((a, b) => (b.n ? b.w / b.n : 0) - (a.n ? a.w / a.n : 0));
    console.log(`      ${ms.map(x => `${x.id.slice(0, 4)} ${pctOf(x.w, x.n)}(${x.n})`).join(" · ")}`);
  }

  // ③-b 지금이 그 '바닥권 조건'인가 (최근 10일 상태)
  console.log(`  ── ③ 현재 국면 점검 (조건: 60일 최고 대비 ≤-12% 그리고 20일 수익 ≤-8%) ──`);
  for (let i = c.length - 5; i < c.length; i++) {
    const hi60 = Math.max(...c.slice(Math.max(0, i - 60), i + 1));
    const fromHi = ((c[i] - hi60) / hi60) * 100;
    const r20 = ((c[i] - c[i - 20]) / c[i - 20]) * 100;
    const lo20 = Math.min(...c.slice(Math.max(0, i - 20), i + 1));
    const st = MODELS.map(m => `${m.id.slice(0, 4)}:${stances[m.id][i][0].toUpperCase()}`).join(" ");
    console.log(`    ${bars[i].date} ${c[i].toLocaleString()} · 60일고점比 ${fromHi.toFixed(1)}% · 20일 ${s1(r20)}% · 20일저점比 ${(((c[i] - lo20) / lo20) * 100).toFixed(1)}% ${fromHi <= -12 && r20 <= -8 ? "★바닥권 조건 충족" : ""} | ${st}`);
  }

  // ④ 국면 종류별 스탠스 분포 (바닥일 당일)
  console.log(`  ── ② 바닥일 당일 스탠스 (사후 결과별) ──`);
  for (const kind of ["반등", "횡보", "추가하락"] as const) {
    const g = phases.filter(p => p.kind === kind);
    if (!g.length) continue;
    const line = MODELS.map(m => {
      const cnt = { long: 0, short: 0, flat: 0 } as Record<Stance, number>;
      for (const p of g) cnt[stances[m.id][p.botI]]++;
      return `${m.id.slice(0, 4)} L${cnt.long}/S${cnt.short}/F${cnt.flat}`;
    }).join(" · ");
    console.log(`    ${kind}(${g.length}건): ${line}`);
  }
}

async function main() {
  await run("005930", "삼성전자");
  await run("000660", "SK하이닉스");
}
main();
