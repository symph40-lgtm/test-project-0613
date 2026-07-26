// 코스닥150 피셔 적합성 평가 (사용자 요청 2026-07-26 — "추세날이 많은지·강한지·왕복이 많은지·
// 수익이 어떤지, 추세가 많으면 코스닥150 레버리지 진입 검토").
//   npx tsx scripts/kosdaq150-eval.ts [--days 120]
// 판정 지수 = KODEX 코스닥150 (229200, 1x — 체결 후보는 코스닥150 레버리지 233740).
// ① 일봉 비교 (224일): 추세일 비율(동일 잣대 ±1.2% + 자기 스케일)·|rOC|·레인지·왕복성(레인지/|rOC|)
// ② 분봉 본피셔 (KIS 1분봉, 일자별 .predict-cache/229200-*.json 캐시 — 재실행 시 이어받기):
//    삼전·하닉과 동일 규칙 (0.15×r10·8봉·강돌파 0.1·반전3) — 14:00 컷 부호적중 + 전이 레그(스탑 -1.5%)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
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
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 120; })();
const CODE = "229200";
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

type St = "none" | "up" | "down";
type Trans = { to: St; px: number; idx: number };
function stream(bars: MinuteBar[], offW: number, sbW: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const out: Trans[] = [];
  let st: St = "none", up = 0, dn = 0;
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 8, 3);
    if (b.close < aDn - sbW) dn = Math.max(dn, 8, 3);
    if (st === "none") {
      if (up >= 8) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
      else if (dn >= 8) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    } else if (st === "up" && dn >= 3) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    else if (st === "down" && up >= 3) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
  }
  return out;
}

function dailyStats(name: string, daily: { date: string; open: number; high: number; low: number; close: number }[], scaleBase: number | null): number {
  const a = daily.slice(-224);
  const rocs = a.map((b) => ((b.close - b.open) / b.open) * 100);
  const absR = rocs.map(Math.abs);
  const ranges = a.map((b) => ((b.high - b.low) / b.open) * 100);
  const chop = a.map((b, i) => (Math.abs(rocs[i]) > 0.05 ? ranges[i] / Math.abs(rocs[i]) : 10));
  const trendFix = a.filter((b, i) => {
    const pos = b.high > b.low ? (b.close - b.low) / (b.high - b.low) : 0.5;
    return (rocs[i] >= 1.2 && pos >= 0.65) || (rocs[i] <= -1.2 && pos <= 0.35);
  }).length;
  const thr = scaleBase !== null ? 1.2 * (med(absR) / scaleBase) : 1.2;
  const trendScale = a.filter((b, i) => {
    const pos = b.high > b.low ? (b.close - b.low) / (b.high - b.low) : 0.5;
    return (rocs[i] >= thr && pos >= 0.65) || (rocs[i] <= -thr && pos <= 0.35);
  }).length;
  console.log(
    `  ${name.padEnd(10)} 중앙|rOC| ${med(absR).toFixed(2)}% · 중앙레인지 ${med(ranges).toFixed(2)}% · 왕복성(중앙 레인지/|rOC|) ${med(chop).toFixed(1)} · 추세일 ±1.2% ${trendFix}/${a.length}(${Math.round((100 * trendFix) / a.length)}%) · 자기스케일(±${thr.toFixed(2)}%) ${trendScale}(${Math.round((100 * trendScale) / a.length)}%)`,
  );
  return med(absR);
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  console.log("① 일봉 비교 (최근 224일):");
  const ssD = (await fetchDailyPredict("005930", 364)).filter((b) => b.date < today);
  const base = dailyStats("삼전", ssD, null);
  dailyStats("하닉", (await fetchDailyPredict("000660", 364)).filter((b) => b.date < today), base);
  const kqD = (await fetchDailyPredict(CODE, 364)).filter((b) => b.date < today);
  dailyStats("코스닥150", kqD, base);

  // ② 분봉 수집 (캐시 우선) + 본피셔
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const dates = kqD.slice(-DAYS).map((b) => b.date);
  let fetched = 0;
  for (const d of dates) {
    const f = `${CODE}-${d}.json`;
    if (readCache(f)) continue;
    try {
      const bars = await fetchDayMinutes(CODE, d.replace(/-/g, ""), "153000");
      if (bars && bars.length >= 240) { writeFileSync(resolve(CACHE_DIR, f), JSON.stringify(bars)); fetched++; }
      else writeFileSync(resolve(CACHE_DIR, f), JSON.stringify([]));
    } catch { /* skip */ }
    await sleep(250);
    if (fetched > 0 && fetched % 20 === 0) console.log(`  분봉 수집 ${fetched}일...`);
  }
  console.log(`\n② 코스닥150 본피셔 (신규 수집 ${fetched}일 + 캐시):`);
  let sessions = 0, dirDays = 0, hit = 0, legPnl = 0, legs = 0, stops = 0;
  const halves = [0, 0];
  const valid = dates.filter((d) => (readCache(`${CODE}-${d}.json`)?.length ?? 0) >= 240);
  for (const d of valid) {
    const i = kqD.findIndex((b) => b.date === d);
    if (i < 30) continue;
    const r10 = avgRange(kqD.slice(Math.max(0, i - 120), i), 10);
    if (r10 === null) continue;
    const reg = readCache(`${CODE}-${d}.json`)!;
    sessions++;
    const half = valid.indexOf(d) < valid.length / 2 ? 0 : 1;
    const rOC = ((reg[reg.length - 1].close - reg[0].open) / reg[0].open) * 100;
    // 14:00 컷 판정 (삼전·하닉 확정과 동일)
    const w14 = reg.filter((b) => b.time < "14:00");
    const ts14 = stream(w14, 0.15 * r10, 0.1 * r10);
    const v14 = ts14.length ? ts14[ts14.length - 1].to : "none";
    if (v14 !== "none") {
      dirDays++;
      if ((v14 === "up" && rOC > 0) || (v14 === "down" && rOC < 0)) hit++;
    }
    // 전이 레그 (스탑 -1.5% — 국장 본주 관례. 1x ETF라 실체결 233740은 2배 스케일 유의)
    const ts = stream(reg, 0.15 * r10, 0.1 * r10);
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k];
      const endIdx = k + 1 < ts.length ? ts[k + 1].idx : reg.length - 1;
      const dirUp = t.to === "up";
      let pnl: number | null = null;
      for (let j = t.idx + 1; j <= endIdx; j++) {
        const adv = dirUp ? ((reg[j].low - t.px) / t.px) * 100 : ((t.px - reg[j].high) / t.px) * 100;
        if (adv <= -1.5) { pnl = -1.5; stops++; break; }
      }
      if (pnl === null) pnl = ((reg[endIdx].close - t.px) / t.px) * 100 * (dirUp ? 1 : -1);
      legPnl += pnl; legs++; halves[half] += pnl;
    }
  }
  console.log(`  세션 ${sessions}일 — 14:00 컷 방향판정 ${dirDays}일·부호적중 ${hit}/${dirDays} = ${dirDays ? Math.round((100 * hit) / dirDays) : 0}%`);
  console.log(`  전이 레그 ${legs}(스탑 ${stops}) 누적 ${legPnl >= 0 ? "+" : ""}${legPnl.toFixed(1)}%p (전/후 ${halves[0].toFixed(1)}/${halves[1].toFixed(1)}) — 1x 기준·레버리지(233740)는 ×2`);
}
main().catch((e) => { console.error(e); process.exit(1); });
