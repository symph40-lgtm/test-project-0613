// 라이브 candleWindow 모듈 parity 검증 (가동 전 확인 2026-07-31):
//   npx tsx scripts/candle-window-parity.ts
// 라이브 모듈(candleJudgeStream·unitArr)을 백테스트와 동일한 227일 캐시에 돌려
// candle-window-judge.ts(고정눈금 0.5·전환=풀판정)의 수치와 일치하는지 대조.
// 기대값: 진입 110·전이 177·종가보유 +76.8%p·전환청산 +59.0%p·판정중앙 10:10.

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

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  let daysN = 0, entries = 0, transitions = 0, cuts = 0;
  let holdSum = 0, flipSum = 0;
  const firsts: number[] = [];
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
    firsts.push(tMin(bars[e.i].time));
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
  const srt = firsts.sort((a, b) => a - b);
  const med = srt[Math.floor(srt.length / 2)];
  console.log(`일수 ${daysN} · 진입 ${entries} (기대 110) · 전이 총 ${transitions} (기대 177) · 컷 ${cuts} (기대 ~28)`);
  console.log(`종가보유 합 ${holdSum.toFixed(1)}%p (기대 +76.8) · 전환청산 합 ${flipSum.toFixed(1)}%p (기대 +59.0)`);
  console.log(`판정중앙 ${String(Math.floor(med / 60)).padStart(2, "0")}:${String(med % 60).padStart(2, "0")} (기대 10:10)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
