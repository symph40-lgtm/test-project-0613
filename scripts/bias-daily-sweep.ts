// 실험 B — 편향축(간밤 매크로 정렬)의 일봉(익일) 예측력 실측 (사용자 승인 2026-07-26).
//   npx tsx scripts/bias-daily-sweep.ts
//
// M7 축1 그대로 (m7proxy.ts): 간밤 SOX ±0.5% → ±2표 · 환율(USDKRW) ±0.3% → ∓1표 ·
// 미10Y ±0.03%p → ∓1표. 점수 -4~+4. 질문: 이 점수가 다음 한국 거래일의
// ①시가→종가(rOC) ②종가→종가 방향을 예측하는가 — 일봉 스윙 레이어의 보완 게이트 후보 판단.
// 데이터: 야후 ^SOX·KRW=X·^TNX 일봉 2년 + 네이버 삼전·하닉 일봉 (fetchDailyPredict).

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";

const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

async function fetchDailyYf(sym: string, days: number): Promise<{ date: string; close: number }[]> {
  const r = await yf.chart(sym, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((q): q is typeof q & { close: number } => q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), close: q.close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function chgSeries(rows: { date: string; close: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) m.set(rows[i].date, ((rows[i].close - rows[i - 1].close) / rows[i - 1].close) * 100);
  return m;
}

async function main() {
  const [sox, fx, tnx] = await Promise.all([fetchDailyYf("^SOX", 800), fetchDailyYf("KRW=X", 800), fetchDailyYf("^TNX", 800)]);
  const soxChg = chgSeries(sox);
  const fxChg = chgSeries(fx);
  const tnxPp = new Map<string, number>();
  for (let i = 1; i < tnx.length; i++) tnxPp.set(tnx[i].date, (tnx[i].close - tnx[i - 1].close) / 10);
  const lastUsBefore = (d: string): string | null => {
    for (let i = sox.length - 1; i >= 1; i--) if (sox[i].date < d) return sox[i].date;
    return null;
  };

  for (const [code, name] of [["005930", "삼전"], ["000660", "하닉"]] as const) {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const daily = (await fetchDailyPredict(code, 520)).filter((b) => b.date < today);
    type Row = { score: number; rocUp: boolean | null; ccUp: boolean | null; roc: number };
    const rows: Row[] = [];
    for (let i = 1; i < daily.length; i++) {
      const d = daily[i];
      const us = lastUsBefore(d.date);
      if (!us) continue;
      const s = soxChg.get(us), f = fxChg.get(us), t = tnxPp.get(us);
      if (s === undefined) continue;
      let score = 0;
      if (s >= 0.5) score += 2; else if (s <= -0.5) score -= 2;
      if (f !== undefined) { if (f >= 0.3) score -= 1; else if (f <= -0.3) score += 1; }
      if (t !== undefined) { if (t >= 0.03) score -= 1; else if (t <= -0.03) score += 1; }
      const roc = ((d.close - d.open) / d.open) * 100;
      const cc = ((d.close - daily[i - 1].close) / daily[i - 1].close) * 100;
      rows.push({ score, rocUp: Math.abs(roc) < 1e-9 ? null : roc > 0, ccUp: Math.abs(cc) < 1e-9 ? null : cc > 0, roc });
    }
    console.log(`\n════ ${name} — ${rows.length}일 (편향축 점수별 다음날) ════`);
    const buckets: [string, (s: number) => boolean][] = [
      ["강상방(≥+2)", (s) => s >= 2], ["약상방(+1)", (s) => s === 1], ["중립(0)", (s) => s === 0],
      ["약하방(-1)", (s) => s === -1], ["강하방(≤-2)", (s) => s <= -2],
    ];
    for (const [lb, fn] of buckets) {
      const a = rows.filter((r) => fn(r.score));
      const rU = a.filter((r) => r.rocUp === true).length, rN = a.filter((r) => r.rocUp !== null).length;
      const cU = a.filter((r) => r.ccUp === true).length, cN = a.filter((r) => r.ccUp !== null).length;
      const avgRoc = a.length ? a.reduce((s, r) => s + r.roc, 0) / a.length : 0;
      console.log(`  ${lb}: ${a.length}일 — 시→종 상승 ${rN ? Math.round((100 * rU) / rN) : 0}% · 종→종 상승 ${cN ? Math.round((100 * cU) / cN) : 0}% · rOC 평균 ${avgRoc >= 0 ? "+" : ""}${avgRoc.toFixed(2)}%`);
    }
    const all = rows.filter((r) => r.rocUp !== null);
    console.log(`  기준선: 시→종 상승 ${Math.round((100 * all.filter((r) => r.rocUp).length) / all.length)}% · 종→종 상승 ${Math.round((100 * rows.filter((r) => r.ccUp === true).length) / rows.filter((r) => r.ccUp !== null).length)}% (전체 ${rows.length}일)`);
    // 방향 배팅 정확도: 점수 부호대로 익일 방향을 맞힌 비율 (0점 제외)
    for (const [tg, get] of [["시→종", (r: Row) => r.rocUp], ["종→종", (r: Row) => r.ccUp]] as const) {
      const bet = rows.filter((r) => r.score !== 0 && get(r) !== null);
      const hit = bet.filter((r) => (r.score > 0) === get(r)).length;
      const strong = rows.filter((r) => Math.abs(r.score) >= 2 && get(r) !== null);
      const sHit = strong.filter((r) => (r.score > 0) === get(r)).length;
      console.log(`  방향 배팅(${tg}): 전체 ${hit}/${bet.length} = ${Math.round((100 * hit) / bet.length)}% · 강신호(|점수|≥2) ${sHit}/${strong.length} = ${strong.length ? Math.round((100 * sHit) / strong.length) : 0}%`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
