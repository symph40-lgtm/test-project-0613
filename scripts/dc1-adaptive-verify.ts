// DC1·DC2 개별주 적응 임계 재검증 (사용자 승인 2026-07-26 — 2.19 기각의 마지막 반론 확인).
//   npx tsx scripts/dc1-adaptive-verify.ts   (.predict-cache 무통신)
//
// 지수용 고정 임계(0.55/0.14) 대신, 종목 자신의 과거 60일 분포에서 같은 시각 슬롯의
// **추적 분위**로 임계를 기계적으로 정한다 (vol10 66.7분위 관례와 동일 — 격자 탐색 없음):
//   추세 = DC1·DC2 모두 해당 슬롯 66.7분위 이상 (상위 1/3) · 강추세 = 모두 83.3분위 이상 (상위 1/6)
//   왕복 = 그 외 · 미정 = 방향 미형성(±0.2%)·표본 부족.
// 재검증 항목 (2.19와 동일 잣대):
//   ① 정오 분류 → 오후 방향지속·오후 본피셔 레그 경제성 분리 여부
//   ② 전환 감지(10:00~, 2연속 이력) — 횟수/일, 왕복→추세 전환 후 방향 지속률.
// 이번에도 기각이면 DC1 장중 레짐 건은 종결.

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
const BAND = 0.2;

// 슬롯별 DC1·DC2 (누적, 5분청크) — 방향 미형성이면 null
function dcAtSlot(reg: MinuteBar[], uptoIdx: number): { dc1: number; dc2: number } | null {
  const ch: { o: number; c: number }[] = [];
  for (let i = 0; i + 5 <= uptoIdx + 1; i += 5) ch.push({ o: reg[i].open, c: reg[i + 4].close });
  if (ch.length < 3) return null;
  const dayOpen = reg[0].open;
  const last = ch[ch.length - 1].c;
  const dir = last > dayOpen * (1 + BAND / 100) ? 1 : last < dayOpen * (1 - BAND / 100) ? -1 : 0;
  if (dir === 0) return null;
  const dc1 = ch.filter((x) => Math.sign(x.c - x.o) === dir).length / ch.length;
  const path = ch.reduce((s, x) => s + Math.abs(x.c - x.o), 0);
  if (path <= 0) return null;
  return { dc1, dc2: Math.abs(last - dayOpen) / path };
}
const pctl = (arr: number[], p: number): number => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

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

type Regime = "미정" | "강추세" | "추세" | "왕복";

