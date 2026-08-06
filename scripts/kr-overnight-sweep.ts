// 국장 1박(오버나이트) 사양 스윕 (사용자 지시 2026-08-06 "국장 1박 테스트 후 다음주 시범"):
//   npx tsx scripts/kr-overnight-sweep.ts
// 변형: ①기준=당일 종가청산(현행) ②비이견일 1박→익일 시가청산 ③비이견일 1박→익일 종가까지 보유+
//   밤 스탑(최근 3일 평균 일중폭×K, 익일 장중 판정 — 갭이 스탑 밖이면 시가 체결 = 미보호로 계상)
// 보완 배합: 신모델·계층 50:50 (전체/최근 1개월). 스탑 K = 0.5/0.75/1.0.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0,2),10)*60+parseInt(s.slice(3,5),10);

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };

function collect(code: string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length+1, code.length+11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length-1].close, high: Math.max(...reg.map(b=>b.high)), low: Math.min(...reg.map(b=>b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a,b)=>a+(b.high-b.low),0)/10, d });
    daily.push(d);
  }
  return out;
}

function analyze(name: string, days: Day[], isHx: boolean) {
  const cuts: boolean[] = [];
  type R = { date: string; base: number; dir: number; agree: boolean; ovnOpen: number; ovn3: Record<string, number>; hier: number };
  const rows: R[] = [];
  for (let n = 0; n < days.length; n++) {
    const D = days[n], next = days[n+1];
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const fT = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fT.length ? D.bars.findIndex(b => b.time === fT[0].time) : -1;
    const fJ = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1|-1, px: fT[0].px } : null;
    const prevClose = D.hist[D.hist.length-1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose)/prevClose)*100) >= 4;
    const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
    const base = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs, prevCut2 || gapBig, isHighVolDay(D.hist)).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, fJ, C.newModel.ssV2.win).pnl;
    cuts.push(base <= -2.4);
    const first = trs.length ? trs[0] : null;
    let dir = 0, agree = false;
    if (first) {
      dir = first.to === "up" ? 1 : -1;
      const fd = fJ ? fJ.dir : 0;
      agree = fd === 0 || (fd === dir && fJ!.t >= hm(D.bars[first.i].time));
    }
    // 1박: 종가→익일 시가 / 익일 종가까지 보유 + 밤스탑 K×최근3일 평균 일중폭%
    let ovnOpen = 0; const ovn3: Record<string, number> = {};
    if (first && agree && next && base > -2.4) {
      ovnOpen = ((next.d.open - D.d.close) / D.d.close) * 100 * dir;
      const rng3 = D.hist.slice(-3).reduce((a,b)=>a+((b.high-b.low)/b.close)*100,0)/3;
      for (const K of [0.5, 0.75, 1.0]) {
        const stop = rng3 * K;
        const entry = D.d.close;
        const stopPx = dir === 1 ? entry * (1 - stop/100) : entry * (1 + stop/100);
        // 익일 시가 갭이 스탑 밖이면 시가 체결(미보호), 아니면 장중 스탑/종가
        let p: number;
        if (dir === 1 ? next.d.open <= stopPx : next.d.open >= stopPx) p = ((next.d.open - entry)/entry)*100*dir;
        else {
          let hit = false;
          for (const b of next.reg) { if (dir === 1 ? b.low <= stopPx : b.high >= stopPx) { hit = true; break; } }
          p = hit ? -stop : ((next.d.close - entry)/entry)*100*dir;
        }
        ovn3["K"+K] = p;
      }
    }
    rows.push({ date: D.date, base, dir, agree, ovnOpen, ovn3, hier: 0 });
  }
  const sum = (a: R[], f: (r: R) => number) => a.reduce((x,r)=>x+f(r),0);
  const worst = (a: R[], f: (r: R) => number) => a.length ? Math.min(...a.map(f)) : 0;
  const jul = rows.filter(r => r.date >= "2026-07-01");
  const rep = (label: string, f: (r: R) => number) => {
    console.log(`  ${label.padEnd(26)}: 전체 ${s1(sum(rows,f))}%p (최악 ${worst(rows,f).toFixed(2)}) · 7월 ${s1(sum(jul,f))}%p (일당 ${s2(sum(jul,f)/Math.max(1,jul.length))})`);
  };
  const ovnN = rows.filter(r=>r.ovnOpen!==0).length;
  console.log(`\n════ ${name} (${rows.length}일 · 1박 자격 ${ovnN}일) ════`);
  rep("① 현행 당일청산", r => r.base);
  rep("② +비이견 1박(시가청산)", r => r.base + r.ovnOpen);
  for (const K of [0.5, 0.75, 1.0]) rep(`③ +1박→익일종가·스탑${K}×3일폭`, r => r.base + (r.ovn3["K"+K] ?? 0));
}

const hx = collect("000660"); analyze("하이닉스", hx, true);
const ss = collect("005930"); analyze("삼성전자", ss, false);
