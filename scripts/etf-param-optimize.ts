// 396500 피셔 전 축 최적화 (사용자 지시 2026-07-28 밤 — "오프셋·봉수·반전·트레일 등 ETF에 최적화"):
//   npx tsx scripts/etf-param-optimize.ts
// 방식: 다중비교 방어를 위해 전 격자 대신 축별 순차 스윕 — 기준점(개별주 이식값 + 1차 스윕 최적
// sb0.075·트레일0.5×3·스탑1.5)에서 한 축씩 훑고, 최종 조합은 이웃 격자·4분기 안정성으로 재검.
// ① 본피셔: OR분·오프셋·확인봉·반전봉·sb·트레일·스탑  ② F단(09시창): 오프셋·확인봉
// ③ M단: 오프셋·확인봉. 지표: 손익 합(전/후반)·컷·전환·첫확인 중앙.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
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
const hhmm = (m: number | null) => (m === null ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

type Cfg = { orN: number; off: number; conf: number; rev: number; sb: number; trailR: number; trailN: number; stop: number };
type St = "up" | "down";
type Trans = { time: string; to: St; px: number };
function stream(bars: MinuteBar[], r10: number, c: Cfg): Trans[] {
  if (bars.length < c.orN + 1) return [];
  const or = bars.slice(0, c.orN);
  const aUp = Math.max(...or.map((b) => b.high)) + c.off * r10;
  const aDn = Math.min(...or.map((b) => b.low)) - c.off * r10;
  const sbW = c.sb * r10, trailW = c.trailR * r10;
  const out: Trans[] = [];
  let state: "none" | St = "none", up = 0, dn = 0, trailRun = 0, extreme = 0;
  for (const b of bars.slice(c.orN)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, c.conf, c.rev);
      if (b.close < aDn - sbW) dn = Math.max(dn, c.conf, c.rev);
    }
    if (state === "none") {
      if (up >= c.conf) { state = "up"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "up", px: b.close }); }
      else if (dn >= c.conf) { state = "down"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "down", px: b.close }); }
      continue;
    }
    if (state === "up") {
      extreme = Math.max(extreme, b.close);
      trailRun = trailW > 0 && b.close < extreme - trailW ? trailRun + 1 : 0;
      if (dn >= c.rev || (trailW > 0 && trailRun >= c.trailN)) { state = "down"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "down", px: b.close }); }
    } else {
      extreme = Math.min(extreme, b.close);
      trailRun = trailW > 0 && b.close > extreme + trailW ? trailRun + 1 : 0;
      if (up >= c.rev || (trailW > 0 && trailRun >= c.trailN)) { state = "up"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "up", px: b.close }); }
    }
  }
  return out;
}

