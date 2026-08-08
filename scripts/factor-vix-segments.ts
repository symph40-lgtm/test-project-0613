// VIX 게이트 구간 분해 검정 (Phase 1 후속 — 사용자 지시 2026-08-08):
//   npx tsx scripts/factor-vix-segments.ts
// factor-public-index에서 VIX 5일 변화만 T0(갭)에 리프트 +16~+18로 살아남았다. 다중비교(72칸) 중
// 하나일 수 있으므로 채택 기준(2종목 × 3구간 무해+개선)으로 다시 건다.
// ⚠앞선 스크립트는 분봉 캐시(231일)를 썼는데, T0~T2는 일봉 시가·종가만 있으면 되므로
//   여기서는 일봉 10년+를 쓴다 — 구간 분해가 가능해지고 표본도 10배가 된다.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const FRED = process.env.FRED_API_KEY;

async function fred(id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED}&file_type=json&observation_start=2014-01-01`);
  if (!r.ok) { console.log(`⚠${id}: HTTP ${r.status}`); return out; }
  const j = await r.json() as { observations?: { date: string; value: string }[] };
  for (const o of j.observations ?? []) { const v = parseFloat(o.value); if (isFinite(v)) out.set(o.date, v); }
  return out;
}
function asOf(m: Map<string, number>, date: string, sorted: string[]): number | null {
  let lo = 0, hi = sorted.length - 1, best: string | null = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= date) { best = sorted[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best ? m.get(best)! : null;
}

type R = { date: string; t0: number; t1: number; t2: number; vixCh: number | null; vixLv: number | null };

async function run(sym: string, name: string, vix: Map<string, number>, vixKeys: string[]) {
  const bars = await fetchDailyPredict(sym, 2600);
  const rows: R[] = [];
  for (let i = 0; i < bars.length - 1; i++) {
    const c = bars[i], n = bars[i + 1];
    const lv = asOf(vix, c.date, vixKeys);
    // VIX 5거래일 변화 — c.date 시점에 아는 값만 사용
    const prevIdx = i - 5 >= 0 ? asOf(vix, bars[i - 5].date, vixKeys) : null;
    rows.push({
      date: c.date,
      t0: ((n.open - c.close) / c.close) * 100,
      t1: ((n.close - n.open) / n.open) * 100,
      t2: ((n.close - c.close) / c.close) * 100,
      vixLv: lv,
      vixCh: lv != null && prevIdx != null && prevIdx !== 0 ? ((lv - prevIdx) / prevIdx) * 100 : null,
    });
  }
  const segs: [string, R[]][] = [
    ["전체", rows],
    ["최근 3년", rows.slice(-744)],
    ["최근 1년", rows.slice(-248)],
  ];
  console.log(`\n════ ${name} (${bars.length}일 · ${bars[0].date}~${bars[bars.length - 1].date}) ════`);
  for (const [lb, g] of segs) {
    const valid = g.filter(r => r.vixCh != null);
    if (valid.length < 100) { console.log(`  ${lb}: 표본 부족`); continue; }
    const up = { t0: g.filter(r => r.t0 > 0).length, t1: g.filter(r => r.t1 > 0).length, t2: g.filter(r => r.t2 > 0).length };
    console.log(`  ── ${lb} (${g.length}일 · 기저 상승 T0 ${pctOf(up.t0, g.length)}% T1 ${pctOf(up.t1, g.length)}% T2 ${pctOf(up.t2, g.length)}%) ──`);
    for (const [alab, sel, dir] of [
      ["VIX 5일 ≥+10% → 숏", valid.filter(r => r.vixCh! >= 10), -1],
      ["VIX 5일 ≤-10% → 롱", valid.filter(r => r.vixCh! <= -10), 1],
      ["VIX 5일 ≥+20% → 숏", valid.filter(r => r.vixCh! >= 20), -1],
      ["VIX 5일 ≤-20% → 롱", valid.filter(r => r.vixCh! <= -20), 1],
    ] as [string, R[], number][]) {
      if (sel.length < 20) { console.log(`     ${alab.padEnd(22)} n=${sel.length} 부족`); continue; }
      const out: string[] = [];
      for (const t of ["t0", "t1", "t2"] as const) {
        const hit = sel.filter(r => r[t] * dir > 0).length;
        const base = dir === 1 ? up[t] : g.length - up[t];
        const lift = pctOf(hit, sel.length) - pctOf(base, g.length);
        out.push(`${t.toUpperCase()} ${s2(sel.reduce((a, r) => a + r[t] * dir, 0) / sel.length)}%/리프트${lift >= 0 ? "+" : ""}${lift}`);
      }
      console.log(`     ${alab.padEnd(22)} n=${String(sel.length).padStart(3)} · ${out.join(" · ")}`);
    }
  }
}

async function main() {
  if (!FRED) { console.error("FRED_API_KEY 없음"); return; }
  const vix = await fred("VIXCLS");
  const keys = [...vix.keys()].sort();
  console.log(`VIX ${vix.size}개 관측 (${keys[0]} ~ ${keys[keys.length - 1]})`);
  await run("000660", "SK하이닉스", vix, keys);
  await run("005930", "삼성전자", vix, keys);
  console.log(`\n  ※ 채택 기준: 2종목 × 3구간 전부 무해+개선. 한 칸이라도 음수면 기각(다중비교 방어).`);
}
main();
