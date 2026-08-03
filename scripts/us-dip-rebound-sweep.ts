// SOXX 급락 후 반등 매수(딥 바이) 규칙 실측 (사용자 매매 재현 검증 2026-08-03):
//   npx tsx scripts/us-dip-rebound-sweep.ts
// 사용자 실제 매매: 7/23~29 -15% 급락 후 한국 아침(주간거래) 저점 매수 → 오버나이트 갭 포함 +25%(SOXL).
// 규칙화: "직전 k일 누적 낙폭 ≥ X%면 다음날 시가 매수, h일 보유 후 종가 청산" — 추세추종의 정반대 계열.
// 격자: k=3·5일 × X=8/10/12/15% × h=1/2/3일. 손절 없음(보유 짧음)·비용 0.07%×2 반영. 야후 10년 일봉.

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const RT = 0.0014; // 왕복 비용

async function main() {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 10 * 365 * 86400e3), interval: "1d" });
  const bars = (r.quotes ?? [])
    .filter((q): q is typeof q & { open: number; close: number } => q.open != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, close: q.close }));
  const n = bars.length;
  console.log(`════ SOXX 급락 후 반등 매수 격자 — ${n}일 (${bars[0]?.date}~${bars[n - 1]?.date}) · 진입 다음날 시가·비용 반영 ════`);
  for (const k of [3, 5]) {
    for (const X of [8, 10, 12, 15]) {
      const line: string[] = [];
      for (const h of [1, 2, 3]) {
        let cnt = 0, wins = 0, sum = 0, worst = 0;
        let cool = 0;
        for (let i = k; i < n - h - 1; i++) {
          if (cool > 0) { cool--; continue; }
          const drop = (bars[i].close / bars[i - k].close - 1) * 100;
          if (drop > -X) continue;
          const entry = bars[i + 1].open;
          const exit = bars[i + 1 + h - 1].close;
          const pnl = (exit / entry - 1 - RT) * 100;
          cnt++; sum += pnl; worst = Math.min(worst, pnl);
          if (pnl > 0) wins++;
          cool = h; // 보유 기간 중 중복 진입 방지
        }
        line.push(`${h}일 보유: ${cnt}회·승률 ${cnt ? Math.round((100 * wins) / cnt) : 0}%·합 ${s1(sum)}%·평균 ${cnt ? s1(sum / cnt) : "—"}%·최악 ${worst.toFixed(1)}%`);
      }
      console.log(`\n${k}일 낙폭 ≥${X}%:`);
      for (const l of line) console.log(`  ${l}`);
    }
  }
  console.log(`\n주: SOXL 실행 시 손익 ≈ ×3 (일별 근사). 낙폭·보유는 SOXX 기준. 오버나이트 갭 포함(시가 진입~종가 청산).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
