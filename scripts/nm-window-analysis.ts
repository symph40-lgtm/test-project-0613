// 신모델 성능 창 분석 (사용자 지시 2026-08-06): ①전체 기간 vs 최근 1개월 ②|시가→종가| ≥5% 추세일 성능
//   npx tsx scripts/nm-window-analysis.ts
// 대상: 하이닉스 신사다리(simLadder — 서킷·갭 방어·레짐 포함, 0930 rebox 제외한 현행판) ·
//       삼성전자 v2(5봉·rebox F) · SOXX v2(주기준: rebox+보호+프리진입).
// 데이터: .predict-cache — 하닉·삼전 232일(~7/31)·SOXXM 246일(~8/5). r10·일봉은 캐시 자체에서 재구성.

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import { PREDICT_CONFIG } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

type DayP = { date: string; p: number; oc: number };

function report(name: string, rows: DayP[], lastFrom: string) {
  const sum = (a: DayP[]) => a.reduce((x, r) => x + r.p, 0);
  const recent = rows.filter((r) => r.date >= lastFrom);
  const t5 = rows.filter((r) => Math.abs(r.oc) >= 5);
  const t3 = rows.filter((r) => Math.abs(r.oc) >= 3);
  const rate = (a: DayP[]) => (a.length ? sum(a) / a.length : 0);
  console.log(`\n════ ${name} (${rows.length}일) ════`);
  console.log(`전체: ${s1(sum(rows))}%p · 일당 ${s2(rate(rows))}%`);
  console.log(`최근 1개월(${lastFrom}~, ${recent.length}일): ${s1(sum(recent))}%p · 일당 ${s2(rate(recent))}% (전체 일당 대비 ${s2(rate(recent) - rate(rows))})`);
  console.log(`|시가→종가|≥5% 추세일 ${t5.length}일: ${s1(sum(t5))}%p · 일당 ${s2(rate(t5))}% (전체 일당의 ${rate(rows) !== 0 ? (rate(t5) / rate(rows)).toFixed(1) : "-"}배)`);
  console.log(`|시가→종가|≥3% 참고 ${t3.length}일: ${s1(sum(t3))}%p · 일당 ${s2(rate(t3))}%`);
}

function loadDay(file: string): MinuteBar[] | null {
  const p = resolve(CACHE, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]) : null;
}

function krSeries(code: string, sim: (bars: MinuteBar[], hist: PredictDailyBar[], r10: number, prevCut2: boolean, close: number) => number): DayP[] {
  const files = readdirSync(CACHE).filter((f) => new RegExp(`^${code}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort();
  const dailyBuilt: PredictDailyBar[] = [];
  const out: DayP[] = [];
  const cuts: boolean[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = loadDay(f) ?? [];
    if (reg.length < 100) continue;
    const pre = loadDay(`${code}NX-${date}.json`) ?? [];
    const hist = dailyBuilt.slice(-120);
    const day: PredictDailyBar = {
      date, open: reg[0].open, close: reg[reg.length - 1].close,
      high: Math.max(...reg.map((b) => b.high)), low: Math.min(...reg.map((b) => b.low)), volume: 0,
    };
    if (hist.length >= 15) {
      const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
      const bars = [...pre, ...reg];
      const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
      const p = sim(bars, hist, r10, prevCut2, day.close);
      const oc = ((day.close - day.open) / day.open) * 100;
      out.push({ date, p: Math.round(p * 100) / 100, oc });
      cuts.push(p <= -2.4); // 컷 근사 (서킷 롤링용)
    }
    dailyBuilt.push(day);
  }
  return out;
}

async function main() {
  // ① 하이닉스 신사다리 (현행판 — 서킷 K3M2·갭≥4% 방어·레짐 분기 포함)
  const hx = krSeries("000660", (bars, hist, r10, prevCut2, close) => {
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const prevClose = hist[hist.length - 1].close;
    const reg0 = bars.find((b) => b.time >= "09:00");
    const gapBig = reg0 ? Math.abs(((reg0.open - prevClose) / prevClose) * 100) >= 4 : false;
    return simLadder(bars, r10, close, trs, prevCut2 || gapBig, isHighVolDay(hist)).pnl;
  });
  report("하이닉스 신사다리", hx, "2026-07-01");

  // ② 삼성전자 v2 (5봉 주기준·rebox F)
  const ss = krSeries("005930", (bars, hist, r10, _pc, close) => {
    const fTrs = bars.length >= 20 ? (runFisher({ date: "x", dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
    const fJ = fTrs.length && fIdx >= 0 ? { i: fIdx, t: hhmmToMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    return simV2(bars, r10, close, PREDICT_CONFIG.newModel.ssV2.tan, fJ, PREDICT_CONFIG.newModel.ssV2.win).pnl;
  });
  report("삼성전자 v2 (5봉·rebox)", ss, "2026-07-01");

  // ③ SOXX v2 주기준
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const soxxDaily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = soxxDaily.map((b) => b.date);
  const dBy = new Map(soxxDaily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const us: DayP[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = soxxDaily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 });
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const close = reg[reg.length - 1].close;
    const sc = scoreSoxxDay(raw, c1, fJ, close, nextOpen, true, true);
    us.push({ date, p: Math.round(sc.p * 100) / 100, oc: ((close - reg[0].open) / reg[0].open) * 100 });
  }
  report("SOXX v2 주기준", us, "2026-07-07");
}
main().catch((e) => { console.error(e); process.exit(1); });
