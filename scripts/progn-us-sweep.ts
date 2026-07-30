// 미장(SOXX) 판정 후 N봉 진행성 스윕 (사용자 제안 2026-07-30 밤 "2봉으로 하는게 어때 25분 너무 길어"):
//   npx tsx scripts/progn-us-sweep.ts
// prog5-all-sweep.ts의 SOXX 구간을 N(1~5봉) × 기준(0.05/0.075/0.1×10일폭)으로 확장.
// 봉 수를 줄이면 같은 25분 대비 진행 여지가 작으므로 기준치도 함께 스윕해 분리력을 비교한다.

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchJudge5m, fetchJudgeDaily } from "../lib/signal/us/predictStream";
import type { MinuteBar } from "../lib/predict/types";

const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type St = "up" | "down";
type Tr = { i: number; to: St; px: number };
function stream(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, rev: number): Tr[] {
  if (bars.length < 16) return [];
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  const out: Tr[] = [];
  let st: "none" | St = "none", up = 0, dn = 0;
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const aUp = orH + off * r10, aDn = orL - off * r10, sbW = sb * r10;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf, rev);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf, rev);
    }
    if (st === "none") {
      if (up >= conf) { st = "up"; out.push({ i, to: "up", px: b.close }); }
      else if (dn >= conf) { st = "down"; out.push({ i, to: "down", px: b.close }); }
      continue;
    }
    if (st === "up") { if (dn >= rev) { st = "down"; out.push({ i, to: "down", px: b.close }); } }
    else if (up >= rev) { st = "up"; out.push({ i, to: "up", px: b.close }); }
  }
  return out;
}

type DayB = { bars: MinuteBar[]; r10: number; close: number };
function measure(name: string, days: DayB[], off: number, conf: number, sb: number, rev: number, stopPct: number, nBars: number, needR: number): string {
  const g = { ok: [] as number[], bad: [] as number[] };
  const cuts = { ok: 0, bad: 0 };
  for (const d of days) {
    const trs = stream(d.bars, d.r10, off, conf, sb, rev);
    const s = stopPct / 100;
    for (let k = 0; k < trs.length; k++) {
      const e = trs[k], endI = k + 1 < trs.length ? trs[k + 1].i : d.bars.length;
      const iN = Math.min(e.i + nBars, endI - 1);
      if (iN <= e.i) continue;
      const prog = ((d.bars[iN].close - e.px) * (e.to === "up" ? 1 : -1)) / d.r10;
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
      const key = prog >= needR ? "ok" : "bad";
      g[key].push(pnl);
      if (cut) cuts[key]++;
    }
  }
  const fmt = (a: number[], c: number) => a.length
    ? `${String(a.length).padStart(2)}건 평균 ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2).padStart(6)}%·승률 ${String(Math.round(100 * a.filter((v) => v > 0).length / a.length)).padStart(3)}%·컷률 ${String(Math.round((100 * c) / a.length)).padStart(3)}%`
    : " 0건";
  return `${name} ${nBars}봉·기준${needR} OK: ${fmt(g.ok, cuts.ok)} | 미달: ${fmt(g.bad, cuts.bad)}`;
}

async function main() {
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
  console.log(`표본: 연속창 ${contD.length}일 / 정규장 ${regD.length}일 (야후 5분봉)`);
  for (const n of [1, 2, 3, 4, 5]) {
    for (const need of [0.05, 0.075, 0.1]) {
      console.log(measure("F", contD, 0.05, 1, 0.1, 1, 1.5, n, need));
    }
    console.log("");
  }
  for (const n of [1, 2, 3, 4, 5]) {
    for (const need of [0.05, 0.075, 0.1]) {
      console.log(measure("M", contD, 0.10, 2, 0, 1, 1.5, n, need));
    }
    console.log("");
  }
  console.log("주: OK = 판정 후 N봉(5분봉) 진행 ≥ 기준×10일폭. 표본 ~37일 소표본 — 방향 일관성 위주로 판단.");
}
main().catch((e) => { console.error(e); process.exit(1); });