type DayD = { date: string; reg: MinuteBar[]; r10: number; close: number; half: 0 | 1; q: number };
type Res = { pnl: [number, number]; qs: number[]; stops: number; flips: number; confT: number[] };
function evalCfg(days: DayD[], c: Cfg): Res {
  const r: Res = { pnl: [0, 0], qs: [0, 0, 0, 0], stops: 0, flips: 0, confT: [] };
  for (const d of days) {
    const tr = stream(d.reg, d.r10, c);
    if (tr.length) r.confT.push(tMin(tr[0].time));
    r.flips += Math.max(0, tr.length - 1);
    let pnlD = 0;
    for (let i = 0; i < tr.length; i++) {
      const entry = tr[i].px, dir = tr[i].to;
      const startT = tMin(tr[i].time), endT = i + 1 < tr.length ? tMin(tr[i + 1].time) : Infinity;
      let pnl: number | null = null;
      for (const b of d.reg) {
        const tm = tMin(b.time);
        if (tm <= startT) continue;
        if (tm >= endT) break;
        if (dir === "up" && b.low <= entry * (1 - c.stop / 100)) { pnl = -c.stop; r.stops++; break; }
        if (dir === "down" && b.high >= entry * (1 + c.stop / 100)) { pnl = -c.stop; r.stops++; break; }
      }
      if (pnl === null) {
        const exitPx = i + 1 < tr.length ? tr[i + 1].px : d.close;
        pnl = ((exitPx - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
      }
      pnlD += pnl;
    }
    r.pnl[d.half] += pnlD;
    r.qs[d.q] += pnlD;
  }
  return r;
}

const show = (tag: string, r: Res, n: number) =>
  console.log(`  ${tag.padEnd(24)} ${f1(r.pnl[0])} / ${f1(r.pnl[1])} (합 ${f1(r.pnl[0] + r.pnl[1])}) | 컷 ${String(r.stops).padStart(3)} | 전환 ${String(r.flips).padStart(3)} | 첫확인 ${hhmm(med(r.confT))} | ${r.confT.length}/${n}일`);

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("396500", 400)).filter((b) => b.date <= today);
  const days: DayD[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = readCache(`396500-${daily[i].date}.json`);
    if (!reg || reg.length < 240) continue;
    const hist: PredictDailyBar[] = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (r10 === null) continue;
    days.push({ date: daily[i].date, reg, r10, close: daily[i].close, half: 0, q: 0 });
  }
  days.forEach((d, i) => { d.half = i < days.length / 2 ? 0 : 1; d.q = Math.min(3, Math.floor((4 * i) / days.length)); });
  console.log(`396500 ${days[0]?.date} ~ ${days[days.length - 1]?.date} · ${days.length}일`);

  const base: Cfg = { orN: 15, off: 0.15, conf: 8, rev: 3, sb: 0.075, trailR: 0.5, trailN: 3, stop: 1.5 };

  console.log(`\n■ 본피셔 축별 스윕 (기준: OR15·off0.15·확인8·반전3·sb0.075·트레일0.5×3·스탑1.5)`);
  console.log(` [OR 길이]`);
  for (const orN of [10, 15, 20]) show(`OR${orN}분`, evalCfg(days, { ...base, orN }), days.length);
  console.log(` [오프셋]`);
  for (const off of [0.10, 0.125, 0.15, 0.175, 0.20]) show(`off${off}`, evalCfg(days, { ...base, off }), days.length);
  console.log(` [확인봉]`);
  for (const conf of [5, 6, 8, 10]) show(`확인${conf}봉`, evalCfg(days, { ...base, conf }), days.length);
  console.log(` [반전봉]`);
  for (const rev of [2, 3, 4, 5]) show(`반전${rev}봉`, evalCfg(days, { ...base, rev }), days.length);
  console.log(` [트레일]`);
  for (const t of [{ r: 0, n: 0 }, { r: 0.4, n: 3 }, { r: 0.5, n: 3 }, { r: 0.6, n: 3 }, { r: 0.4, n: 5 }, { r: 0.5, n: 5 }])
    show(t.r ? `트레일${t.r}×${t.n}` : "무트레일", evalCfg(days, { ...base, trailR: t.r, trailN: t.n }), days.length);
  console.log(` [스탑]`);
  for (const stop of [1.0, 1.25, 1.5, 2.0]) show(`스탑${stop}%`, evalCfg(days, { ...base, stop }), days.length);

  // 축별 최적 조합 재검 — 각 축 승자 반영 후 4분기·이웃
  console.log(`\n■ F단 (09시창 임시판정 — 자체 레그 손익·확인 속도)`);
  for (const off of [0.03, 0.05, 0.075]) {
    for (const conf of [2, 3, 4, 6]) {
      show(`F off${off}·확인${conf}봉`, evalCfg(days, { ...base, off, conf, trailR: 0, trailN: 0 }), days.length);
    }
  }
  console.log(`\n■ M단 (중간확인)`);
  for (const off of [0.08, 0.10, 0.12]) {
    for (const conf of [6, 8, 10]) {
      show(`M off${off}·확인${conf}봉`, evalCfg(days, { ...base, off, conf, sb: 0, trailR: 0, trailN: 0 }), days.length);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
