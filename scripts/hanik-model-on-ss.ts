// 하닉 확정 신모델(6봉 창판정+4단 사다리)을 삼전에 그대로 적용 (사용자 질문 2026-08-02 밤):
//   npx tsx scripts/hanik-model-on-ss.ts
// 라이브 simLadder(하닉 규칙 그대로: F30→진행성70→전진0.3/창동의100·창선행100·이견 청산+역진입·
// 레짐 분기 청산·스탑 본주 -2.5%·종가청산)와 candleJudgeStream(하닉 6봉 형태 스펙)을 삼전 분봉에 실행.
// F만 삼전 라이브 F(0.05·4봉·강돌파 0.075·완충×3·09:00 게이트)로 주입 — 삼전에서 그 모델이 돌아갈 모습 그대로.
// ⚠스탑 -2.5%는 하닉 값 (삼전 검증 스탑은 -1.5%) — 질문 취지대로 하닉 규칙 무수정 적용.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { runFisher, type FisherCfg } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const C = PREDICT_CONFIG;

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("005930", 500)).filter((b) => b.date < today);
  const F_SS: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  let n = 0, total = 0, worst = 0, cutDays = 0, cwDays = 0, fDays = 0;
  const byMon = new Map<string, number>();
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    n++;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10)); // 하닉 6봉 형태 스펙 그대로
    if (trs.length) cwDays++;
    const fOut = runFisher({ date: daily[i].date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, F_SS);
    const fTrs = fOut.transitions ?? [];
    const idx = new Map<string, number>();
    bars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });
    const fJ = fTrs.length && idx.has(fTrs[0].time)
      ? { t: tMin(fTrs[0].time), i: idx.get(fTrs[0].time)!, dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px }
      : null;
    if (fJ) fDays++;
    const hv = isHighVolDay(hist);
    const lad = simLadder(bars, r10, daily[i].close, trs, false, hv, fJ); // 하닉 규칙·스탑 -2.5 그대로
    total += lad.pnl;
    worst = Math.min(worst, lad.pnl);
    if (lad.cut) cutDays++;
    const mon = daily[i].date.slice(0, 7);
    byMon.set(mon, (byMon.get(mon) ?? 0) + lad.pnl);
  }
  console.log(`════ 하닉 확정 신모델을 삼전에 그대로 적용 — ${n}일 ════`);
  console.log(`합계 ${s1(total)}%p · 최악일 ${worst.toFixed(2)}% · 컷일 ${cutDays} · 창판정 ${cwDays}일 · F판정 ${fDays}일`);
  console.log(`(대조 — 같은 232일: 하닉 자신 +118.2 / 삼전 현행 계층 +82.1 / 삼전 v2(속도 창+F역진입) +101.2)`);
  console.log(`\n[월별]`);
  for (const [mon, v] of byMon) console.log(`${mon}: ${s1(v)}%p`);
}
main().catch((e) => { console.error(e); process.exit(1); });
