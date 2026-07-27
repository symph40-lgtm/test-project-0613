// 하닉 트레일 문턱 완화 정밀 검증 (사용자 지시 2026-07-27 — "0.35×5봉이 좋은지 검증, 좋으면 적용"):
// ss-trail-threshold-sweep에서 0.35×5봉이 현행 0.5×3봉 대비 +23.4%p로 나옴 → 채택 전 분해 검증.
//   npx tsx scripts/hx-trail-soften-verify.ts [--days 224]
// 프레임 = 기채택 검증과 동일 (본피셔 0.15·8봉·C반전3·sb0.1, 고변동일 게이트 = 추적 66.7분위,
// 멀티레그 + 레그별 본주 -1.5% 스탑). 분해: ①4분기 안정성 ②반전 레그 진성률(익/총)
// ③왕복 컷(전환 후 15분 내 재전환) ④최악일 ⑤이웃 파라미터 절벽 여부. 삼전도 0.3×3봉 후보 동일 분해.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const STOP = 1.5;
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

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

// 레그 분해: 각 레그 손익 + 반전 레그 여부
function legPnls(reg: MinuteBar[], tr: Trans[], close: number): { pnl: number; isRev: boolean; gapMin: number }[] {
  const out: { pnl: number; isRev: boolean; gapMin: number }[] = [];
  for (let i = 0; i < tr.length; i++) {
    const entry = tr[i].px, dir = tr[i].to;
    const startT = tMin(tr[i].time);
    const endT = i + 1 < tr.length ? tMin(tr[i + 1].time) : Infinity;
    let pnl: number | null = null;
    for (const b of reg) {
      const tm = tMin(b.time);
      if (tm <= startT) continue;
      if (tm >= endT) break;
      if (dir === "up" && b.low <= entry * (1 - STOP / 100)) { pnl = -STOP; break; }
      if (dir === "down" && b.high >= entry * (1 + STOP / 100)) { pnl = -STOP; break; }
    }
    if (pnl === null) {
      const exitPx = i + 1 < tr.length ? tr[i + 1].px : close;
      pnl = ((exitPx - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
    }
    out.push({ pnl, isRev: i >= 1, gapMin: i + 1 < tr.length ? tMin(tr[i + 1].time) - startT : Infinity });
  }
  return out;
}

async function verify(code: string, name: string, sb: number, variants: { tag: string; r: number; n: number }[]): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 200)).filter((b) => b.date < today);
  type D = { date: string; vol10: number; reg: MinuteBar[]; r10: number; close: number };
  const seq: D[] = [];
  for (const bar of daily.slice(-(DAYS + 70))) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    const prevClose = daily[idx - 1]?.close;
    if (r10 === null || !prevClose) continue;
    seq.push({ date: bar.date, vol10: (r10 / prevClose) * 100, reg: readCache(`${code}-${bar.date}.json`) ?? [], r10, close: bar.close });
  }
  const evalDates: string[] = [];
  for (let i = 60; i < seq.length; i++) if (seq[i].reg.length >= 240) evalDates.push(seq[i].date);
  console.log(`\n════ ${name} (${code}) — 평가 ${evalDates.length}일 · sb ${sb} ════`);
  console.log(`변형       | 분기별 손익 Q1/Q2/Q3/Q4        | 반전레그 익/총(진성률) | 왕복≤15분 | 최악일 (날짜)`);
  for (const v of variants) {
    const qs = [0, 0, 0, 0];
    let revWin = 0, revTot = 0, whip = 0, flips = 0;
    let worst = 0; let worstDate = "";
    let ei = 0;
    for (let i = 60; i < seq.length; i++) {
      const d = seq[i];
      if (d.reg.length < 240) continue;
      const prior = seq.slice(Math.max(0, i - 60), i).map((x) => x.vol10).sort((a, b) => a - b);
      if (prior.length < 40) continue;
      const thr = prior[Math.floor((2 * prior.length) / 3)];
      const isHv = d.vol10 >= thr;
      const q = Math.min(3, Math.floor((4 * ei) / evalDates.length));
      ei++;
      const tr = isHv && v.r > 0
        ? stream(d.reg, 0.15 * d.r10, 8, 3, sb * d.r10, v.r * d.r10, v.n)
        : stream(d.reg, 0.15 * d.r10, 8, 3, sb * d.r10, 0, 0);
      const legs = legPnls(d.reg, tr, d.close);
      const dayPnl = legs.reduce((s, l) => s + l.pnl, 0);
      qs[q] += dayPnl;
      if (dayPnl < worst) { worst = dayPnl; worstDate = d.date; }
      if (isHv) {
        flips += Math.max(0, tr.length - 1);
        for (const l of legs) {
          if (!l.isRev) continue;
          revTot++;
          if (l.pnl > 0) revWin++;
          if (l.gapMin <= 15) whip++;
        }
      }
    }
    const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
    console.log(`${v.tag.padEnd(10)} | ${qs.map(s).join(" / ").padEnd(30)} | ${String(revWin).padStart(3)}/${String(revTot).padEnd(3)} (${revTot ? Math.round((100 * revWin) / revTot) : 0}%) | ${String(whip).padStart(4)}회 | ${worst.toFixed(1)} (${worstDate})`);
  }
}

(async () => {
  await verify("000660", "하닉", 0.1, [
    { tag: "현행 0.5×3", r: 0.5, n: 3 },
    { tag: "후보 0.35×5", r: 0.35, n: 5 },
    { tag: "이웃 0.3×5", r: 0.3, n: 5 },
    { tag: "이웃 0.4×5", r: 0.4, n: 5 },
    { tag: "이웃 0.35×3", r: 0.35, n: 3 },
  ]);
  await verify("005930", "삼전", 0.075, [
    { tag: "현행 무트레일", r: 0, n: 0 },
    { tag: "후보 0.3×3", r: 0.3, n: 3 },
    { tag: "이웃 0.25×3", r: 0.25, n: 3 },
    { tag: "이웃 0.35×3", r: 0.35, n: 3 },
    { tag: "이웃 0.3×5", r: 0.3, n: 5 },
  ]);
  console.log(`\n주: 분기 = 평가일 4등분(오래된→최신). 진성률·왕복은 고변동일 반전 레그만. 본주 %·레그별 -1.5% 스탑.`);
})();
