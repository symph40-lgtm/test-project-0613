// 장중 레짐(DC1·DC2) 분류·전환 실측 (사용자 승인 2026-07-26 — "추세/왕복 2단계 분류로 알려주고
// 전환도 알려달라"의 사전 검증). npx tsx scripts/regime-intraday-sweep.ts  (.predict-cache 무통신)
//
// 분류 (누적 5분봉, 방향 대역 ±0.2% — 개별주 스케일): 미정(3봉 미만·방향 미형성) /
//   강추세 DC1≥0.60 & DC2≥0.20 / 추세 DC1≥0.55 & DC2≥0.14 / 왕복 (그 외).
// 검증 질문:
//   ① 정오(12:00) 레짐이 오후(12:00~마감)를 예측하는가 — 방향 지속률·오후 본피셔 레그 경제성.
//   ② 레짐 전환 감지 — 하루 전환 횟수(문자량, 원시 vs 2연속 이력), 왕복→추세 전환 후 잔여
//     방향 지속률 (전환 통지의 정보 가치).
// 채택 기준: 레짐별 분리가 두 종목·전후반 일관 + 문자량 하루 1~3건 수준.

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
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const STOP = 1.5;
const BAND = 0.2; // 방향 미형성 대역 %

type Regime = "미정" | "강추세" | "추세" | "왕복";
type Chunk = { o: number; c: number };
function chunks5(reg: MinuteBar[], uptoIdx: number): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i + 5 <= uptoIdx + 1; i += 5) out.push({ o: reg[i].open, c: reg[i + 4].close });
  return out;
}
function classify(reg: MinuteBar[], uptoIdx: number): { rg: Regime; dir: 1 | -1 | 0; dc1: number | null; dc2: number | null } {
  const ch = chunks5(reg, uptoIdx);
  const dayOpen = reg[0].open;
  const last = ch.length ? ch[ch.length - 1].c : reg[uptoIdx].close;
  const dir: 1 | -1 | 0 = last > dayOpen * (1 + BAND / 100) ? 1 : last < dayOpen * (1 - BAND / 100) ? -1 : 0;
  if (ch.length < 3 || dir === 0) return { rg: "미정", dir, dc1: null, dc2: null };
  const same = ch.filter((x) => Math.sign(x.c - x.o) === dir).length;
  const dc1 = same / ch.length;
  const path = ch.reduce((s, x) => s + Math.abs(x.c - x.o), 0);
  const dc2 = path > 0 ? Math.abs(last - dayOpen) / path : null;
  if (dc2 === null) return { rg: "미정", dir, dc1, dc2 };
  if (dc1 >= 0.6 && dc2 >= 0.2) return { rg: "강추세", dir, dc1, dc2 };
  if (dc1 >= 0.55 && dc2 >= 0.14) return { rg: "추세", dir, dc1, dc2 };
  return { rg: "왕복", dir, dc1, dc2 };
}

