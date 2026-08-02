// 본피셔: 트레일 vs rebox 정면 비교 + 삼전 M rebox (사용자 지시 2026-08-02 밤):
//   npx tsx scripts/trail-vs-rebox-sweep.ts
// 가설: 트레일과 rebox는 같은 역할(낡은 박스의 오후 전환 감지 보완) — 겹치면 하나만 남기는 게 낫다.
// ① 하닉 본피셔(09창·sb0.1·C3·스탑 -2.5): {트레일만(현행)} {rebox만} {둘 다} {둘 다 없음} 4조합
//    — 트레일 = 0.35×5 전일 / rebox = 09:30~45박스@09:45(상태 승계, 라이브 옵션)
// ② 삼전 본피셔(09창·sb0.075·C3·스탑 -1.5): 동일 4조합 — 트레일 = 고변동일만 0.3×3(라이브 게이트)
// ③ 삼전 M(08연속창·0.10·8봉·완충×1.25·09:00게이트·스탑 -1.5): 현행 vs rebox — 하닉 M(+33.5)의 삼전판
// 채점: 레그 회계(전이=진입/전환·컷 후 다음 전이까지 관망·종가 청산) — or0930-live-sweep 관례.

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
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const fmtT = (m: number) => Number.isNaN(m) ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Trans = { time: string; to: "up" | "down"; px: number };
const C = PREDICT_CONFIG;
const REBOX = { reboxHHMM: "09:30", reboxMinutes: 15 };

function legPnl(bars: MinuteBar[], trs: Trans[], close: number, stop: number): { pnl: number; cuts: number; legs: number } {
  const idx = new Map<string, number>();
  bars.forEach((b, i) => { if (!idx.has(b.time)) idx.set(b.time, i); });
  const s = stop / 100;
  let pnl = 0, cuts = 0;
  for (let k = 0; k < trs.length; k++) {
    const t = trs[k];
    const i0 = idx.get(t.time);
    if (i0 === undefined) continue;
    const endI = k + 1 < trs.length ? idx.get(trs[k + 1].time) ?? bars.length : bars.length;
    const dir = t.to === "up" ? 1 : -1;
    let cut = false;
    for (let i = i0 + 1; i < endI; i++) {
      const b = bars[i];
      if (dir === 1 ? b.low <= t.px * (1 - s) : b.high >= t.px * (1 + s)) { cut = true; break; }
    }
    if (cut) { pnl += -stop; cuts++; continue; }
    pnl += (((k + 1 < trs.length ? trs[k + 1].px : close) - t.px) / t.px) * 100 * dir;
  }
  return { pnl, cuts, legs: trs.length };
}

type DayD = { date: string; bars: MinuteBar[]; reg: MinuteBar[]; r10: number; close: number; hist: PredictDailyBar[]; hv: boolean };
async function loadDays(code: string): Promise<DayD[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 500)).filter((b) => b.date < today);
  const out: DayD[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`${code}-${daily[i].date}.json`);
    const pre = rc(`${code}NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    out.push({ date: daily[i].date, bars: [...(pre ?? []), ...reg], reg, r10, close: daily[i].close, hist, hv: isHighVolDay(hist) });
  }
  return out;
}

function runCase(days: DayD[], label: string, stop: number, cfgOf: (d: DayD) => FisherCfg | null, barsOf: (d: DayD) => MinuteBar[]): void {
  let pnl = 0, cuts = 0, legs = 0, n = 0;
  const firsts: number[] = [];
  for (const d of days) {
    const cfg = cfgOf(d);
    if (!cfg) continue;
    const bb = barsOf(d);
    if (bb.length < 20) continue;
    const trs = runFisher({ date: d.date, dailyHistory: d.hist, openPx: bb[0].open, morning: bb, prevDayMinutes: null }, cfg).transitions ?? [];
    if (trs.length) { n++; firsts.push(tMin(trs[0].time)); }
    const r = legPnl(bb, trs, d.close, stop);
    pnl += r.pnl; cuts += r.cuts; legs += r.legs;
  }
  console.log(`${label}: ${s1(pnl)}%p · 레그 ${legs}·컷 ${cuts} · 판정 ${n}일 · 첫확인 ${fmtT(med(firsts))}`);
}

async function main() {
  const hx = await loadDays("000660");
  const ss = await loadDays("005930");

  console.log(`════ ① 하닉 본피셔 — 트레일 vs rebox 4조합 (${hx.length}일·스탑 -2.5) ════`);
  const hxTrail = { trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes };
  const hxBase: FisherCfg = { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes };
  runCase(hx, "트레일만 (현행)      ", 2.5, () => ({ ...hxBase, ...hxTrail }), (d) => d.reg);
  runCase(hx, "rebox만 (트레일 제거) ", 2.5, () => ({ ...hxBase, ...REBOX }), (d) => d.reg);
  runCase(hx, "둘 다                ", 2.5, () => ({ ...hxBase, ...hxTrail, ...REBOX }), (d) => d.reg);
  runCase(hx, "둘 다 없음            ", 2.5, () => hxBase, (d) => d.reg);

  console.log(`\n════ ② 삼전 본피셔 — 동일 4조합 (${ss.length}일·스탑 -1.5·트레일=고변동일만) ════`);
  const ssBase: FisherCfg = { strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes };
  const ssTrailOf = (d: DayD) => (d.hv ? { trailRangeRatio: C.ssTrail.rangeRatio, trailConfirmMinutes: C.ssTrail.confirmMinutes } : {});
  runCase(ss, "트레일만 (현행)      ", 1.5, (d) => ({ ...ssBase, ...ssTrailOf(d) }), (d) => d.reg);
  runCase(ss, "rebox만 (트레일 제거) ", 1.5, () => ({ ...ssBase, ...REBOX }), (d) => d.reg);
  runCase(ss, "둘 다                ", 1.5, (d) => ({ ...ssBase, ...ssTrailOf(d), ...REBOX }), (d) => d.reg);
  runCase(ss, "둘 다 없음            ", 1.5, () => ssBase, (d) => d.reg);

  console.log(`\n════ ③ 삼전 M — rebox (${ss.length}일·스탑 -1.5·08연속창) ════`);
  const ssM: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  runCase(ss, "M 현행 (08 OR 고정)  ", 1.5, () => ssM, (d) => d.bars);
  runCase(ss, "M + rebox            ", 1.5, () => ({ ...ssM, ...REBOX }), (d) => d.bars);
  console.log(`(참고 — 하닉 M 동일 실측: +80.1 → +113.5)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
