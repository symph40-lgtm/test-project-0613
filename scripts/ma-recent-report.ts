// 이평선 최근 상태 분석 (사용자 요청 2026-08-08 "이평선을 최근 7일·최근 1개월로 분석해봐"):
//   npx tsx scripts/ma-recent-report.ts
// 삼전·하닉·SOXX의 MA5/20/60/150 위치·기울기·배열·이격도를 최근 7거래일과 1개월(21거래일) 창으로 본다.
// 판정에 쓰는 값이 아니라 '지금 어디에 서 있나'를 읽기 위한 상태 요약 — 바닥 선별 실측(daily-swing-bottom-def)에서
// 이평 기반 정의가 반등을 유의하게 못 걸러낸다는 결론이 이미 나왔으므로, 예측이 아니라 현황으로 읽을 것.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
import { sma, atr14, type DailyBar } from "../lib/predict-daily/models";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const n0 = (x: number | null | undefined) => (x == null ? "—" : Math.round(x).toLocaleString());

function analyze(name: string, bars: DailyBar[]) {
  const c = bars.map(b => b.close);
  const ma5 = sma(c, 5), ma20 = sma(c, 20), ma60 = sma(c, 60), ma150 = sma(c, 150);
  const atr = atr14(bars);
  const i = c.length - 1;
  const gap = (v: number | null) => (v == null ? null : ((c[i] - v) / v) * 100);
  const slope = (a: (number | null)[], k: number) => (a[i] == null || a[i - k] == null ? null : ((a[i]! - a[i - k]!) / a[i - k]!) * 100);
  const arrange = (j: number) => {
    const [a, b, d] = [ma20[j], ma60[j], ma150[j]];
    if (a == null || b == null || d == null) return "—";
    if (a > b && b > d) return "정배열";
    if (a < b && b < d) return "역배열";
    return "혼조";
  };
  console.log(`\n════ ${name} — ${bars[i].date} 종가 ${n0(c[i])} ════`);
  console.log(`  현재 위치: MA5 ${n0(ma5[i])}(${s1(gap(ma5[i]) ?? 0)}%) · MA20 ${n0(ma20[i])}(${s1(gap(ma20[i]) ?? 0)}%) · MA60 ${n0(ma60[i])}(${s1(gap(ma60[i]) ?? 0)}%) · MA150 ${n0(ma150[i])}(${s1(gap(ma150[i]) ?? 0)}%)`);
  console.log(`  배열: ${arrange(i)} · ATR14 ${((atr[i] ?? 0) / c[i] * 100).toFixed(2)}%`);
  console.log(`  기울기: MA5 5일 ${s2(slope(ma5, 5) ?? 0)}% · MA20 5일 ${s2(slope(ma20, 5) ?? 0)}%·20일 ${s2(slope(ma20, 20) ?? 0)}% · MA60 20일 ${s2(slope(ma60, 20) ?? 0)}% · MA150 20일 ${s2(slope(ma150, 20) ?? 0)}%`);

  for (const [label, k] of [["최근 7거래일", 7], ["최근 1개월(21)", 21]] as [string, number][]) {
    const j = i - k;
    if (j < 150) continue;
    const g0 = (v: number | null, px: number) => (v == null ? null : ((px - v) / v) * 100);
    console.log(`  ── ${label} (${bars[j].date} → ${bars[i].date}) ──`);
    console.log(`    종가 ${n0(c[j])} → ${n0(c[i])} (${s1(((c[i] - c[j]) / c[j]) * 100)}%) · 배열 ${arrange(j)} → ${arrange(i)}`);
    console.log(`    MA20 대비 위치 ${s1(g0(ma20[j], c[j]) ?? 0)}% → ${s1(gap(ma20[i]) ?? 0)}% · MA60 대비 ${s1(g0(ma60[j], c[j]) ?? 0)}% → ${s1(gap(ma60[i]) ?? 0)}% · MA150 대비 ${s1(g0(ma150[j], c[j]) ?? 0)}% → ${s1(gap(ma150[i]) ?? 0)}%`);
    // 구간 내 이벤트: 종가의 이평 상향/하향 돌파
    const evs: string[] = [];
    for (let t = j + 1; t <= i; t++) {
      for (const [nm, a] of [["MA5", ma5], ["MA20", ma20], ["MA60", ma60], ["MA150", ma150]] as [string, (number | null)[]][]) {
        if (a[t] == null || a[t - 1] == null) continue;
        if (c[t - 1] <= a[t - 1]! && c[t] > a[t]!) evs.push(`${bars[t].date.slice(5)} ${nm}↑돌파`);
        if (c[t - 1] >= a[t - 1]! && c[t] < a[t]!) evs.push(`${bars[t].date.slice(5)} ${nm}↓이탈`);
      }
      // 이평 간 교차
      for (const [nm, a, b] of [["MA5×MA20", ma5, ma20], ["MA20×MA60", ma20, ma60]] as [string, (number | null)[], (number | null)[]][]) {
        if (a[t] == null || b[t] == null || a[t - 1] == null || b[t - 1] == null) continue;
        if (a[t - 1]! <= b[t - 1]! && a[t]! > b[t]!) evs.push(`${bars[t].date.slice(5)} ${nm} 골든`);
        if (a[t - 1]! >= b[t - 1]! && a[t]! < b[t]!) evs.push(`${bars[t].date.slice(5)} ${nm} 데드`);
      }
    }
    console.log(`    구간 이벤트: ${evs.length ? evs.join(" · ") : "없음"}`);
    // 이평 아래에서 마감한 일수
    let below20 = 0, below150 = 0;
    for (let t = j + 1; t <= i; t++) { if (ma20[t] != null && c[t] < ma20[t]!) below20++; if (ma150[t] != null && c[t] < ma150[t]!) below150++; }
    console.log(`    MA20 아래 마감 ${below20}/${k}일 · MA150 아래 마감 ${below150}/${k}일`);
  }
}

async function main() {
  analyze("삼성전자", await fetchDailyPredict("005930", 900));
  analyze("SK하이닉스", await fetchDailyPredict("000660", 900));
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const soxx: DailyBar[] = (r.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  analyze("SOXX", soxx);
}
main();
