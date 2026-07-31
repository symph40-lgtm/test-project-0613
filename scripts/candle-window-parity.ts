// 라이브 candleWindow 모듈 parity 검증 (가동 전 확인 2026-07-31 · 원창6 개정 반영):
//   npx tsx scripts/candle-window-parity.ts
// 라이브 모듈(candleJudgeStream·unitArr)을 백테스트와 동일한 227일 캐시에 돌려
// candle-window-judge.ts(고정눈금 0.5·개별조건 원창6·전환=풀판정)의 수치와 일치하는지 대조.
// 기대값: 진입 130·전이 216·종가보유 +83.4%p·전환청산 +60.5%p·판정중앙 09:53.
// + 판정 속도 비교 (사용자 질문 7/31): 피셔F(0.05·4봉·완충)·피셔M(0.10·8봉) 첫 판정 시각과 일자별 대조.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { candleJudgeStream, unitArr } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

// 피셔 기준선 (prog5-all-sweep.ts와 동일 상수) — 첫 판정 시각·방향·가격
type FirstJ = { i: number; t: number; dir: 1 | -1; px: number };
function fisherFirst(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, rev: number, emMult: number, emUntilMin: number): FirstJ | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = emUntilMin > 0 && tMin(b.time) < emUntilMin ? emMult : 1;
    const aUp = orH + off * r10 * em, aDn = orL - off * r10 * em, sbW = sb * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf);
    }
    if (up >= conf) return { i, t: tMin(b.time), dir: 1, px: b.close };
    if (dn >= conf) return { i, t: tMin(b.time), dir: -1, px: b.close };
  }
  return null;
}
// 극점 기준 (사용자 정의 7/31): 판정 이전 구간의 최저 저가(상승)/최고 고가(하락) = 레그 출발점
function fromExtreme(bars: MinuteBar[], j: FirstJ): { lagMin: number; consumedPct: number } {
  let bi = 0, bv = j.dir === 1 ? Infinity : -Infinity;
  for (let k = 0; k <= j.i; k++) {
    const v = j.dir === 1 ? bars[k].low : bars[k].high;
    if (j.dir === 1 ? v < bv : v > bv) { bv = v; bi = k; }
  }
  return {
    lagMin: j.t - tMin(bars[bi].time),
    consumedPct: (j.dir === 1 ? (j.px - bv) / bv : (bv - j.px) / bv) * 100,
  };
}
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  let daysN = 0, entries = 0, transitions = 0, cuts = 0;
  let holdSum = 0, flipSum = 0;
  const firsts: number[] = [];
  const leadF: number[] = [], leadM: number[] = []; // 창판정 - 피셔 (분, 음수 = 창이 빠름)
  type Ex = { lagMin: number; consumedPct: number };
  const exCw: Ex[] = [], exF: Ex[] = [], exM: Ex[] = [];
  let hhN = 0, hhCwFasterT = 0, hhCwFasterP = 0; // 동방향 맞대결: 극점→판정 시간/가격소모에서 창이 우세한 날
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    daysN++;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    transitions += trs.length;
    if (!trs.length) continue;
    const e = trs[0];
    entries++;
    const cwT = tMin(bars[e.i].time);
    firsts.push(cwT);
    const cwJ: FirstJ = { i: e.i, t: cwT, dir: e.to === "up" ? 1 : -1, px: e.px };
    const fJ = fisherFirst(bars, r10, 0.05, 4, 0.1, 3, 3, tMin("10:30"));
    const mJ = fisherFirst(bars, r10, 0.10, 8, 0, 3, 1.25, tMin("10:30"));
    if (fJ) leadF.push(cwT - fJ.t);
    if (mJ) leadM.push(cwT - mJ.t);
    const exC = fromExtreme(bars, cwJ);
    exCw.push(exC);
    if (fJ) exF.push(fromExtreme(bars, fJ));
    if (mJ) exM.push(fromExtreme(bars, mJ));
    if (fJ && fJ.dir === cwJ.dir) {
      const exFd = fromExtreme(bars, fJ);
      hhN++;
      if (exC.lagMin < exFd.lagMin) hhCwFasterT++;
      if (exC.consumedPct < exFd.consumedPct) hhCwFasterP++;
    }
    const sgn = e.to === "up" ? 1 : -1;
    const s = 2.5 / 100;
    let cutT: string | null = null;
    for (let k = e.i + 1; k < bars.length; k++) {
      const b = bars[k];
      if (e.to === "up" ? b.low <= e.px * (1 - s) : b.high >= e.px * (1 + s)) { cutT = b.time; break; }
    }
    const close = daily[i].close;
    const holdPnl = cutT ? -2.5 : ((close - e.px) / e.px) * 100 * sgn;
    if (cutT) cuts++;
    holdSum += holdPnl;
    const flip = trs.find((t) => t.i > e.i && t.to !== e.to);
    const cutBeforeFlip = cutT !== null && (!flip || tMin(cutT) <= tMin(bars[flip.i].time));
    const flipPnl = cutBeforeFlip ? -2.5 : flip ? ((flip.px - e.px) / e.px) * 100 * sgn : holdPnl;
    flipSum += flipPnl;
  }
  console.log(`일수 ${daysN} · 진입 ${entries} (기대 130) · 전이 총 ${transitions} (기대 216) · 컷 ${cuts} (기대 ~33)`);
  console.log(`종가보유 합 ${holdSum.toFixed(1)}%p (기대 +83.4) · 전환청산 합 ${flipSum.toFixed(1)}%p (기대 +60.5)`);
  console.log(`판정중앙 ${fmtT(med(firsts))} (기대 09:53)`);
  const speedLine = (name: string, lead: number[]) => {
    if (!lead.length) return;
    const faster = lead.filter((v) => v < 0).length;
    const avg = lead.reduce((a, b) => a + b, 0) / lead.length;
    console.log(`속도 vs ${name}: 동시판정 ${lead.length}일 — 창이 빠른 날 ${faster}일(${Math.round((100 * faster) / lead.length)}%) · 중앙 ${med(lead) >= 0 ? "+" : ""}${med(lead)}분 · 평균 ${avg >= 0 ? "+" : ""}${avg.toFixed(0)}분 (양수 = 창이 늦음)`);
  };
  speedLine("피셔F", leadF);
  speedLine("피셔M", leadM);
  // 극점(레그 출발점) 기준 — 상승은 판정 전 최저 저가, 하락은 최고 고가에서부터
  const exLine = (name: string, a: Ex[]) => {
    if (!a.length) return;
    const lag = a.map((x) => x.lagMin), con = a.map((x) => x.consumedPct);
    const avgC = con.reduce((x, y) => x + y, 0) / con.length;
    console.log(`극점→판정 ${name}: ${a.length}일 — 시간 중앙 ${med(lag)}분·평균 ${(lag.reduce((x, y) => x + y, 0) / lag.length).toFixed(0)}분 · 가격소모 중앙 ${med(con).toFixed(2)}%·평균 ${avgC.toFixed(2)}%`);
  };
  exLine("창판정", exCw);
  exLine("피셔F ", exF);
  exLine("피셔M ", exM);
  if (hhN) console.log(`동방향 맞대결 ${hhN}일: 극점→판정 시간 창 우세 ${hhCwFasterT}일(${Math.round((100 * hhCwFasterT) / hhN)}%) · 가격소모 창 우세 ${hhCwFasterP}일(${Math.round((100 * hhCwFasterP) / hhN)}%)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
