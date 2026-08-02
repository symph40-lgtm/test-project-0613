// 삼전 v2 — 13시 재확인 게이트 실측 (사용자 제안 2026-08-02 밤):
//   npx tsx scripts/ss-13h-gate-sweep.ts
// 규칙안: 13:00 시점에 ①F 미확인(침묵 지속) ②포지션 보유 중이면 —
//   R1) 진입 후 13:00 이전에 창 원조건(6봉 누적 전진 ≥ 눈금×5)이 같은 방향으로 재점화한 적 있으면 유지,
//       없으면 13:00 종가 매도 (이후 F 반대 확인 시 역진입은 유지, 동의 확인은 재진입 없음)
//   R0) 재점화 무관 무조건 13:00 매도 (대조)
// 기준: 현행 v2 (6봉·1.0 창 + F 0930 rebox 첫확인 심판) = +112.8%p/232일.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { unitArr } from "../lib/predict/candleWindow";
import { cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Dir = 1 | -1;
const STOP = 1.5;
const C = PREDICT_CONFIG;
const GATE = tMin("13:00");

function tranche(bars: MinuteBar[], close: number, i0: number, dir: Dir, px: number, size: number, forceI?: number, forcePx?: number): { pnl: number; cut: boolean } {
  if (size <= 0) return { pnl: 0, cut: false };
  const s = STOP / 100;
  const lim = forceI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return { pnl: -STOP * size, cut: true };
  }
  const px2 = forceI !== undefined ? (forcePx ?? close) : close;
  return { pnl: ((px2 - px) / px) * 100 * dir * size, cut: false };
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("005930", 500)).filter((b) => b.date < today);
  let n = 0, base = 0, r1 = 0, r0 = 0;
  let gateDays = 0, refireDays = 0, exitDays = 0, exitSaved = 0;
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist: PredictDailyBar[] = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    n++;
    const bars = [...(pre ?? []), ...reg];
    const close = daily[i].close;
    const unit = unitArr(bars, r10);
    const trs = cumStream(bars, unit, C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const cw = trs.length ? { i: trs[0].i, t: tMin(bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px } : null;
    const fTrs = runFisher({ date: daily[i].date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    const fJ = fTrs.length && fIdx >= 0 ? { i: fIdx, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as Dir, px: fTrs[0].px } : null;

    const calc = (mode: "base" | "r1" | "r0"): number => {
      if (!cw || (fJ && fJ.t < cw.t)) return 0; // 무판정·F선행 관망 (동일)
      const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
      const fLate = !fJ || fJ.t >= GATE; // 13:00 시점 F 미확인
      let exitI: number | undefined, exitPx: number | undefined;
      if (fOpp) { exitI = fOpp.i; exitPx = fOpp.px; }
      if (mode !== "base" && fLate) {
        // 13:00 게이트 검사 — R1은 재점화 있으면 면제
        let refire = false;
        if (mode === "r1") {
          const w = C.newModel.ssV2.win - 1;
          for (let k = cw.i + 1; k < bars.length; k++) {
            const tm = tMin(bars[k].time);
            if (tm >= GATE) break;
            if (k >= w && (bmid(bars[k]) - bmid(bars[k - w])) * cw.dir >= C.newModel.ssV2.tan * unit[k - w] * w) { refire = true; break; }
          }
        }
        if (!refire) {
          // 13:00 매도 — F 반대가 그보다 먼저면 기존 전환이 우선
          let gI = bars.findIndex((b) => tMin(b.time) >= GATE);
          if (gI < 0) gI = bars.length - 1;
          if (exitI === undefined || gI < exitI) { exitI = gI; exitPx = bars[gI].close; }
        }
      }
      let p = tranche(bars, close, cw.i, cw.dir, cw.px, 1.0, exitI, exitPx).pnl;
      if (fOpp) p += tranche(bars, close, fOpp.i, fOpp.dir, fOpp.px, 1.0).pnl;
      return p;
    };
    const b = calc("base");
    base += b;
    r1 += calc("r1");
    r0 += calc("r0");
    // 통계
    if (cw && !(fJ && fJ.t < cw.t) && (!fJ || fJ.t >= GATE)) {
      gateDays++;
      const w = C.newModel.ssV2.win - 1;
      let refire = false;
      for (let k = cw.i + 1; k < bars.length; k++) {
        const tm = tMin(bars[k].time);
        if (tm >= GATE) break;
        if (k >= w && (bmid(bars[k]) - bmid(bars[k - w])) * cw.dir >= C.newModel.ssV2.tan * unit[k - w] * w) { refire = true; break; }
      }
      if (refire) refireDays++;
      else { exitDays++; exitSaved += calc("r1") - b; }
    }
  }
  console.log(`════ 13시 재확인 게이트 — ${n}일 (기준 v2 = 6봉·1.0 + F rebox) ════`);
  console.log(`기준 v2:              ${s1(base)}%p`);
  console.log(`R1 재점화 없으면 매도: ${s1(r1)}%p (Δ ${s1(r1 - base)})`);
  console.log(`R0 무조건 13시 매도:   ${s1(r0)}%p (Δ ${s1(r0 - base)})`);
  console.log(`게이트 해당일(13시 F 미확인): ${gateDays}일 — 재점화 유지 ${refireDays}일 · 매도 실행 ${exitDays}일(매도 효과 ${s1(exitSaved)}%p)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
