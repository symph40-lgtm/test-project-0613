// 삼전 신모델 라이브 모듈(ssV2.simV2) parity 검증 — 가동 전 확인 (2026-08-02 밤, 6봉+F rebox 개정판):
//   npx tsx scripts/ssv2-parity.ts
// 기대값: 6봉(주기준·F 0930 rebox) +112.8·컷일 84 (ss-f-rebox-sweep). 5봉/4봉/6봉·1.2의 rebox판은
// 본 스크립트가 최초 실측 — 결과를 채점 대조 기준으로 삼는다.

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
import { simV2, ssv2FisherCfg } from "../lib/predict/ssV2";
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
  const fCfg: FisherCfg = ssv2FisherCfg(); // 라이브와 동일 (0930 rebox 포함)
  let n = 0, s6 = 0, s5 = 0, s4 = 0, s12 = 0, cut6 = 0;
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
    const W = C.newModel.ssV2.win;
    const r6 = simV2(bars, r10, daily[i].close, C.newModel.ssV2.tan, fJ, W);
    const r5 = simV2(bars, r10, daily[i].close, C.newModel.ssV2.tan, fJ, 5);
    const r4 = simV2(bars, r10, daily[i].close, C.newModel.ssV2.tan, fJ, 4);
    const r12 = simV2(bars, r10, daily[i].close, C.newModel.ssV2.tanAlt, fJ, W);
    s6 += r6.pnl; s5 += r5.pnl; s4 += r4.pnl; s12 += r12.pnl;
    if (r6.cut) cut6++;
  }
  const f = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  console.log(`${n}일: 6봉(주기준·rebox F) ${f(s6)}%p (기대 +112.8)·컷일 ${cut6} (기대 84) · 5봉 ${f(s5)} · 4봉 ${f(s4)} · 6봉/1.2 ${f(s12)} (rebox판 신규 실측 — 채점 기준)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
