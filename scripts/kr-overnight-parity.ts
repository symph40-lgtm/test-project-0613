// 국장 1박 라이브 구현 parity (배포 검증, 2026-08-08):
//   npx tsx scripts/kr-overnight-parity.ts
// 라이브가 쓰는 판정 경로·헬퍼(ovnWeight/ovnStopPct, 시행판 F cfg)를 그대로 호출해 217일을 재현하고,
// 확정 사양의 실측치(하닉 +192.2 / 삼전 +198.5%p·자격 68/125일)와 일치하는지 확인한다.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder, ovnWeight, ovnStopPct } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
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

// 라이브 하닉 1박이 쓰는 F (candleWindow.ts ⑥ 블록의 fCfgOvn과 동일)
function hxFisherOvn(D: Day): { t: number; dir: 1 | -1 } | null {
  const cfg = {
    offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes,
    strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes,
    earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until,
    confirmFromHHMM: C.confirmFromKr, ...C.newModel.rebox,
  };
  const tr = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, cfg).transitions ?? []) : [];
  return tr.length ? { t: hm(tr[0].time), dir: (tr[0].to === "up" ? 1 : -1) as 1 | -1 } : null;
}

function run(name: string, days: Day[], isHx: boolean, expTot: number, expN: number) {
  const cuts: boolean[] = [];
  let tot = 0, ovn = 0, n = 0, n100 = 0, jul = 0; const all: number[] = [];
  let stopSample = "";
  for (let i = 0; i < days.length; i++) {
    const D = days[i], next = days[i + 1];
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const ssF = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const ssIdx = ssF.length ? D.bars.findIndex(b => b.time === ssF[0].time) : -1;
    const ssJ = ssF.length && ssIdx >= 0 ? { i: ssIdx, t: hm(ssF[0].time), dir: (ssF[0].to === "up" ? 1 : -1) as 1 | -1, px: ssF[0].px } : null;
    const base = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs, defense, isHighVolDay(D.hist)).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, ssJ, C.newModel.ssV2.win).pnl;
    cuts.push(base <= -2.4);
    const first = trs.length ? trs[0] : null;
    const fJ = isHx ? hxFisherOvn(D) : (ssJ ? { t: ssJ.t, dir: ssJ.dir } : null);
    let leg = 0;
    if (first && next && base > -2.4 && fJ) {
      const dir = first.to === "up" ? 1 : -1;
      const t1 = hm(D.bars[first.i].time);
      // 삼전 라이브는 F 선행일(관망일) 제외 — 라이브 조건 미러
      const fLeadSkip = !isHx && fJ.t < t1;
      if (fJ.dir === dir && !fLeadSkip) {
        const w = ovnWeight(t1, gapBig);
        if (w === 1) n100++;
        n++;
        leg = ((next.d.open - D.d.close) / D.d.close) * 100 * dir * w;
        ovn += leg;
        if (!stopSample) stopSample = `스탑폭 예시 ${D.date}: ${ovnStopPct(D.hist).toFixed(2)}%`;
      }
    }
    tot += base + leg; all.push(base + leg);
    if (D.date >= "2026-07-01") jul += base + leg;
  }
  const ok = Math.abs(tot - expTot) < 0.15 && n === expN;
  console.log(`${ok ? "OK  " : "DIFF"} ${name}: 합계 ${s1(tot)}%p (기대 ${s1(expTot)}) · 1박 ${s1(ovn)} · 자격 ${n}일(기대 ${expN}, 100% ${n100}) · 최악 ${Math.min(...all).toFixed(2)} · 7월 ${s1(jul)} · ${stopSample}`);
}

run("하이닉스", collect("000660"), true, 192.2, 68);
run("삼성전자", collect("005930"), false, 198.5, 125);
