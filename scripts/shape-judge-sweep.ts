// 분봉 형태(구조) 판정 실측 (사용자 구상 2026-07-30 밤 "OR·오프셋보다 분봉의 형태로 컷 덜 당하는 판정 → 피셔와 병행"):
//   npx tsx scripts/shape-judge-sweep.ts
// 규칙화: 최근 W개 1분봉이 "되돌림 작은 계단식 진행"이면 그 방향 판정 —
//   순진행 |close[i]-close[i-W+1]| ≥ g×10일폭 AND 종가가 창 신고/신저 AND 내부 최대 되돌림 ≤ d×순진행.
// 하닉/삼전 227일(프리장+정규장 연속창, 라이브 캐시), 스탑 하닉 2.5%/삼전 1.5%.
// 비교: 피셔F·M 기준선 vs 구조 단독 vs 병행(피셔F 레그를 구조 동의로 필터, 레그 합산).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
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

// 피셔 기준선 (prog5-all-sweep.ts와 동일 — 라이브 상수·earlyVol 포함)
function fisherStream(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, rev: number, emMult: number, emUntilMin: number): Tr[] {
  if (bars.length < 16) return [];
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  const out: Tr[] = [];
  let st: "none" | St = "none", up = 0, dn = 0;
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
      if (up >= conf) { st = "up"; out.push({ i, to: "up", px: b.close }); }
      else if (dn >= conf) { st = "down"; out.push({ i, to: "down", px: b.close }); }
      continue;
    }
    if (st === "up") { if (dn >= rev) { st = "down"; out.push({ i, to: "down", px: b.close }); } }
    else if (up >= rev) { st = "up"; out.push({ i, to: "up", px: b.close }); }
  }
  return out;
}

// 구조 판정: W봉 창에서 순진행 ≥ g×r10, 종가=창 극값, 내부 되돌림 ≤ d×순진행
function shapeStream(bars: MinuteBar[], r10: number, W: number, g: number, dd: number, gateMin: number): Tr[] {
  const out: Tr[] = [];
  let st: "none" | St = "none";
  const cl = bars.map((b) => b.close);
  for (let i = W - 1; i < bars.length; i++) {
    if (gateMin > 0 && tMin(bars[i].time) < gateMin) continue;
    const wc = cl.slice(i - W + 1, i + 1);
    const c = wc[W - 1];
    if (st !== "up") {
      const net = c - wc[0];
      if (net >= g * r10 && c >= Math.max(...wc)) {
        let peak = -Infinity, mdd = 0;
        for (const x of wc) { peak = Math.max(peak, x); if (peak - x > mdd) mdd = peak - x; }
        if (mdd <= dd * net) { st = "up"; out.push({ i, to: "up", px: c }); continue; }
      }
    }
    if (st !== "down") {
      const net = wc[0] - c;
      if (net >= g * r10 && c <= Math.min(...wc)) {
        let tr = Infinity, mru = 0;
        for (const x of wc) { tr = Math.min(tr, x); if (x - tr > mru) mru = x - tr; }
        if (mru <= dd * net) { st = "down"; out.push({ i, to: "down", px: c }); }
      }
    }
  }
  return out;
}

