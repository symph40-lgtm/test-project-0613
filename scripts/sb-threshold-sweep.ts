// 강돌파 임계값 스윕 (사용자 지시 2026-07-25) — 삼전, 현행 0.10보다 작게 하면
// 발동 횟수·정확도가 어떻게 변하나. 전체 224일 + 전쟁후(2026-03-02~) 구간 분리.
//   npx tsx scripts/sb-threshold-sweep.ts [--symbol 005930] [--days 224]   (.predict-cache 전용)
//
// 적용처 2곳 (라이브 그대로):
//   ① 조기창 피셔F — 0.05·4봉, 08:00 연속창, 컷 10:30 (현행 sb 0.1)
//   ② 본판정 스트림 — 0.15·8봉·반전3, 09:00창, 컷 14:00 (현행 sb 0.1)
// 임계 sb ∈ {0(끔), 0.03, 0.05, 0.075, 0.10(현행), 0.15} × 10일평균폭.
// 지표: 발동일(sb=0 대비 판정·확인시각 변화), 방향판정수·방향적중(라벨 ±1.2%),
//       스탑 경제성(첫확인 봉 종가 진입·본주 -1.5% 스탑·종가 청산 누적).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { labelDay } from "../lib/predict/label";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const SYMBOL = (() => { const i = args.indexOf("--symbol"); return i >= 0 ? args[i + 1] : "005930"; })();
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const WAR_FROM = "2026-03-02"; // 전쟁후 구간 시작 (기존 스윕들과 동일 경계)
const SBS = [0, 0.03, 0.05, 0.075, 0.1, 0.15];
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");

const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const confirmOf = (r: string): string | null => r.match(/^(\d{2}:\d{2}) A[상하] 확인/)?.[1] ?? null;

type DayD = { date: string; war: boolean; label: Verdict; cont: MinuteBar[]; reg14: MinuteBar[]; full: MinuteBar[]; close: number; hist: PredictDailyBar[] };

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(SYMBOL, DAYS + 140)).filter((b) => b.date < today);
  const days: DayD[] = [];
  for (const bar of daily.slice(-DAYS)) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const reg = readCache(`${SYMBOL}-${bar.date}.json`);
    if (!reg || reg.length < 240) continue;
    const hist = daily.slice(Math.max(0, idx - 120), idx);
    if (avgRange(hist, 10) === null) continue;
    const pre = readCache(`${SYMBOL}NX-${bar.date}.json`) ?? [];
    days.push({
      date: bar.date, war: bar.date >= WAR_FROM, label: labelDay(bar).label,
      cont: [...pre, ...reg].filter((b) => b.time < "10:30"),
      reg14: reg.filter((b) => b.time < "14:00"),
      full: reg, close: bar.close, hist,
    });
  }
  console.log(`=== ${SYMBOL} 강돌파 임계값 스윕 — ${days.length}일 (전쟁후 ${days.filter((d) => d.war).length}일, ${WAR_FROM}~) ===`);

  const pnlStop = (d: DayD, confirmAt: string, v: Verdict): number | null => {
    if (v === "none") return null;
    const i = d.full.findIndex((b) => b.time === confirmAt);
    if (i < 0) return null;
    const entry = d.full[i].close;
    for (let j = i + 1; j < d.full.length; j++) {
      if (v === "leverage" && d.full[j].low <= entry * 0.985) return -1.5;
      if (v === "inverse" && d.full[j].high >= entry * 1.015) return -1.5;
    }
    return ((d.close - entry) / entry) * 100 * (v === "leverage" ? 1 : -1);
  };

  for (const [tierName, judge] of [
    ["① 조기창 피셔F (0.05·4봉·08창·~10:30)", (d: DayD, sb: number) =>
      runFisher({ date: d.date, dailyHistory: d.hist, openPx: d.cont[0]?.open ?? 0, morning: d.cont, prevDayMinutes: null },
        { offsetRangeRatio: 0.05, confirmMinutes: 4, strongBreakRatio: sb })],
    ["② 본판정 스트림 (0.15·8봉·반전3·09창·~14:00)", (d: DayD, sb: number) =>
      runFisher({ date: d.date, dailyHistory: d.hist, openPx: d.reg14[0]?.open ?? 0, morning: d.reg14, prevDayMinutes: null },
        { strongBreakRatio: sb, reversalMinutes: 3 })],
  ] as const) {
    console.log(`\n── ${tierName} ──`);
    console.log(`sb값   | 구간   | 발동일 | 방향판정 | 방향적중      | 스탑누적`);
    // sb=0 기준선 사전 계산
    const base = new Map<string, { v: Verdict; at: string | null }>();
    for (const d of days) {
      const o = judge(d, 0);
      base.set(d.date, { v: o.verdict, at: confirmOf(o.reason) });
    }
    for (const sb of SBS) {
      for (const war of [false, true]) {
        const sel = war ? days.filter((d) => d.war) : days;
        let fired = 0, dirT = 0, dirC = 0, pnl = 0;
        for (const d of sel) {
          const o = judge(d, sb);
          const at = confirmOf(o.reason);
          const b = base.get(d.date)!;
          if (sb > 0 && (o.verdict !== b.v || at !== b.at)) fired++;
          if (o.verdict !== "none") {
            dirT++;
            if (o.verdict === d.label) dirC++;
            if (at) pnl += pnlStop(d, at, o.verdict) ?? 0;
          }
        }
        const tag = sb === 0.1 ? `${sb}(현행)` : String(sb);
        console.log(`${tag.padEnd(7)}| ${(war ? "전쟁후" : "전체 ").padEnd(4)} | ${String(fired).padStart(4)}일 | ${String(dirT).padStart(6)}회 | ${String(dirC).padStart(3)}/${String(dirT).padEnd(3)} (${dirT ? Math.round((100 * dirC) / dirT) : 0}%) | ${(pnl >= 0 ? "+" : "") + pnl.toFixed(1)}%p`);
      }
    }
  }
  console.log(`\n주: 발동일 = sb=0 대비 판정 또는 확인시각이 달라진 날. 손익은 본주 %·첫확인 진입.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
