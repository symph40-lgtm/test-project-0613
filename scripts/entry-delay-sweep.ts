// 진입 지연 실측 — 새 비중(20/30/50) 기준 (사용자 질문 2026-07-30 밤 — "10:30 이후부터 진입은
// 어때? 10:20도 좋고. 그 이전엔 변동이 크고 큰 추세는 10:30 이후 형성되는 것 같다"):
//   npx tsx scripts/entry-delay-sweep.ts
// 정책: 지연 시각 이전의 전이는 진입하지 않고, 지연 시각 도달 시 그 시점 상태로 진입(상태 승계).
// 계좌 = F×0.2 + M×0.3 + 본×0.5 (역순 비중), 실전 스탑(하닉 -2.5%·삼전 -1.5%), 현행 라이브 상수.
// 참고: 구 실측(F 단독·구 비중)에선 하닉 10:30 지연이 -42%p 대훼손이었음 — 새 체계로 재검.

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
type Tr = { i: number; t: number; to: St; px: number };
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
      if (up >= conf) { st = "up"; ext = b.close; run = 0; out.push({ i, t: tMin(b.time), to: "up", px: b.close }); }
      else if (dn >= conf) { st = "down"; ext = b.close; run = 0; out.push({ i, t: tMin(b.time), to: "down", px: b.close }); }
      continue;
    }
    if (st === "up") {
      ext = Math.max(ext, b.close);
      run = trW > 0 && b.close < ext - trW ? run + 1 : 0;
      if (dn >= rev || (trW > 0 && run >= trailN)) { st = "down"; ext = b.close; run = 0; out.push({ i, t: tMin(b.time), to: "down", px: b.close }); }
    } else {
      ext = Math.min(ext, b.close);
      run = trW > 0 && b.close > ext + trW ? run + 1 : 0;
      if (up >= rev || (trW > 0 && run >= trailN)) { st = "up"; ext = b.close; run = 0; out.push({ i, t: tMin(b.time), to: "up", px: b.close }); }
    }
  }
  return out;
}

// 진입 지연 적용 레그 손익: startMin 이전 전이 무시, 도달 시 상태 승계 진입
function delayedPnl(bars: MinuteBar[], trs: Tr[], close: number, stopPct: number, startMin: number): { p: number; cutLoss: number } {
  const acts: Tr[] = [];
  for (let i = 0; i < trs.length; i++) {
    const t = trs[i];
    if (t.t >= startMin) acts.push(t);
    else if (i + 1 === trs.length || trs[i + 1].t >= startMin) {
      const bi = bars.findIndex((b) => tMin(b.time) >= startMin);
      if (bi >= 0) acts.push({ i: bi, t: tMin(bars[bi].time), to: t.to, px: bars[bi].close });
    }
  }
  let p = 0, cutLoss = 0;
  const s = stopPct / 100;
  for (let k = 0; k < acts.length; k++) {
    const e = acts[k], endI = k + 1 < acts.length ? acts[k + 1].i : bars.length;
    let x: number | null = null;
    for (let i = e.i + 1; i < endI; i++) {
      const b = bars[i];
      if (e.to === "up" && b.low <= e.px * (1 - s)) { x = -stopPct; cutLoss += stopPct; break; }
      if (e.to === "down" && b.high >= e.px * (1 + s)) { x = -stopPct; cutLoss += stopPct; break; }
    }
    if (x === null) {
      const px2 = k + 1 < acts.length ? acts[k + 1].px : close;
      x = ((px2 - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
    }
    p += x;
  }
  return { p, cutLoss };
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const DELAYS: [string, number][] = [["즉시(현행)", 0], ["10:00부터", tMin("10:00")], ["10:20부터", tMin("10:20")], ["10:30부터", tMin("10:30")]];
  for (const cfg of [
    { code: "000660", nm: "하닉", sb: 0.1, stop: 2.5, trailR: 0.35, trailN: 5, trailAll: true },
    { code: "005930", nm: "삼전", sb: 0.075, stop: 1.5, trailR: 0.3, trailN: 3, trailAll: false },
  ]) {
    const daily = (await fetchDailyPredict(cfg.code, 500)).filter((b) => b.date < today);
    type D = { cont: MinuteBar[]; reg: MinuteBar[]; r10: number; close: number; trail: boolean };
    const days: D[] = [];
    for (let i = 130; i < daily.length; i++) {
      const reg = rc(`${cfg.code}-${daily[i].date}.json`);
      const pre = rc(`${cfg.code}NX-${daily[i].date}.json`);
      const hist = daily.slice(Math.max(0, i - 120), i);
      const r10 = avgRange(hist, 10);
      if (!reg || reg.length < 240 || r10 === null) continue;
      days.push({ cont: [...(pre ?? []), ...reg], reg, r10, close: daily[i].close, trail: cfg.trailAll || isHighVolDay(hist) });
    }
    console.log(`\n════ ${cfg.nm} ${days.length}일 — 계좌(비중 20/30/50)·실전 스탑 -${cfg.stop}% ════`);
    for (const [tag, delay] of DELAYS) {
      let tot = 0, h1 = 0, h2 = 0, worst = 0, cutTot = 0;
      days.forEach((d, i2) => {
        const F = delayedPnl(d.cont, stream(d.cont, d.r10, 0.05, 4, cfg.sb, 3, 3, tMin("10:30")), d.close, cfg.stop, delay);
        const M = delayedPnl(d.cont, stream(d.cont, d.r10, 0.10, 8, 0, 3, 1.25, tMin("10:30")), d.close, cfg.stop, delay);
        const B = delayedPnl(d.reg, stream(d.reg, d.r10, 0.15, 8, cfg.sb, 3, 1, 0, d.trail ? cfg.trailR : 0, cfg.trailN), d.close, cfg.stop, delay);
        const p = F.p * 0.2 + M.p * 0.3 + B.p * 0.5;
        tot += p;
        if (i2 < days.length / 2) h1 += p; else h2 += p;
        if (p < worst) worst = p;
        cutTot += F.cutLoss * 0.2 + M.cutLoss * 0.3 + B.cutLoss * 0.5;
      });
      console.log(`  ${tag.padEnd(11)} 합 ${f1(tot).padStart(7)}%p (전/후반 ${f1(h1)}/${f1(h2)}) | 최악일 ${worst.toFixed(1)} | 컷 실손 ${f1(-cutTot)}%p`);
    }
  }
  console.log(`\n주: 지연 = 그 시각 이전 전이 미진입, 도달 시 현재 상태로 진입(상태 승계). 본피셔 확인은 대부분 10시 이후라 영향 제한적.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
