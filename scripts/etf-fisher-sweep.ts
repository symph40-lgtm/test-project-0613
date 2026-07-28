// TIGER 반도체TOP10(396500) 피셔 판정 유용성 실측 (사용자 지시 2026-07-28 밤 — 국내판 SOXX 검토).
//   npx tsx scripts/etf-fisher-sweep.ts
// 제약: 396500은 NXT 프리장 미거래(실측) → 08시창 F/M 불성립. 3종목 모두 '09시창 본피셔 스트림'
// 단일 프레임으로 공정 비교 (동일 기간 = 396500 캐시 교집합 ~120일):
//   ① 396500 상수 스윕: sb {0, 0.05, 0.075, 0.1} × 트레일 {무, 0.3×3, 0.35×5, 0.5×3} × 스탑 {1.0, 1.5}
//   ② 대조군: 삼전(sb0.075·트레일0.3×3 고변동일)·하닉(sb0.1·트레일0.35×5 전일 — 7/28 확대 반영), 스탑 1.5
// 지표: 손익 합(전/후반)·스탑컷 횟수·전환수·판정발생일·첫 확인시각 중앙값 (사용자 가설 검증:
//   "ETF가 개별주보다 컷 덜 당하고 판정 후 변화가 덜 빠르다").

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const f1 = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);

type St = "up" | "down";
type Trans = { time: string; to: St; px: number };
function stream(bars: MinuteBar[], offW: number, confirm: number, reversal: number, sbW: number, trailW: number, trailN: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const out: Trans[] = [];
  let state: "none" | St = "none", up = 0, dn = 0, trailRun = 0, extreme = 0;
  for (const b of bars.slice(15)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - sbW) dn = Math.max(dn, confirm, reversal);
    }
    if (state === "none") {
      if (up >= confirm) { state = "up"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "up", px: b.close }); }
      else if (dn >= confirm) { state = "down"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "down", px: b.close }); }
      continue;
    }
    if (state === "up") {
      extreme = Math.max(extreme, b.close);
      trailRun = trailW > 0 && b.close < extreme - trailW ? trailRun + 1 : 0;
      if (dn >= reversal || (trailW > 0 && trailRun >= trailN)) { state = "down"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "down", px: b.close }); }
    } else {
      extreme = Math.min(extreme, b.close);
      trailRun = trailW > 0 && b.close > extreme + trailW ? trailRun + 1 : 0;
      if (up >= reversal || (trailW > 0 && trailRun >= trailN)) { state = "up"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "up", px: b.close }); }
    }
  }
  return out;
}

type DayD = { date: string; reg: MinuteBar[]; r10: number; close: number; hv: boolean; half: 0 | 1 };
async function loadDays(code: string, dates: Set<string> | null): Promise<DayD[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 400)).filter((b) => b.date <= today);
  const out: DayD[] = [];
  for (let i = 130; i < daily.length; i++) {
    const d = daily[i].date;
    if (dates && !dates.has(d)) continue;
    const reg = readCache(`${code}-${d}.json`);
    if (!reg || reg.length < 240) continue;
    const hist: PredictDailyBar[] = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (r10 === null) continue;
    out.push({ date: d, reg, r10, close: daily[i].close, hv: isHighVolDay(hist), half: 0 });
  }
  out.forEach((x, i) => { x.half = i < out.length / 2 ? 0 : 1; });
  return out;
}

type Res = { pnl: [number, number]; stops: number; flips: number; confDays: number; confTimes: number[] };
function evalCfg(days: DayD[], sb: number, trailR: number, trailN: number, stopPct: number, trailHvOnly: boolean): Res {
  const res: Res = { pnl: [0, 0], stops: 0, flips: 0, confDays: 0, confTimes: [] };
  for (const d of days) {
    const useTrail = trailR > 0 && (!trailHvOnly || d.hv);
    const tr = stream(d.reg, 0.15 * d.r10, 8, 3, sb * d.r10, useTrail ? trailR * d.r10 : 0, trailN);
    if (tr.length) { res.confDays++; res.confTimes.push(tMin(tr[0].time)); }
    res.flips += Math.max(0, tr.length - 1);
    let dayPnl = 0;
    for (let i = 0; i < tr.length; i++) {
      const entry = tr[i].px, dir = tr[i].to;
      const startT = tMin(tr[i].time), endT = i + 1 < tr.length ? tMin(tr[i + 1].time) : Infinity;
      let pnl: number | null = null;
      for (const b of d.reg) {
        const tm = tMin(b.time);
        if (tm <= startT) continue;
        if (tm >= endT) break;
        if (dir === "up" && b.low <= entry * (1 - stopPct / 100)) { pnl = -stopPct; res.stops++; break; }
        if (dir === "down" && b.high >= entry * (1 + stopPct / 100)) { pnl = -stopPct; res.stops++; break; }
      }
      if (pnl === null) {
        const exitPx = i + 1 < tr.length ? tr[i + 1].px : d.close;
        pnl = ((exitPx - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
      }
      dayPnl += pnl;
    }
    res.pnl[d.half] += dayPnl;
  }
  return res;
}

const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const hhmm = (m: number | null) => (m === null ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

async function main() {
  const etfDays = await loadDays("396500", null);
  const dateSet = new Set(etfDays.map((d) => d.date));
  const ssDays = await loadDays("005930", dateSet);
  const hxDays = await loadDays("000660", dateSet);
  console.log(`공통 기간: ${etfDays[0]?.date} ~ ${etfDays[etfDays.length - 1]?.date} · ETF ${etfDays.length}일 · 삼전 ${ssDays.length}일 · 하닉 ${hxDays.length}일`);

  const show = (tag: string, r: Res, n: number) =>
    console.log(`  ${tag.padEnd(26)} ${f1(r.pnl[0])} / ${f1(r.pnl[1])} (합 ${f1(r.pnl[0] + r.pnl[1])}) | 컷 ${String(r.stops).padStart(3)} (${(r.stops / n * 100).toFixed(0)}/100일) | 전환 ${String(r.flips).padStart(3)} | 판정 ${r.confDays}일 · 첫확인 중앙 ${hhmm(med(r.confTimes))}`);

  console.log(`\n■ 396500 상수 스윕 (09시창 본피셔 스트림 · 전/후반 손익 %p)`);
  for (const stop of [1.0, 1.5]) {
    console.log(` 스탑 -${stop.toFixed(1)}%:`);
    for (const sb of [0, 0.05, 0.075, 0.1]) {
      for (const t of [{ r: 0, n: 0, tag: "무트레일" }, { r: 0.3, n: 3, tag: "트레일0.3×3" }, { r: 0.35, n: 5, tag: "트레일0.35×5" }, { r: 0.5, n: 3, tag: "트레일0.5×3" }]) {
        show(`sb${sb}·${t.tag}`, evalCfg(etfDays, sb, t.r, t.n, stop, false), etfDays.length);
      }
    }
  }

  console.log(`\n■ 대조군 (현행 상수 · 동일 09시창 프레임 · 스탑 -1.5%)`);
  show(`삼전 sb0.075·트0.3×3(고변동)`, evalCfg(ssDays, 0.075, 0.3, 3, 1.5, true), ssDays.length);
  show(`하닉 sb0.1·트0.35×5(전일)`, evalCfg(hxDays, 0.1, 0.35, 5, 1.5, false), hxDays.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
