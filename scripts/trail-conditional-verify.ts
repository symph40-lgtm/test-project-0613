// 조건부 트레일 반전 — 적용 전 잔여 검증 (2026-07-25, 스펙 2.13 후속):
//   ① 경계의 추적 분위화: vol10 상위⅓을 "과거 60거래일 추적 66.7분위"로 재정의 (선견 제거 — 라이브 재현 가능)
//   ② 스탑 결합: 레그마다 본주 -1.5% 스탑 적용한 멀티레그 손익 (컷 후엔 다음 전이까지 관망)
// 전략 비교 (하닉·삼전):
//   기준     = 현행 본피셔 스트림 (0.15·8봉·C반전3·sb0.1) 전일
//   조건부   = 고변동일(추적 분위 상위⅓)만 트레일(극값-0.5×평균폭 되돌림·5봉, C3 병행), 나머지 기준과 동일
//   npx tsx scripts/trail-conditional-verify.ts [--days 224]   (.predict-cache 전용 — 무통신)
// 채택 기준: 두 종목 × 전·후반 4/4 개선 (특히 고변동 부분집합에서).

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

// 멀티레그 + 레그별 스탑: 컷되면 다음 전이까지 관망, 전이마다 재진입
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

(async () => {
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const daily = (await fetchDailyPredict(code, DAYS + 200)).filter((b) => b.date < today);
    // vol10 시계열 (경계 추적 분위용 — 평가 구간보다 앞서 60일 웜업 확보)
    type D = { date: string; vol10: number; reg: MinuteBar[]; r10: number; close: number };
    const seq: D[] = [];
    for (const bar of daily.slice(-(DAYS + 70))) {
      const idx = daily.findIndex((b) => b.date === bar.date);
      if (idx < 30) continue;
      const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
      const prevClose = daily[idx - 1]?.close;
      if (r10 === null || !prevClose) continue;
      const reg = readCache(`${code}-${bar.date}.json`);
      seq.push({ date: bar.date, vol10: (r10 / prevClose) * 100, reg: reg ?? [], r10, close: bar.close });
    }
    // 평가: 앞 60일은 웜업 — 추적 66.7분위 경계
    let evalN = 0, hvN = 0;
    const cum = { base: [0, 0] as [number, number], cond: [0, 0] as [number, number] };
    const hv = { base: [0, 0] as [number, number], cond: [0, 0] as [number, number] };
    let flipsBase = 0, flipsCond = 0;
    const evalDays = seq.slice(60).filter((d) => d.reg.length >= 240);
    for (let i = 60; i < seq.length; i++) {
      const d = seq[i];
      if (d.reg.length < 240) continue;
      const prior = seq.slice(Math.max(0, i - 60), i).map((x) => x.vol10).sort((a, b) => a - b);
      if (prior.length < 40) continue;
      const thr = prior[Math.floor((2 * prior.length) / 3)];
      const isHv = d.vol10 >= thr;
      const half: 0 | 1 = evalN < evalDays.length / 2 ? 0 : 1;
      evalN++;
      const base = stream(d.reg, 0.15 * d.r10, 8, 3, 0.1 * d.r10, 0, 0);
      const cond = isHv ? stream(d.reg, 0.15 * d.r10, 8, 3, 0.1 * d.r10, 0.5 * d.r10, 5) : base;
      const pb = protoPnl(d.reg, base, d.close);
      const pc = protoPnl(d.reg, cond, d.close);
      cum.base[half] += pb; cum.cond[half] += pc;
      if (isHv) {
        hvN++;
        hv.base[half] += pb; hv.cond[half] += pc;
        flipsBase += Math.max(0, base.length - 1);
        flipsCond += Math.max(0, cond.length - 1);
      }
    }
    const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
    console.log(`\n════ ${name} (${code}) — 평가 ${evalN}일 (웜업 60일 제외 · 고변동 ${hvN}일 = ${Math.round((100 * hvN) / evalN)}%) ════`);
    console.log(`전체:   기준 ${s(cum.base[0])} / ${s(cum.base[1])} = ${s(cum.base[0] + cum.base[1])}%p  →  조건부 ${s(cum.cond[0])} / ${s(cum.cond[1])} = ${s(cum.cond[0] + cum.cond[1])}%p`);
    console.log(`고변동만: 기준 ${s(hv.base[0])} / ${s(hv.base[1])} = ${s(hv.base[0] + hv.base[1])}%p  →  조건부 ${s(hv.cond[0])} / ${s(hv.cond[1])} = ${s(hv.cond[0] + hv.cond[1])}%p`);
    console.log(`고변동일 전환 수: 기준 ${flipsBase}회 → 조건부 ${flipsCond}회`);
  }
  console.log(`\n주: 본주 %·레그별 -1.5% 스탑(컷 후 다음 전이까지 관망). 경계 = 과거 60일 vol10의 66.7분위 (선견 없음).`);
})();
