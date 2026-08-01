// 창판정 윈도우 7봉 확장 실측 (사용자 질문 2026-08-01 "7개로 하고 6중4(완화)/6중5(강화)면 어떤 차이"):
//   npx tsx scripts/cw-window7-sweep.ts
// 변형 대응 (시가 2/3 연결은 skip 관용으로, 기울기 40°는 통과 수로 표현):
//   현행 6봉(5중4): 체인 6·skip≤2·기울기 ≥4/5
//   7봉 완화(6중4): 체인 7·skip≤3·기울기 ≥4/6
//   7봉 강화(6중5): 체인 7·skip≤2·기울기 ≥5/6
// 그 외 조건(|10°| 0개·중앙 이탈 ≤1·몸통 두께 미달 ≤1·역색봉 ≤1(원창 N봉))·각도 눈금(평균폭×0.5=45°)·
// 스탑 -2.5%는 라이브와 동일. 하닉 227일 — ①단독(일 최초 판정, 종가보유/전환청산) ②피셔F 겹침·범주 품질.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { unitArr } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const D = 180 / Math.PI;
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const hlmid = (b: MinuteBar) => (b.high + b.low) / 2;

function buildChain(bars: MinuteBar[], i: number, dir: 1 | -1, N: number, maxSkip: number): number[] | null {
  let poolLen = N;
  if (i + poolLen > bars.length) return null;
  const chain = [i];
  let skips = 0, j = i + 1;
  while (chain.length < N) {
    if (j >= i + poolLen) return null;
    const base = bars[chain[chain.length - 1]], cand = bars[j];
    const bLo = Math.min(base.open, base.close), bHi = Math.max(base.open, base.close);
    const ok = dir === 1 ? cand.open >= bLo + (2 / 3) * (bHi - bLo) : cand.open <= bLo + (1 / 3) * (bHi - bLo);
    if (ok) chain.push(j);
    else {
      skips++;
      if (skips > maxSkip) return null;
      if (poolLen < N + maxSkip && i + poolLen < bars.length) poolLen++;
    }
    j++;
  }
  return chain;
}

function judgeAt(bars: MinuteBar[], i: number, dir: 1 | -1, unit: number[], N: number, maxSkip: number, ge40Need: number): number | null {
  const chain = buildChain(bars, i, dir, N, maxSkip);
  if (!chain) return null;
  let ge40 = 0, flat = 0, midBreak = 0;
  for (let p = 0; p < N - 1; p++) {
    const a = chain[p], b = chain[p + 1];
    const ang = Math.atan((dir * (bmid(bars[b]) - bmid(bars[a]))) / unit[a]) * D;
    if (ang >= 40) ge40++;
    if (Math.abs(ang) <= 10) flat++;
    const m = hlmid(bars[a]);
    if (dir === 1 ? bars[b].low < m : bars[b].high > m) midBreak++;
  }
  if (ge40 < ge40Need || flat > 0 || midBreak > 1) return null;
  let thin = 0, wrongColor = 0;
  for (let k = i; k < i + N; k++) {
    const rng = bars[k].high - bars[k].low;
    const body = Math.abs(bars[k].close - bars[k].open);
    if (rng <= 0 || body < 0.2 * rng) thin++;
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrongColor++;
  }
  if (thin > 1 || wrongColor > 1) return null;
  return chain[N - 1];
}

type Tr = { i: number; to: 1 | -1; px: number };
function stream(bars: MinuteBar[], unit: number[], N: number, maxSkip: number, ge40Need: number): Tr[] {
  const out: Tr[] = [];
  let st: 0 | 1 | -1 = 0;
  for (let t = N - 1; t < bars.length; t++) {
    let jd: 1 | -1 | 0 = 0;
    for (const dir of [1, -1] as const) {
      for (let start = t - (N + maxSkip - 1); start <= t - (N - 1); start++) {
        if (start < 0) continue;
        if (judgeAt(bars, start, dir, unit, N, maxSkip, ge40Need) === t) { jd = dir; break; }
      }
      if (jd) break;
    }
    if (jd && jd !== st) { st = jd; out.push({ i: t, to: jd, px: bars[t].close }); }
  }
  return out;
}

