// MT 국면층 진단 — z·flat 분포와 국면 점유율이 상식과 맞는지 (백필 전 검산).
import { readFileSync } from "fs"; import { resolve } from "path";
try { for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
async function main() {
  const { fetchMtBars } = await import("../lib/mt/data");
  const { computePhase } = await import("../lib/mt/phase");
  for (const sym of ["005930", "KOSPI200"] as const) {
    const bars = await fetchMtBars(sym, 800);
    const tops: Record<string, number> = { S1: 0, S2: 0, S3: 0, S4: 0 };
    const zs: number[] = [];
    for (let i = 60; i < bars.length; i++) {
      const p = computePhase(bars, i);
      tops[p.top]++; if (p.inputs.z != null) zs.push(p.inputs.z);
    }
    const n = Object.values(tops).reduce((a, b) => a + b, 0);
    zs.sort((a, b) => a - b);
    const q = (x: number) => zs[Math.floor(zs.length * x)];
    console.log(`[${sym}] n=${n} 점유 S1 ${(tops.S1/n*100).toFixed(0)}% S2 ${(tops.S2/n*100).toFixed(0)}% S3 ${(tops.S3/n*100).toFixed(0)}% S4 ${(tops.S4/n*100).toFixed(0)}% | z 분위 5% ${q(0.05)?.toFixed(2)} 25% ${q(0.25)?.toFixed(2)} 50% ${q(0.5)?.toFixed(2)} 75% ${q(0.75)?.toFixed(2)} 95% ${q(0.95)?.toFixed(2)}`);
    for (const i of [bars.length - 1, bars.length - 30, bars.length - 90]) {
      const p = computePhase(bars, i);
      console.log(`  ${bars[i].date} ${p.top} P=${JSON.stringify(p.P)} in=${JSON.stringify(p.inputs)}`);
    }
  }
}
main();
