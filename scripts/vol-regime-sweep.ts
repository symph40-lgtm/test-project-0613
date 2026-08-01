// 변동성 레짐별 전략 실측 (사용자 가설 2026-08-01 "고변동일은 빨리 탈출·저변동 추세일은 보유"):
//   npx tsx scripts/vol-regime-sweep.ts
// 사전 분류: isHighVolDay(전일까지 일봉) — 라이브 삼전 트레일 게이트와 동일 지표 (무선견).
// 레짐별 측정: ①창판정 발생률·이견률 ②사다리(채택 규칙판) 성적 ③이견 즉시100 재진입 기여
// ④창 첫 레그 전환청산 vs 종가보유 — 가설: 고변동일은 조기 이탈 우위, 저변동일은 보유 우위인가.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

function fisherFirst(bars: MinuteBar[], r10: number): { t: number; i: number; dir: 1 | -1; px: number } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = tMin("10:30"), from9 = tMin("09:00");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const t = tMin(b.time);
    const em = t < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (t < from9) continue;
    if (up >= 4) return { t, i, dir: 1, px: b.close };
    if (dn >= 4) return { t, i, dir: -1, px: b.close };
  }
  return null;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  type Q = { pnl: number; cut: boolean };
  type Reg = {
    n: number; cwDays: 0; diffDays: number; ladder: number; ladderWorst: number; ladderCutD: number;
    revImm: Q[]; cwHold: Q[]; cwFlipEx: Q[];
  };
  const mk = (): Reg => ({ n: 0, cwDays: 0 as 0, diffDays: 0, ladder: 0, ladderWorst: 0, ladderCutD: 0, revImm: [], cwHold: [], cwFlipEx: [] });
  const regs: Record<"고" | "저", Reg> = { 고: mk(), 저: mk() };
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const close = daily[i].close;
    const hv = isHighVolDay(hist) ? "고" : "저";
    const R = regs[hv];
    R.n++;
    const leg = (i0: number, dir: 1 | -1, px: number, endI?: number, endPx?: number): Q => {
      const s = 2.5 / 100;
      const lim = endI ?? bars.length;
      for (let k = i0 + 1; k < lim; k++) {
        const b = bars[k];
        if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return { pnl: -2.5, cut: true };
      }
      return { pnl: (((endI !== undefined ? endPx ?? close : close) - px) / px) * 100 * dir, cut: false };
    };
    // 사다리 (확정 규칙판, 서킷브레이커 없이 — 레짐 순수 비교. 8/1 2차 확정 후 시그니처에 레짐 전달)
    const lad = simLadder(bars, r10, close, trs, false, hv === "고");
    R.ladder += lad.pnl;
    R.ladderWorst = Math.min(R.ladderWorst, lad.pnl);
    if (lad.cut) R.ladderCutD++;
    const f = fisherFirst(bars, r10);
    if (trs.length) {
      (R as { cwDays: number }).cwDays++;
      const cw0 = trs[0];
      const cwDir = (cw0.to === "up" ? 1 : -1) as 1 | -1;
      const flip = trs.find((t) => t.i > cw0.i && t.to !== cw0.to);
      // 창 첫 레그: 종가보유 vs 전환청산
      R.cwHold.push(leg(cw0.i, cwDir, cw0.px));
      R.cwFlipEx.push(flip ? leg(cw0.i, cwDir, cw0.px, flip.i, flip.px) : leg(cw0.i, cwDir, cw0.px));
      // 이견 즉시 100% 재진입 기여
      if (f && f.t < tMin(bars[cw0.i].time) && f.dir !== cwDir) {
        R.diffDays++;
        const nextOpp = trs.find((t) => t.i > cw0.i && t.to !== cw0.to);
        R.revImm.push(leg(cw0.i, cwDir, cw0.px, nextOpp?.i, nextOpp?.px));
      }
    }
  }
  const fmt = (qs: Q[]): string => {
    if (!qs.length) return "0건";
    const n = qs.length, sum = qs.reduce((a, q) => a + q.pnl, 0);
    return `${n}건 합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1)}%p (건당 ${(sum / n).toFixed(2)})·승률 ${Math.round((100 * qs.filter((q) => q.pnl > 0).length) / n)}%·컷률 ${Math.round((100 * qs.filter((q) => q.cut).length) / n)}%`;
  };
  for (const k of ["고", "저"] as const) {
    const R = regs[k];
    console.log(`\n=== ${k}변동 예상일 ${R.n}일 (사전 분류) ===`);
    console.log(`창판정 발생 ${R.cwDays}일(${Math.round((100 * R.cwDays) / R.n)}%) · 이견 ${R.diffDays}일`);
    console.log(`사다리(채택판·서킷 제외): 합 ${R.ladder >= 0 ? "+" : ""}${R.ladder.toFixed(1)}%p (일당 ${(R.ladder / R.n).toFixed(2)}) · 최악일 ${R.ladderWorst.toFixed(2)}% · 컷일 ${R.ladderCutD}`);
    console.log(`이견 즉시100 재진입: ${fmt(R.revImm)}`);
    console.log(`창 첫 레그 종가보유: ${fmt(R.cwHold)}`);
    console.log(`창 첫 레그 전환청산: ${fmt(R.cwFlipEx)}`);
  }
  console.log("\n주: 고변동 = isHighVolDay(전일까지 일봉, 라이브 동일 지표). 사다리는 X0.3·재진입50%·30분 채택판.");
}
main().catch((e) => { console.error(e); process.exit(1); });
