// 삼전 신모델 라이브 모듈(ssV2.simV2) parity 검증 — 가동 전 확인 (2026-08-02 밤):
//   npx tsx scripts/ssv2-parity.ts
// 기대값 (ss-cw4-hier-cases 백테스트): 창1.0 v2 +101.2%p · 1.2 +100.8%p (232일).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { runFisher, type FisherCfg } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { simV2 } from "../lib/predict/ssV2";
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
  const daily = (await fetchDailyPredict("005930", 500)).filter((b) => b.date < today);
  const C = PREDICT_CONFIG;
  const fCfg: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  let n = 0, s10 = 0, s12 = 0, cut10 = 0;
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    n++;
    const bars = [...(pre ?? []), ...reg];
    const fTrs = runFisher({ date: daily[i].date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, fCfg).transitions ?? [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    const fJ = fTrs.length && fIdx >= 0 ? { i: fIdx, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    const r1 = simV2(bars, r10, daily[i].close, C.newModel.ssV2.tan, fJ);
    const r2 = simV2(bars, r10, daily[i].close, C.newModel.ssV2.tanAlt, fJ);
    s10 += r1.pnl; s12 += r2.pnl;
    if (r1.cut) cut10++;
  }
  console.log(`${n}일: 창1.0 v2 ${s10 >= 0 ? "+" : ""}${s10.toFixed(1)}%p (기대 +101.2) · 1.2 ${s12 >= 0 ? "+" : ""}${s12.toFixed(1)}%p (기대 +100.8) · 컷일 ${cut10} (기대 99)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