type St = "none" | "up" | "down";
type Trans = { to: St; px: number; idx: number };
function bonStream(bars: MinuteBar[], offW: number, sbW: number): Trans[] {
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

async function run(code: string, name: string, sb: number): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 364)).filter((b) => b.date < today);
  const dates = daily.slice(-224).map((b) => b.date).filter((d) => (readCache(`${code}-${d}.json`)?.length ?? 0) >= 240);
  type Noon = { rg: Regime; dir: number; persist: boolean | null; pmPnl: number; pmLegs: number; half: 0 | 1 };
  const noons: Noon[] = [];
  const rawTrans: number[] = [], hysTrans: number[] = [];
  type Flip = { kind: string; persist: boolean; remPct: number; half: 0 | 1 };
  const flips: Flip[] = [];
  for (const d of dates) {
    const idx = daily.findIndex((b) => b.date === d);
    if (idx < 30) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    if (r10 === null) continue;
    const reg = readCache(`${code}-${d}.json`)!;
    const half: 0 | 1 = dates.indexOf(d) < dates.length / 2 ? 0 : 1;
    const noonIdx = reg.findIndex((b) => tMin(b.time) >= 12 * 60) - 1;
    if (noonIdx < 20) continue;
    // ① 정오 스냅샷 → 오후
    const cl = classify(reg, noonIdx);
    const pxNoon = reg[noonIdx].close;
    const close = reg[reg.length - 1].close;
    const persist = cl.dir !== 0 ? Math.sign(close - pxNoon) === cl.dir : null;
    // 오후 본피셔 레그 (전이 시각 ≥ 12:00)
    const bon = bonStream(reg, 0.15 * r10, sb * r10);
    let pmPnl = 0, pmLegs = 0;
    for (let k = 0; k < bon.length; k++) {
      if (bon[k].idx <= noonIdx) continue;
      const endIdx = k + 1 < bon.length ? bon[k + 1].idx : reg.length - 1;
      const dirUp = bon[k].to === "up";
      let pnl: number | null = null;
      for (let i = bon[k].idx + 1; i <= endIdx; i++) {
        const adv = dirUp ? ((reg[i].low - bon[k].px) / bon[k].px) * 100 : ((bon[k].px - reg[i].high) / bon[k].px) * 100;
        if (adv <= -STOP) { pnl = -STOP; break; }
      }
      if (pnl === null) pnl = ((reg[endIdx].close - bon[k].px) / bon[k].px) * 100 * (dirUp ? 1 : -1);
      pmPnl += pnl; pmLegs++;
    }
    noons.push({ rg: cl.rg, dir: cl.dir, persist, pmPnl, pmLegs, half });
    // ② 전환 감지 (10:00~15:19, 5분 스텝) — 원시 vs 2연속 이력(히스테리시스)
    let prevRg: Regime | null = null, raw = 0;
    let held: Regime | null = null, pend: Regime | null = null, pendN = 0, hys = 0;
    for (let i = 0; i < reg.length; i++) {
      const t = tMin(reg[i].time);
      if (t < 10 * 60 || (t - 9 * 60) % 5 !== 4) continue; // 5분봉 완성 시점만
      const c = classify(reg, i);
      if (prevRg !== null && c.rg !== prevRg) raw++;
      prevRg = c.rg;
      if (held === null) { held = c.rg; pend = null; pendN = 0; }
      else if (c.rg === held) { pend = null; pendN = 0; }
      else if (c.rg === pend) {
        pendN++;
        if (pendN >= 2) {
          hys++;
          // 왕복→추세 전환의 정보 가치: 전환 시점 이후 방향 지속
          const kind = `${held}→${c.rg}`;
          if ((held === "왕복" || held === "미정") && (c.rg === "추세" || c.rg === "강추세") && c.dir !== 0) {
            const rem = ((reg[reg.length - 1].close - reg[i].close) / reg[i].close) * 100;
            flips.push({ kind, persist: Math.sign(rem) === c.dir, remPct: Math.abs(rem), half });
          }
          held = c.rg; pend = null; pendN = 0;
        }
      } else { pend = c.rg; pendN = 1; }
    }
    rawTrans.push(raw); hysTrans.push(hys);
  }
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  console.log(`\n════ ${name} — ${noons.length}일 ════`);
  console.log("① 정오(12:00) 레짐 → 오후 (방향 지속 = 정오 방향대로 마감):");
  for (const rg of ["강추세", "추세", "왕복", "미정"] as Regime[]) {
    const a = noons.filter((n) => n.rg === rg);
    if (!a.length) continue;
    const pN = a.filter((n) => n.persist !== null);
    const pY = pN.filter((n) => n.persist === true);
    const pnl = a.reduce((s, n) => s + n.pmPnl, 0);
    const legs = a.reduce((s, n) => s + n.pmLegs, 0);
    const hh = [0, 1].map((h) => a.filter((n) => n.half === h && n.persist === true).length + "/" + a.filter((n) => n.half === h && n.persist !== null).length);
    console.log(`  ${rg}: ${a.length}일 — 오후 방향지속 ${pN.length ? Math.round((100 * pY.length) / pN.length) : 0}% (전/후 ${hh.join(" · ")}) · 오후 본피셔 레그 ${legs}개 누적 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%p`);
  }
  console.log(`② 전환 횟수/일: 원시 평균 ${avg(rawTrans).toFixed(1)}·최대 ${Math.max(...rawTrans)} | 2연속 이력 평균 ${avg(hysTrans).toFixed(1)}·최대 ${Math.max(...hysTrans)}`);
  const fY = flips.filter((f) => f.persist).length;
  const fh = [0, 1].map((h) => flips.filter((f) => f.half === h && f.persist).length + "/" + flips.filter((f) => f.half === h).length);
  console.log(`   왕복·미정→추세 전환(이력): ${flips.length}건 — 전환 방향대로 마감 ${flips.length ? Math.round((100 * fY) / flips.length) : 0}% (전/후 ${fh.join(" · ")}) · 잔여 |이동| 평균 ${avg(flips.map((f) => f.remPct)).toFixed(2)}%`);
}

async function main() {
  await run("005930", "삼전", 0.075);
  await run("000660", "하닉", 0.1);
}
main().catch((e) => { console.error(e); process.exit(1); });
