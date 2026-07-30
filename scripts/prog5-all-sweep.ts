// 판정 후 5봉 진행성 — 전 조합 통계 (사용자 지시 2026-07-30 밤 "모든 판정에 해줘"):
//   npx tsx scripts/prog5-all-sweep.ts
// 하닉/삼전 F·M·본(227일, 라이브 상수·earlyVol 포함) + TOP10 F·M·본(120일) + SOXX F·M·본(야후 ~37일).
// 기준 0.1×10일폭, 스탑: 하닉 본주 2.5% / 삼전·TOP10·SOXX 1.5%. 결과는 진행성 문자의 그룹 통계로 임베드.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchJudge5m, fetchJudgeDaily } from "../lib/signal/us/predictStream";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

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

type DayB = { bars: MinuteBar[]; r10: number; close: number; trail?: boolean };
function measure(name: string, days: DayB[], off: number, conf: number, sb: number, rev: number, emMult: number, emUntil: string, stopPct: number, trailR = 0, trailN = 0): void {
  const g = { ok: [] as number[], bad: [] as number[] };
  const cuts = { ok: 0, bad: 0 };
  for (const d of days) {
    const useTrail = d.trail === undefined ? trailR > 0 : d.trail;
    const trs = stream(d.bars, d.r10, off, conf, sb, rev, emMult, emUntil ? tMin(emUntil) : 0, useTrail ? trailR : 0, trailN);
    const s = stopPct / 100;
    for (let k = 0; k < trs.length; k++) {
      const e = trs[k], endI = k + 1 < trs.length ? trs[k + 1].i : d.bars.length;
      const i5 = Math.min(e.i + 5, endI - 1);
      if (i5 <= e.i) continue;
      const prog = ((d.bars[i5].close - e.px) * (e.to === "up" ? 1 : -1)) / d.r10;
      let pnl: number | null = null;
      let cut = false;
      for (let i = e.i + 1; i < endI; i++) {
        const b = d.bars[i];
        if (e.to === "up" && b.low <= e.px * (1 - s)) { pnl = -stopPct; cut = true; break; }
        if (e.to === "down" && b.high >= e.px * (1 + s)) { pnl = -stopPct; cut = true; break; }
      }
      if (pnl === null) {
        const px2 = k + 1 < trs.length ? trs[k + 1].px : d.close;
        pnl = ((px2 - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
      }
      const key = prog >= 0.1 ? "ok" : "bad";
      g[key].push(pnl);
      if (cut) cuts[key]++;
    }
  }
  const fmt = (a: number[], c: number) => a.length
    ? `${a.length}건 평균 ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)}%·승률 ${Math.round(100 * a.filter((v) => v > 0).length / a.length)}%·컷률 ${Math.round((100 * c) / a.length)}%`
    : "0건";
  console.log(`${name.padEnd(9)} OK: ${fmt(g.ok, cuts.ok)} | 미달: ${fmt(g.bad, cuts.bad)}`);
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (const cfg of [
    { code: "000660", nm: "하닉", sb: 0.1, stop: 2.5, trailR: 0.35, trailN: 5, trailAll: true },
    { code: "005930", nm: "삼전", sb: 0.075, stop: 1.5, trailR: 0.3, trailN: 3, trailAll: false },
  ]) {
    const daily = (await fetchDailyPredict(cfg.code, 500)).filter((b) => b.date < today);
    const contD: DayB[] = [], regD: DayB[] = [];
    for (let i = 130; i < daily.length; i++) {
      const reg = rc(`${cfg.code}-${daily[i].date}.json`);
      const pre = rc(`${cfg.code}NX-${daily[i].date}.json`);
      const hist = daily.slice(Math.max(0, i - 120), i);
      const r10 = avgRange(hist, 10);
      if (!reg || reg.length < 240 || r10 === null) continue;
      contD.push({ bars: [...(pre ?? []), ...reg], r10, close: daily[i].close });
      regD.push({ bars: reg, r10, close: daily[i].close, trail: cfg.trailAll || isHighVolDay(hist) });
    }
    measure(`${cfg.nm} F`, contD, 0.05, 4, cfg.sb, 3, 3, "10:30", cfg.stop);
    measure(`${cfg.nm} M`, contD, 0.10, 8, 0, 3, 1.25, "10:30", cfg.stop);
    measure(`${cfg.nm} 본`, regD, 0.15, 8, cfg.sb, 3, 1, "", cfg.stop, cfg.trailR, cfg.trailN);
  }
  {
    const daily = (await fetchDailyPredict("396500", 400)).filter((b) => b.date < today);
    const days: DayB[] = [];
    for (let i = 130; i < daily.length; i++) {
      const reg = rc(`396500-${daily[i].date}.json`);
      const r10 = avgRange(daily.slice(Math.max(0, i - 120), i), 10);
      if (!reg || reg.length < 240 || r10 === null) continue;
      days.push({ bars: reg, r10, close: daily[i].close });
    }
    measure("TOP10 F", days, 0.05, 2, 0.075, 3, 1, "", 1.5);
    measure("TOP10 M", days, 0.08, 6, 0, 3, 1, "", 1.5);
    measure("TOP10 본", days, 0.15, 5, 0.075, 3, 1, "", 1.5, 0.5, 3);
  }
  {
    const byDay = await fetchJudge5m(55);
    const daily = await fetchJudgeDaily(140);
    const contD: DayB[] = [], regD: DayB[] = [];
    for (const d of [...byDay.keys()].sort()) {
      const all = byDay.get(d) ?? [];
      const w = all.filter((b) => b.etMin >= 7 * 60 && b.etMin < 16 * 60);
      const reg = all.filter((b) => b.etMin >= 9 * 60 + 30 && b.etMin < 16 * 60);
      const idx = daily.findIndex((x) => x.date === d);
      if (w.length < 60 || idx < 15) continue;
      const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
      if (r10 === null) continue;
      const close = reg.length ? reg[reg.length - 1].close : w[w.length - 1].close;
      contD.push({ bars: w as unknown as MinuteBar[], r10, close });
      if (reg.length >= 20) regD.push({ bars: reg as unknown as MinuteBar[], r10, close });
    }
    measure("SOXX F", contD, 0.05, 1, 0.1, 1, 1, "", 1.5);
    measure("SOXX M", contD, 0.10, 2, 0, 1, 1, "", 1.5);
    measure("SOXX 본", regD, 0.15, 2, 0.1, 1, 1, "", 1.5);
  }
  console.log("\n주: OK = 판정 후 5봉(해당 스트림 봉 단위) 진행 ≥ 0.1×10일폭. SOXX는 5분봉 5개=25분·소표본.");
}
main().catch((e) => { console.error(e); process.exit(1); });
