// P1(이진) vs v4(완충 50%)의 차이가 통계적으로 유의한가 (사용자 질문 2026-08-08):
//   npx tsx scripts/daily-swing-p1-significance.ts
// 두 전략은 '미너비니 flat & 와인스타인 long'인 날에만 갈린다 — v4는 50% 보유, P1은 0%.
// 따라서 차이의 전부는 그 '완충일'들의 수익률에서 나온다. 누적 %가 아니라 그 날들의 분포를 본다.
//   ① 완충일이 며칠인가 · 그 날들의 일별 수익률 평균이 0과 유의하게 다른가(부트스트랩)
//   ② 기간을 잘라도 부호가 유지되는가(안정성)
//   ③ 차이가 소수의 날에 몰려 있지 않은가(상위 5일 제거 시)
// ⚠MDD 차이는 단일 실현 경로라 통계 검정 대상이 아니다 — 참고 수치로만.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { MODELS, type Stance, type DailyBar } from "../lib/predict-daily/models";

const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
let seed = 20260808;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

async function run(sym: string, name: string) {
  const bars = await fetchDailyPredict(sym, 2600);
  const c = bars.map(b => b.close);
  const st: Record<string, Stance[]> = {};
  for (const m of MODELS) st[m.id] = m.run(bars);
  const L = (id: string, i: number) => st[id][i] === "long";

  // 완충일 = 미너비니 이탈 + 와인스타인 생존 (v4는 여기서 50%, P1은 0%)
  const buf: { date: string; ret: number }[] = [];
  for (let i = 260; i < c.length - 1; i++) {
    if (L("minervini", i) || !L("weinstein", i)) continue;
    buf.push({ date: bars[i].date, ret: (c[i + 1] / c[i] - 1) * 100 });
  }
  const n = buf.length;
  const rets = buf.map(b => b.ret);
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = mean / se;

  // 부트스트랩: 평균이 0 이상일 확률 (P1이 나으려면 완충일 평균이 음수여야 함)
  let ge0 = 0;
  const IT = 20000;
  for (let k = 0; k < IT; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rets[Math.floor(rnd() * n)];
    if (s / n >= 0) ge0++;
  }

  console.log(`\n════ ${name} ════`);
  console.log(`  완충일(미너 이탈 & 와인 생존) ${n}일 / 전체 ${c.length - 261}일 (${Math.round((n / (c.length - 261)) * 100)}%)`);
  console.log(`  그 날들의 익일 수익률: 평균 ${s2(mean)}% · 표준편차 ${sd.toFixed(2)}% · t = ${t.toFixed(2)}`);
  console.log(`  부트스트랩 ${IT.toLocaleString()}회 — 평균이 0 이상일 확률 p = ${(ge0 / IT).toFixed(4)} ${ge0 / IT < 0.05 ? "→ 음수 유의 (P1 우위 근거 있음)" : ge0 / IT > 0.95 ? "→ 양수 유의 (v4 우위)" : "→ 유의하지 않음 (0과 구분 안 됨)"}`);
  console.log(`  누적 기여: v4가 이 날들에서 얻은 것 = 0.5 × ${s1(rets.reduce((a, b) => a + b, 0))}%p = ${s1(0.5 * rets.reduce((a, b) => a + b, 0))}%p (단순합)`);

  // ② 기간 안정성
  console.log(`  ── 기간별 완충일 평균 (부호가 유지되나) ──`);
  for (const [lb, from] of [["전체", 0], ["최근 3년", c.length - 744], ["최근 1년", c.length - 248], ["최근 3개월", c.length - 63]] as [string, number][]) {
    const g = buf.filter((_, idx) => {
      const di = bars.findIndex(b => b.date === buf[idx].date);
      return di >= from;
    });
    if (!g.length) { console.log(`     ${lb.padEnd(10)} 0일`); continue; }
    const m2 = g.reduce((a, b) => a + b.ret, 0) / g.length;
    console.log(`     ${lb.padEnd(10)} ${String(g.length).padStart(3)}일 · 평균 ${s2(m2)}% · 합 ${s1(g.reduce((a, b) => a + b.ret, 0))}%p`);
  }

  // ③ 소수의 날에 몰려 있나
  const sorted = rets.slice().sort((a, b) => a - b);
  const sumAll = rets.reduce((a, b) => a + b, 0);
  const sumEx5 = sorted.slice(5, sorted.length - 5).reduce((a, b) => a + b, 0);
  console.log(`  ── 집중도 ──`);
  console.log(`     전체 합 ${s1(sumAll)}%p · 상하위 5일씩 제거 후 ${s1(sumEx5)}%p · 최악일 ${sorted[0].toFixed(2)}% · 최고일 ${sorted[sorted.length - 1].toFixed(2)}%`);
  const worst5 = sorted.slice(0, 5).reduce((a, b) => a + b, 0);
  console.log(`     하위 5일 합 ${s1(worst5)}%p (전체의 ${Math.abs(sumAll) > 0 ? Math.round((worst5 / sumAll) * 100) : 0}%)`);
}

async function main() {
  await run("005930", "삼성전자");
  await run("000660", "SK하이닉스");
  console.log(`\n  ※ P1이 v4보다 나으려면 '완충일 익일 수익률 평균이 음수'여야 한다. 그 평균이 0과 구분되지 않으면`);
  console.log(`     누적 %p 차이는 표본 운일 수 있다. MDD 차이는 단일 경로라 별도 검정 불가 — 참고값.`);
}
main();
