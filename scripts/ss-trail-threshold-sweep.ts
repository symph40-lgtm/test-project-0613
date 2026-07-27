// 삼전 트레일 문턱 완화 스윕 (사용자 제안 2026-07-27 — "삼전의 경우 문턱을 좀 낮추면 어때"):
// 7/27 삼전 오후 반등(+3.0%)이 하닉식 트레일 0.5×10일평균폭(≈4.5%)에 미달해 미포착 →
// R∈{0.25,0.3,0.35,0.4,0.5}×유지 N∈{3,5}로 낮춰가며 손익·전환수·7/27 포착 여부 실측.
//   npx tsx scripts/ss-trail-threshold-sweep.ts [--days 224]
// 프레임 = 기채택 하닉 트레일 검증(trail-conditional-verify.ts)과 동일: 본피셔 스트림
// (0.15·8봉·C반전3·sb 삼전 0.075), 고변동일 게이트(과거 60일 vol10 추적 66.7분위 — 선견 없음),
// 멀티레그 + 레그별 본주 -1.5% 스탑(컷 후 다음 전이까지 관망). 참고로 하닉(sb 0.1)도 동일 스윕.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes } from "../lib/predict/kisMinute";
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

function protoPnl(reg: MinuteBar[], tr: Trans[], close: number): number {
  let pnl = 0;
  for (let i = 0; i < tr.length; i++) {
    const entry = tr[i].px, dir = tr[i].to;
    const startT = tMin(tr[i].time);
    const endT = i + 1 < tr.length ? tMin(tr[i + 1].time) : Infinity;
    let stopped = false;
    for (const b of reg) {
      const tm = tMin(b.time);
      if (tm <= startT) continue;
      if (tm >= endT) break;
      if (dir === "up" && b.low <= entry * (1 - STOP / 100)) { pnl -= STOP; stopped = true; break; }
      if (dir === "down" && b.high >= entry * (1 + STOP / 100)) { pnl -= STOP; stopped = true; break; }
    }
    if (!stopped) {
      const exitPx = i + 1 < tr.length ? tr[i + 1].px : close;
      pnl += ((exitPx - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
    }
  }
  return pnl;
}

const VARIANTS = [0.25, 0.3, 0.35, 0.4, 0.5].flatMap((r) => [3, 5].map((n) => ({ r, n })));

async function sweep(code: string, name: string, sb: number): Promise<void> {
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
  const evalDays = seq.slice(60).filter((d) => d.reg.length >= 240);
  console.log(`\n════ ${name} (${code}) — 평가 ${evalDays.length}일 · sb ${sb} ════`);
  console.log(`변형        | 고변동 전환 | 전체 전/후 = 합      | 고변동만 전/후 = 합   (기준 대비)`);
  let baseTot = 0, baseHv = 0;
  for (const v of [{ r: 0, n: 0 }, ...VARIANTS]) {
    let evalN = 0, hvN = 0, flips = 0;
    const cum: [number, number] = [0, 0];
    const hv: [number, number] = [0, 0];
    for (let i = 60; i < seq.length; i++) {
      const d = seq[i];
      if (d.reg.length < 240) continue;
      const prior = seq.slice(Math.max(0, i - 60), i).map((x) => x.vol10).sort((a, b) => a - b);
      if (prior.length < 40) continue;
      const thr = prior[Math.floor((2 * prior.length) / 3)];
      const isHv = d.vol10 >= thr;
      const half: 0 | 1 = evalN < evalDays.length / 2 ? 0 : 1;
      evalN++;
      const tr = isHv && v.r > 0
        ? stream(d.reg, 0.15 * d.r10, 8, 3, sb * d.r10, v.r * d.r10, v.n)
        : stream(d.reg, 0.15 * d.r10, 8, 3, sb * d.r10, 0, 0);
      const p = protoPnl(d.reg, tr, d.close);
      cum[half] += p;
      if (isHv) { hvN++; hv[half] += p; flips += Math.max(0, tr.length - 1); }
    }
    const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
    const tot = cum[0] + cum[1], hvT = hv[0] + hv[1];
    if (v.r === 0) { baseTot = tot; baseHv = hvT; }
    const tag = v.r === 0 ? "기준(무트레일)" : `트레일 ${v.r}×${v.n}봉`;
    const d1 = v.r === 0 ? "" : ` (${s(tot - baseTot)} / 고변동 ${s(hvT - baseHv)})`;
    console.log(`${tag.padEnd(11)} | ${String(flips).padStart(4)}회 | ${s(cum[0])} / ${s(cum[1])} = ${s(tot).padStart(6)} | ${s(hv[0])} / ${s(hv[1])} = ${s(hvT).padStart(6)}${d1}`);
  }

  // 7/27 케이스: 어떤 문턱이면 잡혔나 (당일 분봉 — 캐시 없으면 KIS)
  const d727 = "2026-07-27";
  const reg727 = readCache(`${code}-${d727}.json`) ?? (await fetchDayMinutes(code, d727.replace(/-/g, ""), "153000")) ?? [];
  const idx727 = daily.findIndex((b) => b.date === d727);
  const hist727 = idx727 >= 0 ? daily.slice(0, idx727) : daily;
  const r10727 = avgRange(hist727.slice(-120), 10);
  const close727 = idx727 >= 0 ? daily[idx727].close : reg727[reg727.length - 1]?.close;
  if (reg727.length >= 240 && r10727 !== null && close727) {
    console.log(`  7/27 실측 (10일평균폭 ${((r10727 / hist727[hist727.length - 1].close) * 100).toFixed(1)}%):`);
    for (const v of [{ r: 0, n: 0 }, ...VARIANTS]) {
      const tr = stream(reg727, 0.15 * r10727, 8, 3, sb * r10727, v.r * r10727, v.n);
      const rev = tr.slice(1).map((t) => `${t.time} ${t.to === "up" ? "레버" : "인버"} ${t.px.toLocaleString()}`).join(", ");
      const p = protoPnl(reg727, tr, close727);
      console.log(`    ${(v.r === 0 ? "무트레일" : `${v.r}×${v.n}봉`).padEnd(8)} | 전환: ${rev || "없음"} | 당일 손익 ${(p >= 0 ? "+" : "") + p.toFixed(2)}%p`);
    }
  }
}

(async () => {
  await sweep("005930", "삼전", 0.075);
  await sweep("000660", "하닉 (참고)", 0.1);
  console.log(`\n주: 본주 %·레그별 -1.5% 스탑. 고변동 게이트 = 과거 60일 vol10 추적 66.7분위 (라이브 재현 가능).`);
})();
