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

// 피셔 기준선 (prog5-all-sweep.ts와 동일 상수) — 첫 판정 시각 비교용
function fisherFirst(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, rev: number, emMult: number, emUntilMin: number): number | null {
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
    if (up >= conf || dn >= conf) return tMin(b.time);
  }
  return null;
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
    const fT = fisherFirst(bars, r10, 0.05, 4, 0.1, 3, 3, tMin("10:30"));
    const mT = fisherFirst(bars, r10, 0.10, 8, 0, 3, 1.25, tMin("10:30"));
    if (fT !== null) leadF.push(cwT - fT);
    if (mT !== null) leadM.push(cwT - mT);
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
}
main().catch((e) => { console.error(e); process.exit(1); });
