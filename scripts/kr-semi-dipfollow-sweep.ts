// SOXX 딥바이 신호로 '한국 반도체'를 사면? (사용자 질문 2026-08-03):
//   npx tsx scripts/kr-semi-dipfollow-sweep.ts
// 신호: SOXX 5일 종가 누적 낙폭 ≥15% (미국 마감 = 한국 새벽 확정 — 딥바이 문자와 동일).
// 실행: 같은 날 아침 한국장 시가에 하닉/삼전 매수 → 1·2·3일 보유 종가 청산 (D+1 = 신호 다음 한국 거래일).
// 대조: 같은 신호로 SOXX 익일 시가 1일 보유(원 실측 +5.8%·8회). 비용 국장 0.01%×2.

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const RT = 0.0002;

async function main() {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 10 * 365 * 86400e3), interval: "1d" });
  const soxx = (r.quotes ?? [])
    .filter((q): q is typeof q & { close: number } => q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), close: q.close }));
  // 신호일 (ET 날짜) — 5일 누적 ≤ -15%
  const signals: string[] = [];
  for (let i = 5; i < soxx.length; i++) {
    if ((soxx[i].close / soxx[i - 5].close - 1) * 100 <= -15) {
      if (signals.length && signals[signals.length - 1] >= soxx[Math.max(0, i - 3)].date) continue; // 3일 내 중복 제거
      signals.push(soxx[i].date);
    }
  }
  console.log(`SOXX 딥 신호일(중복 제거): ${signals.length}회 — ${signals.join(", ")}`);

  for (const code of ["000660", "005930"]) {
    const kr = (await fetchDailyPredict(code, 2600));
    const name = code === "000660" ? "하닉" : "삼전";
    console.log(`\n[${name} — 신호 다음 한국 거래일 시가 매수]`);
    for (const h of [1, 2, 3]) {
      let cnt = 0, wins = 0, sum = 0, worst = 0;
      for (const sig of signals) {
        const idx = kr.findIndex((b) => b.date > sig); // 신호(ET) 다음 한국 거래일
        if (idx < 0 || idx + h - 1 >= kr.length) continue;
        const entry = kr[idx].open;
        const exit = kr[idx + h - 1].close;
        if (!entry || !exit) continue;
        const pnl = (exit / entry - 1 - RT) * 100;
        cnt++; sum += pnl; worst = Math.min(worst, pnl);
        if (pnl > 0) wins++;
      }
      console.log(`  ${h}일 보유: ${cnt}회 · 승률 ${cnt ? Math.round((100 * wins) / cnt) : 0}% · 합 ${s1(sum)}% · 평균 ${cnt ? s1(sum / cnt) : "—"}% · 최악 ${worst.toFixed(1)}%`);
    }
  }
  console.log(`\n주: 한국 반도체는 미국 급락을 '같은 날 아침 갭다운'으로 먼저 반영하는 경향 — 원 실측(SOXX 익일 +5.8%·승률 100%)과 직접 비교용.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