type DayB = { bars: MinuteBar[]; r10: number; close: number };
type Leg = { pnl: number; cut: boolean; i: number; to: St; day: number };
function legsOf(d: DayB, trs: Tr[], stopPct: number, day: number): Leg[] {
  const out: Leg[] = [];
  const s = stopPct / 100;
  for (let k = 0; k < trs.length; k++) {
    const e = trs[k], endI = k + 1 < trs.length ? trs[k + 1].i : d.bars.length;
    let pnl: number | null = null, cut = false;
    for (let i = e.i + 1; i < endI; i++) {
      const b = d.bars[i];
      if (e.to === "up" && b.low <= e.px * (1 - s)) { pnl = -stopPct; cut = true; break; }
      if (e.to === "down" && b.high >= e.px * (1 + s)) { pnl = -stopPct; cut = true; break; }
    }
    if (pnl === null) {
      const px2 = k + 1 < trs.length ? trs[k + 1].px : d.close;
      pnl = ((px2 - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
    }
    out.push({ pnl, cut, i: e.i, to: e.to, day });
  }
  return out;
}
function stat(legs: Leg[], firstMins: number[]): string {
  if (!legs.length) return "0건";
  const cum = legs.reduce((a, l) => a + l.pnl, 0);
  const win = Math.round((100 * legs.filter((l) => l.pnl > 0).length) / legs.length);
  const cut = Math.round((100 * legs.filter((l) => l.cut).length) / legs.length);
  let med = "--:--";
  if (firstMins.length) {
    const srt = [...firstMins].sort((a, b) => a - b);
    const m = srt[Math.floor(srt.length / 2)];
    med = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  return `${String(legs.length).padStart(3)}건 평균 ${(cum / legs.length).toFixed(2).padStart(6)}%·승률 ${String(win).padStart(3)}%·컷률 ${String(cut).padStart(3)}%·합 ${cum.toFixed(1).padStart(7)}%p·판정중앙 ${med}`;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (const cfg of [
    { code: "000660", nm: "하닉", sb: 0.1, stop: 2.5 },
    { code: "005930", nm: "삼전", sb: 0.075, stop: 1.5 },
  ]) {
    const daily = (await fetchDailyPredict(cfg.code, 500)).filter((b) => b.date < today);
    const days: DayB[] = [];
    for (let i = 130; i < daily.length; i++) {
      const reg = rc(`${cfg.code}-${daily[i].date}.json`);
      const pre = rc(`${cfg.code}NX-${daily[i].date}.json`);
      const hist = daily.slice(Math.max(0, i - 120), i);
      const r10 = avgRange(hist, 10);
      if (!reg || reg.length < 240 || r10 === null) continue;
      days.push({ bars: [...(pre ?? []), ...reg], r10, close: daily[i].close });
    }
    console.log(`\n=== ${cfg.nm} (${days.length}일) ===`);

    const collect = (mk: (d: DayB) => Tr[]) => {
      const legs: Leg[] = []; const firsts: number[] = [];
      days.forEach((d, di) => {
        const trs = mk(d);
        legs.push(...legsOf(d, trs, cfg.stop, di));
        if (trs.length) firsts.push(tMin(d.bars[trs[0].i].time));
      });
      return { legs, firsts };
    };

    const fF = collect((d) => fisherStream(d.bars, d.r10, 0.05, 4, cfg.sb, 3, 3, tMin("10:30")));
    const fM = collect((d) => fisherStream(d.bars, d.r10, 0.10, 8, 0, 3, 1.25, tMin("10:30")));
    console.log(`피셔F 기준선        ${stat(fF.legs, fF.firsts)}`);
    console.log(`피셔M 기준선        ${stat(fM.legs, fM.firsts)}`);

    let best: { W: number; g: number; dd: number; cum: number } | null = null;
    for (const W of [10, 15, 20, 30]) {
      for (const g of [0.15, 0.25, 0.35]) {
        for (const dd of [0.25, 0.4]) {
          const r = collect((d) => shapeStream(d.bars, d.r10, W, g, dd, 0));
          console.log(`구조 W${String(W).padStart(2)} g${g} d${dd}  ${stat(r.legs, r.firsts)}`);
          const cum = r.legs.reduce((a, l) => a + l.pnl, 0);
          const cut = r.legs.length ? r.legs.filter((l) => l.cut).length / r.legs.length : 1;
          if (r.legs.length >= 60 && cut <= 0.2 && (!best || cum > best.cum)) best = { W, g, dd, cum };
        }
      }
    }
    if (!best) { console.log("구조: 표본·컷 조건(≥60건·컷≤20%) 충족 조합 없음"); continue; }
    console.log(`\n[병행 — 구조 최적 W${best.W} g${best.g} d${best.dd} 기준]`);
    const mkShape = (d: DayB) => shapeStream(d.bars, d.r10, best!.W, best!.g, best!.dd, 0);
    const sh = collect(mkShape);
    // 피셔F 레그를 구조 상태로 분리 (합의 = 레그 시작 시점에 구조가 같은 방향)
    const stateAt = (d: DayB, i: number): "none" | St => {
      let st: "none" | St = "none";
      for (const t of mkShape(d)) { if (t.i <= i) st = t.to; else break; }
      return st;
    };
    const agree: Leg[] = [], disagree: Leg[] = [];
    for (const l of fF.legs) (stateAt(days[l.day], l.i) === l.to ? agree : disagree).push(l);
    console.log(`피셔F ∩ 구조 동의   ${stat(agree, [])}`);
    console.log(`피셔F 구조 비동의   ${stat(disagree, [])}`);
    const cumF = fF.legs.reduce((a, l) => a + l.pnl, 0), cumS = sh.legs.reduce((a, l) => a + l.pnl, 0);
    console.log(`레그 합산(F+구조)   합 ${(cumF + cumS).toFixed(1)}%p (F ${cumF.toFixed(1)} + 구조 ${cumS.toFixed(1)})`);
    // 09:00 게이트 변형 (프리장 저유동 프린트 영향 확인)
    const g9 = collect((d) => shapeStream(d.bars, d.r10, best!.W, best!.g, best!.dd, tMin("09:00")));
    console.log(`구조(09시 게이트)   ${stat(g9.legs, g9.firsts)}`);
  }
  console.log("\n주: 구조 = W봉 순진행 ≥ g×10일폭·종가 창극값·내부 되돌림 ≤ d×순진행. 레그 손익은 다음 전이 또는 종가 청산·스탑 컷.");
}
main().catch((e) => { console.error(e); process.exit(1); });