async function run(code: string, name: string, sb: number): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 364)).filter((b) => b.date < today);
  const dates = daily.slice(-224).map((b) => b.date).filter((d) => (readCache(`${code}-${d}.json`)?.length ?? 0) >= 240);
  // 1패스: 날×슬롯 DC 시계열 사전 계산 (슬롯 = 5분봉 완성 인덱스)
  const perDay = new Map<string, Map<number, { dc1: number; dc2: number }>>();
  for (const d of dates) {
    const reg = readCache(`${code}-${d}.json`)!;
    const m = new Map<number, { dc1: number; dc2: number }>();
    for (let i = 0; i < reg.length; i++) {
      const t = tMin(reg[i].time);
      if ((t - 9 * 60) % 5 !== 4) continue;
      const v = dcAtSlot(reg, i);
      if (v) m.set(t, v);
    }
    perDay.set(d, m);
  }
  // 슬롯별 추적 66.7·83.3분위 임계 (직전 60일 — 선견 없음)
  const classify = (dIdx: number, slotT: number): Regime => {
    const d = dates[dIdx];
    const v = perDay.get(d)!.get(slotT);
    if (!v) return "미정";
    const h1: number[] = [], h2: number[] = [];
    for (let k = Math.max(0, dIdx - 60); k < dIdx; k++) {
      const pv = perDay.get(dates[k])!.get(slotT);
      if (pv) { h1.push(pv.dc1); h2.push(pv.dc2); }
    }
    if (h1.length < 30) return "미정";
    const t1 = pctl(h1, 2 / 3), t2 = pctl(h2, 2 / 3);
    const s1 = pctl(h1, 5 / 6), s2 = pctl(h2, 5 / 6);
    if (v.dc1 >= s1 && v.dc2 >= s2) return "강추세";
    if (v.dc1 >= t1 && v.dc2 >= t2) return "추세";
    return "왕복";
  };

  type Noon = { rg: Regime; dir: number; persist: boolean | null; pmPnl: number; half: 0 | 1 };
  const noons: Noon[] = [];
  const hysTrans: number[] = [];
  let flipN = 0, flipHit = 0;
  for (let di = 0; di < dates.length; di++) {
    const d = dates[di];
    const i = daily.findIndex((b) => b.date === d);
    if (i < 30) continue;
    const r10 = avgRange(daily.slice(Math.max(0, i - 120), i), 10);
    if (r10 === null) continue;
    const reg = readCache(`${code}-${d}.json`)!;
    const half: 0 | 1 = di < dates.length / 2 ? 0 : 1;
    // ① 정오
    const noonSlot = 12 * 60 - 1; // 11:59 완성 5분봉
    const slots = [...(perDay.get(d)!.keys())].sort((a, b) => a - b);
    const nearNoon = slots.filter((s) => s <= noonSlot).pop();
    if (nearNoon === undefined) continue;
    const rg = classify(di, nearNoon);
    const noonIdx = reg.findIndex((b) => tMin(b.time) >= 12 * 60) - 1;
    if (noonIdx < 20) continue;
    const pxNoon = reg[noonIdx].close;
    const close = reg[reg.length - 1].close;
    const dayOpen = reg[0].open;
    const dir = pxNoon > dayOpen * (1 + BAND / 100) ? 1 : pxNoon < dayOpen * (1 - BAND / 100) ? -1 : 0;
    const persist = dir !== 0 ? Math.sign(close - pxNoon) === dir : null;
    const bon = bonStream(reg, 0.15 * r10, sb * r10);
    let pmPnl = 0;
    for (let k = 0; k < bon.length; k++) {
      if (bon[k].idx <= noonIdx) continue;
      const endIdx = k + 1 < bon.length ? bon[k + 1].idx : reg.length - 1;
      const dirUp = bon[k].to === "up";
      let pnl: number | null = null;
      for (let j = bon[k].idx + 1; j <= endIdx; j++) {
        const adv = dirUp ? ((reg[j].low - bon[k].px) / bon[k].px) * 100 : ((bon[k].px - reg[j].high) / bon[k].px) * 100;
        if (adv <= -STOP) { pnl = -STOP; break; }
      }
      if (pnl === null) pnl = ((reg[endIdx].close - bon[k].px) / bon[k].px) * 100 * (dirUp ? 1 : -1);
      pmPnl += pnl;
    }
    noons.push({ rg, dir, persist, pmPnl, half });
    // ② 전환 (10:00~, 2연속 이력)
    let held: Regime | null = null, pend: Regime | null = null, pendN = 0, hys = 0;
    for (const s of slots) {
      if (s < 10 * 60) continue;
      const c = classify(di, s);
      if (held === null) { held = c; continue; }
      if (c === held) { pend = null; pendN = 0; continue; }
      if (c === pend) {
        pendN++;
        if (pendN >= 2) {
          hys++;
          if ((held === "왕복" || held === "미정") && (c === "추세" || c === "강추세")) {
            const bi = reg.findIndex((b) => tMin(b.time) === s);
            if (bi > 0) {
              const dirS = reg[bi].close > reg[0].open * (1 + BAND / 100) ? 1 : reg[bi].close < reg[0].open * (1 - BAND / 100) ? -1 : 0;
              if (dirS !== 0) { flipN++; if (Math.sign(reg[reg.length - 1].close - reg[bi].close) === dirS) flipHit++; }
            }
          }
          held = c; pend = null; pendN = 0;
        }
      } else { pend = c; pendN = 1; }
    }
    hysTrans.push(hys);
  }
  console.log(`\n════ ${name} — ${noons.length}일 (적응 임계: 슬롯별 추적 66.7/83.3분위) ════`);
  for (const rg of ["강추세", "추세", "왕복", "미정"] as Regime[]) {
    const a = noons.filter((n) => n.rg === rg);
    if (!a.length) continue;
    const pN = a.filter((n) => n.persist !== null);
    const pY = pN.filter((n) => n.persist === true).length;
    const hh = [0, 1].map((h) => {
      const b = a.filter((n) => n.half === h && n.persist !== null);
      return `${b.filter((n) => n.persist).length}/${b.length}`;
    });
    console.log(`  정오 ${rg}: ${a.length}일 — 오후 방향지속 ${pN.length ? Math.round((100 * pY) / pN.length) : 0}% (전/후 ${hh.join(" · ")}) · 오후 본피셔 ${a.reduce((s, n) => s + n.pmPnl, 0).toFixed(1)}%p`);
  }
  const avg = hysTrans.length ? hysTrans.reduce((s, x) => s + x, 0) / hysTrans.length : 0;
  console.log(`  전환(이력)/일: 평균 ${avg.toFixed(1)}·최대 ${Math.max(...hysTrans)} | 왕복→추세 전환 ${flipN}건 — 방향대로 마감 ${flipN ? Math.round((100 * flipHit) / flipN) : 0}%`);
}

async function main() {
  await run("005930", "삼전", 0.075);
  await run("000660", "하닉", 0.1);
}
main().catch((e) => { console.error(e); process.exit(1); });
