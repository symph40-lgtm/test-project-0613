// 계층 비중 배분 실측 (사용자 질문 2026-07-30 밤 — "50→30→20 vs 20→30→50 손익이 어떻게 되나"):
//   npx tsx scripts/weight-order-sweep.ts
// 모델: 계좌 일손익 = F일손익×wF + M×wM + 본×wB (각 계층은 자기 신호로 진입·청산하는 독립 슬리브 근사).
// 계층 스트림 = 라이브 현행 상수(F ×3@10:30·M ×1.25·본 트레일), 스탑 = 실전(하닉 본주 -2.5%·삼전 -1.5%).
// 지표: 합계·전/후반·최악일·컷 실손(컷 손실×비중 합) — '컷 한 방의 계좌 타격'이 비중에 어떻게 달라지나.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const f1 = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);

type St = "up" | "down";
type Tr = { i: number; to: St; px: number };
function stream(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, rev: number, emMult: number, emUntilMin: number, trailR = 0, trailN = 0): Tr[] {
  if (bars.length < 16) return [];
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  const out: Tr[] = [];
  let st: "none" | St = "none", up = 0, dn = 0, run = 0, ext = 0;
  const trW = trailR * r10;
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = emUntilMin > 0 && tMin(b.time) < emUntilMin ? emMult : 1;
    const aUp = orH + off * r10 * em, aDn = orL - off * r10 * em, sbW = sb * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf, rev);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf, rev);
    }
    if (st === "none") {
      if (up >= conf) { st = "up"; ext = b.close; run = 0; out.push({ i, to: "up", px: b.close }); }
      else if (dn >= conf) { st = "down"; ext = b.close; run = 0; out.push({ i, to: "down", px: b.close }); }
      continue;
    }
    if (st === "up") {
      ext = Math.max(ext, b.close);
      run = trW > 0 && b.close < ext - trW ? run + 1 : 0;
      if (dn >= rev || (trW > 0 && run >= trailN)) { st = "down"; ext = b.close; run = 0; out.push({ i, to: "down", px: b.close }); }
    } else {
      ext = Math.min(ext, b.close);
      run = trW > 0 && b.close > ext + trW ? run + 1 : 0;
      if (up >= rev || (trW > 0 && run >= trailN)) { st = "up"; ext = b.close; run = 0; out.push({ i, to: "up", px: b.close }); }
    }
  }
  return out;
}

function dayPnl(bars: MinuteBar[], trs: Tr[], close: number, stopPct: number): { p: number; cutLoss: number } {
  let p = 0, cutLoss = 0;
  const s = stopPct / 100;
  for (let k = 0; k < trs.length; k++) {
    const e = trs[k], endI = k + 1 < trs.length ? trs[k + 1].i : bars.length;
    let x: number | null = null;
    for (let i = e.i + 1; i < endI; i++) {
      const b = bars[i];
      if (e.to === "up" && b.low <= e.px * (1 - s)) { x = -stopPct; cutLoss += stopPct; break; }
      if (e.to === "down" && b.high >= e.px * (1 + s)) { x = -stopPct; cutLoss += stopPct; break; }
    }
    if (x === null) {
      const px2 = k + 1 < trs.length ? trs[k + 1].px : close;
      x = ((px2 - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
    }
    p += x;
  }
  return { p, cutLoss };
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const WEIGHTS: [string, number, number, number][] = [
    ["현행 50/30/20", 0.5, 0.3, 0.2],
    ["역순 20/30/50", 0.2, 0.3, 0.5],
    ["중간 30/30/40", 0.3, 0.3, 0.4],
    ["균등 33/33/34", 0.33, 0.33, 0.34],
  ];
  for (const cfg of [
    { code: "000660", nm: "하닉", sb: 0.1, stop: 2.5, trailR: 0.35, trailN: 5, trailAll: true },
    { code: "005930", nm: "삼전", sb: 0.075, stop: 1.5, trailR: 0.3, trailN: 3, trailAll: false },
  ]) {
    const daily = (await fetchDailyPredict(cfg.code, 500)).filter((b) => b.date < today);
    type DayR = { f: number; m: number; b: number; fCut: number; mCut: number; bCut: number };
    const days: DayR[] = [];
    for (let i = 130; i < daily.length; i++) {
      const reg = rc(`${cfg.code}-${daily[i].date}.json`);
      const pre = rc(`${cfg.code}NX-${daily[i].date}.json`);
      const hist = daily.slice(Math.max(0, i - 120), i);
      const r10 = avgRange(hist, 10);
      if (!reg || reg.length < 240 || r10 === null) continue;
      const cont = [...(pre ?? []), ...reg];
      const close = daily[i].close;
      const useTrail = cfg.trailAll || isHighVolDay(hist);
      const F = dayPnl(cont, stream(cont, r10, 0.05, 4, cfg.sb, 3, 3, tMin("10:30")), close, cfg.stop);
      const M = dayPnl(cont, stream(cont, r10, 0.10, 8, 0, 3, 1.25, tMin("10:30")), close, cfg.stop);
      const B = dayPnl(reg, stream(reg, r10, 0.15, 8, cfg.sb, 3, 1, 0, useTrail ? cfg.trailR : 0, cfg.trailN), close, cfg.stop);
      days.push({ f: F.p, m: M.p, b: B.p, fCut: F.cutLoss, mCut: M.cutLoss, bCut: B.cutLoss });
    }
    console.log(`\n════ ${cfg.nm} ${days.length}일 (실전 스탑 -${cfg.stop}%·계좌 손익 = Σ계층×비중) ════`);
    for (const [tag, wF, wM, wB] of WEIGHTS) {
      let tot = 0, h1 = 0, h2 = 0, worst = 0, cutTot = 0;
      days.forEach((d, i2) => {
        const p = d.f * wF + d.m * wM + d.b * wB;
        tot += p;
        if (i2 < days.length / 2) h1 += p; else h2 += p;
        if (p < worst) worst = p;
        cutTot += d.fCut * wF + d.mCut * wM + d.bCut * wB;
      });
      console.log(`  ${tag.padEnd(13)} 합 ${f1(tot).padStart(7)}%p (전/후반 ${f1(h1)}/${f1(h2)}) | 최악일 ${worst.toFixed(1)} | 컷 실손 누계 ${f1(-cutTot)}%p`);
    }
    const sums = days.reduce((a, d) => ({ f: a.f + d.f, m: a.m + d.m, b: a.b + d.b }), { f: 0, m: 0, b: 0 });
    console.log(`  (계층 원값: F ${f1(sums.f)}·M ${f1(sums.m)}·본 ${f1(sums.b)}%p)`);
  }
  console.log(`\n주: 각 계층을 독립 슬리브로 근사(증분 프로토콜의 회계 단순화). 컷 실손 = 컷 손실×비중 누계.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
