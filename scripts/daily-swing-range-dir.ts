// 횡보 국면에서 다음 방향을 가장 잘 맞히는 모델 (사용자 질문 2026-08-08:
// "지금 횡보하다 하락할지 횡보하다 상승할지 판정은 돈치안이 가장 잘하나?"):
//   npx tsx scripts/daily-swing-range-dir.ts
// 국면 정의(관측 가능): ①하락 후 정지 = 60일 고점比 ≤-12% 그리고 최근 10일 |수익| ≤ 1×ATR%
//                    ②변동성 수축 = 최근 20일 고저폭 ≤ 250일 중앙값 ×0.8
// 각 국면일에서 모델 스탠스 대비 이후 10·20일 종가 방향 적중을 재고, 우연 기준선(=상승일 비율)과 비교한다.
// flat은 채점 제외 — '방향을 낸 날'만 센다. 표본이 적은 모델은 순위가 운이므로 n을 함께 본다.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, atr14, type Stance, type DailyBar } from "../lib/predict-daily/models";

const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;

function median(a: number[]) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

async function run(sym: string, name: string) {
  const bars = await fetchDailyPredict(sym, 2600);
  const c = bars.map(b => b.close);
  const hi = bars.map(b => b.high), lo = bars.map(b => b.low);
  const atr = atr14(bars);
  const st: Record<string, Stance[]> = {};
  for (const m of MODELS) st[m.id] = m.run(bars);

  const range20 = (i: number) => (Math.max(...hi.slice(i - 19, i + 1)) - Math.min(...lo.slice(i - 19, i + 1))) / c[i] * 100;
  const phases: { id: string; label: string; ok: (i: number) => boolean }[] = [
    {
      id: "STALL", label: "하락 후 정지 (고점比≤-12% & 최근10일 |수익|≤1×ATR%)",
      ok: (i) => {
        const a = atr[i]; if (a == null) return false;
        const hi60 = Math.max(...c.slice(i - 60, i + 1));
        return ((c[i] - hi60) / hi60) * 100 <= -12 && Math.abs(((c[i] - c[i - 10]) / c[i - 10]) * 100) <= (a / c[i]) * 100;
      },
    },
    {
      id: "SQUEEZE", label: "변동성 수축 (20일 고저폭 ≤ 250일 중앙값×0.8)",
      ok: (i) => {
        if (i < 270) return false;
        const hist: number[] = [];
        for (let k = i - 250; k < i; k++) hist.push(range20(k));
        return range20(i) <= median(hist) * 0.8;
      },
    },
  ];

  console.log(`\n════ ${name} ════`);
  for (const ph of phases) {
    const idx: number[] = [];
    for (let i = 280; i < c.length - 20; i++) if (ph.ok(i)) idx.push(i);
    if (idx.length < 20) { console.log(`  ${ph.label}: 표본 ${idx.length}일 — 부족`); continue; }
    let eps = 0, last = -999; for (const i of idx) { if (i - last >= 20) eps++; last = i; }
    const up20 = idx.filter(i => c[i + 20] > c[i]).length, up10 = idx.filter(i => c[i + 10] > c[i]).length;
    console.log(`  ── ${ph.label} ──`);
    console.log(`     ${idx.length}일 (독립 국면 ${eps}회) · 이후 상승 비율: 10일 ${pctOf(up10, idx.length)}% · 20일 ${pctOf(up20, idx.length)}% ← 이게 우연 기준선`);
    const rows = MODELS.map(m => {
      const s = st[m.id];
      let n = 0, w10 = 0, w20 = 0;
      for (const i of idx) {
        const v = s[i]; if (v === "flat") continue;
        n++;
        const d = v === "long" ? 1 : -1;
        if ((c[i + 10] - c[i]) * d > 0) w10++;
        if ((c[i + 20] - c[i]) * d > 0) w20++;
      }
      const longs = idx.filter(i => s[i] === "long").length;
      return { id: m.id, n, w10, w20, longs };
    }).filter(r => r.n >= 10).sort((a, b) => b.w20 / b.n - a.w20 / a.n);
    for (const r of rows) {
      const lift20 = pctOf(r.w20, r.n) - pctOf(r.longs >= r.n / 2 ? up20 : idx.length - up20, idx.length);
      console.log(`     ${r.id.padEnd(10)} 20일 ${String(pctOf(r.w20, r.n)).padStart(3)}% · 10일 ${String(pctOf(r.w10, r.n)).padStart(3)}% (판정 ${String(r.n).padStart(3)}일 중 long ${r.longs}) · 방향편향 보정 리프트 ${s1(lift20)}%p`);
    }
  }
  // 현재 국면 해당 여부
  const i = c.length - 1;
  const on = phases.filter(p => { try { return p.ok(i); } catch { return false; } }).map(p => p.id);
  console.log(`  현재(${bars[i].date}) 해당 국면: [${on.join(", ") || "없음"}] · 최근10일 수익 ${(((c[i] - c[i - 10]) / c[i - 10]) * 100).toFixed(1)}% · ATR ${(((atr[i] ?? 0) / c[i]) * 100).toFixed(1)}%`);
  console.log(`  현재 스탠스: ${MODELS.map(m => `${m.id.slice(0, 4)}:${st[m.id][i]}`).join(" · ")}`);
}

async function main() {
  await run("005930", "삼성전자");
  await run("000660", "SK하이닉스");
  console.log(`\n  ※ '방향편향 보정 리프트' = 그 모델이 주로 낸 방향의 기저 확률 대비 초과분. 상승장이면 long은 원래 잘 맞으므로 그걸 빼야 실력이 보인다.`);
}
main();
