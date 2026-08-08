// 국장 1박 자격의 F 정의 정합성 점검 (구현 전 확인, 2026-08-08):
//   npx tsx scripts/kr-overnight-fcfg-check.ts
// 스윕(kr-overnight-sweep·consent·size-split)은 두 종목 모두 ssv2FisherCfg(강돌파 0.075+0930 rebox)로
// F를 계산했다. 하닉 라이브의 F는 ①시행판 = fCfg(강돌파 0.1)+rebox ②사다리 내부 미러 fisherFirstKr(rebox 없음).
// 자격일·성과가 정의별로 얼마나 갈리는지 확인 — 구현에 쓸 정의를 고르기 위한 실측.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder, fisherFirstKr } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };
function collect(code: string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d });
    daily.push(d);
  }
  return out;
}

type FJ = { t: number; dir: 1 | -1 } | null;
const days = collect("000660");
const defs: [string, (D: Day) => FJ][] = [
  ["A 스윕 정의(ssv2Cfg·0.075+rebox)", (D) => {
    const tr = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    return tr.length ? { t: hm(tr[0].time), dir: (tr[0].to === "up" ? 1 : -1) as 1 | -1 } : null;
  }],
  ["B 라이브 시행판(0.1+rebox)", (D) => {
    const cfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr, ...C.newModel.rebox };
    const tr = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, cfg).transitions ?? []) : [];
    return tr.length ? { t: hm(tr[0].time), dir: (tr[0].to === "up" ? 1 : -1) as 1 | -1 } : null;
  }],
  ["C 사다리 내부 미러(rebox 없음)", (D) => {
    const f = fisherFirstKr(D.bars, D.r10);
    return f ? { t: f.t, dir: f.dir } : null;
  }],
];

for (const [label, getF] of defs) {
  const cuts: boolean[] = [];
  let tot = 0, ovn = 0, n = 0, n100 = 0, worst = 0, jul = 0;
  const all: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const D = days[i], next = days[i + 1];
    const unitS = unitArr(D.bars, D.r10).map(u => u * C.newModel.cwUnitScale);
    const trs = candleJudgeStream(D.bars, unitS);
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const base = simLadder(D.bars, D.r10, D.d.close, trs, defense, isHighVolDay(D.hist)).pnl;
    cuts.push(base <= -2.4);
    const first = trs.length ? trs[0] : null;
    const fJ = getF(D);
    let leg = 0;
    if (first && next && base > -2.4 && fJ) {
      const dir = first.to === "up" ? 1 : -1;
      if (fJ.dir === dir) {
        const t1 = hm(D.bars[first.i].time);
        const w = t1 <= 600 && !gapBig ? 1 : 0.5;
        if (w === 1) n100++;
        n++;
        leg = ((next.d.open - D.d.close) / D.d.close) * 100 * dir * w;
        ovn += leg;
      }
    }
    tot += base + leg;
    all.push(base + leg);
    if (D.date >= "2026-07-01") jul += base + leg;
  }
  worst = Math.min(...all);
  console.log(`${label.padEnd(32)}: 합계 ${s1(tot)}%p (1박 ${s1(ovn)}) · 자격 ${n}일(100% ${n100}) · 최악 ${worst.toFixed(2)} · 7월 ${s1(jul)}`);
}