function fisherFirst(bars: MinuteBar[], r10: number): { dir: 1 | -1; i: number; px: number } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = tMin("10:30");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = tMin(b.time) < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (up >= 4) return { dir: 1, i, px: b.close };
    if (dn >= 4) return { dir: -1, i, px: b.close };
  }
  return null;
}

type Q = { pnl: number; cut: boolean };
function holdPnl(bars: MinuteBar[], j: { i: number; dir: 1 | -1; px: number }, close: number, endI?: number, exitPx?: number): Q {
  const s = 2.5 / 100;
  const lim = endI ?? bars.length;
  for (let k = j.i + 1; k < lim; k++) {
    const b = bars[k];
    if (j.dir === 1 ? b.low <= j.px * (1 - s) : b.high >= j.px * (1 + s)) return { pnl: -2.5, cut: true };
  }
  const px2 = exitPx ?? close;
  return { pnl: ((px2 - j.px) / j.px) * 100 * j.dir, cut: false };
}
const fmt = (qs: Q[]): string => {
  if (!qs.length) return "0건";
  const n = qs.length;
  const sum = qs.reduce((a, q) => a + q.pnl, 0);
  const win = Math.round((100 * qs.filter((q) => q.pnl > 0).length) / n);
  const cut = Math.round((100 * qs.filter((q) => q.cut).length) / n);
  return `${n}건 평균 ${sum / n >= 0 ? "+" : ""}${(sum / n).toFixed(2)}%·승률 ${win}%·컷률 ${cut}%·합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1)}%p`;
};

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  type Day = { bars: MinuteBar[]; unit: number[]; r10: number; close: number };
  const days: Day[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    days.push({ bars, unit: unitArr(bars, r10), r10, close: daily[i].close });
  }
  const fFirsts = days.map((d) => fisherFirst(d.bars, d.r10));
  for (const v of [
    { name: "현행 6봉(5중4)", N: 6, skip: 2, need: 4 },
    { name: "7봉 완화(6중4)", N: 7, skip: 3, need: 4 },
    { name: "7봉 강화(6중5)", N: 7, skip: 2, need: 5 },
  ]) {
    const hold: Q[] = [], flip: Q[] = [];
    let judged = 0;
    let bothSame = 0, bothDiff = 0, cwOnly = 0, fOnly = 0, neither = 0;
    const commonHold: Q[] = [], diffHold: Q[] = [], commonF: Q[] = [], diffF: Q[] = [];
    days.forEach((d, di) => {
      const trs = stream(d.bars, d.unit, v.N, v.skip, v.need);
      const fJ = fFirsts[di];
      if (!trs.length) {
        if (fJ) fOnly++; else neither++;
        return;
      }
      judged++;
      const e = { i: trs[0].i, dir: trs[0].to, px: trs[0].px };
      const hq = holdPnl(d.bars, e, d.close);
      hold.push(hq);
      const opp = trs.find((t) => t.i > e.i && t.to !== e.dir);
      flip.push(opp ? holdPnl(d.bars, e, d.close, opp.i, opp.px) : hq);
      if (!fJ) { cwOnly++; return; }
      const fq = holdPnl(d.bars, fJ, d.close);
      if (fJ.dir === e.dir) { bothSame++; commonHold.push(hq); commonF.push(fq); }
      else { bothDiff++; diffHold.push(hq); diffF.push(fq); }
    });
    console.log(`\n=== ${v.name} — 판정 ${judged}일 / 무판정 ${days.length - judged}일 ===`);
    console.log(`단독 종가보유: ${fmt(hold)}`);
    console.log(`단독 전환청산: ${fmt(flip)}`);
    console.log(`겹침: 공통 ${bothSame} · 이견 ${bothDiff} · 창만 ${cwOnly} · F만 ${fOnly} · 무판정 ${neither}`);
    console.log(`  공통일 — 창진입: ${fmt(commonHold)} | F진입: ${fmt(commonF)}`);
    console.log(`  이견일 — 창진입: ${fmt(diffHold)} | F진입: ${fmt(diffF)}`);
  }
  console.log("\n주: 진입 = 일 최초 풀판정·스탑 -2.5%. 전환청산 = 첫 반대 풀판정 시점 청산(컷 선행 시 컷).");
}
main().catch((e) => { console.error(e); process.exit(1); });
