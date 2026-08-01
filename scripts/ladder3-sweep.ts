// 3단 사다리 실측 (사용자 승인 2026-08-01 "실측해 보자" — F 30% → 진행성 중간 증액 → 창 동의 100%):
//   npx tsx scripts/ladder3-sweep.ts
// 규칙 (전부 실시간 순서, 하닉 227일):
//   ① F 첫 판정 → 30% (판정가 앵커 스탑 -2.5%)
//   ② F+5봉 진행성(전진 ≥ 0.1×10일폭, 라이브 진행성 문자와 동일 기준) 충족 → 중간 비중까지 증액
//      (5봉째 종가 앵커) — 창 동의가 그 전에 오면 이미 100%라 생략
//   ③ 창판정 동의 → 100%까지 증액 (확인가 앵커) / 창판정 반대 → 전량 청산 후 창 방향 100%
//   ④ 창판정 선행 시 즉시 100% (이후 F 신호는 무변화 — hier-weight-sweep와 동일 틀)
//   ⑤ 트랜치별 스탑 -2.5%, 잔여는 종가 청산
// 진행성 증액분(②)의 손익을 사후 범주(공통/이견/F단독)로 분해 — F단독일 회수액 vs 이견일 함정 비용.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { candleJudgeStream, unitArr } from "../lib/predict/candleWindow";
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
  const emUntil = tMin("10:30");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = tMin(b.time) < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (up >= 4) return { t: tMin(b.time), i, dir: 1, px: b.close };
    if (dn >= 4) return { t: tMin(b.time), i, dir: -1, px: b.close };
  }
  return null;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  type Day = {
    bars: MinuteBar[]; close: number; r10: number;
    fJ: ReturnType<typeof fisherFirst>;
    cw: { t: number; i: number; dir: 1 | -1; px: number } | null;
    cat: "공통" | "이견" | "F만" | "창만" | "무";
    progI: number | null; progOk: boolean; // F+5봉 인덱스·충족 여부
  };
  const days: Day[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const cw = trs.length ? { t: tMin(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
    const fJ = fisherFirst(bars, r10);
    const cat = fJ && cw ? (fJ.dir === cw.dir ? "공통" : "이견") : fJ ? "F만" : cw ? "창만" : "무";
    let progI: number | null = null, progOk = false;
    if (fJ && fJ.i + 5 < bars.length) {
      progI = fJ.i + 5;
      progOk = (bars[progI].close - fJ.px) * fJ.dir >= 0.1 * r10;
    }
    days.push({ bars, close: daily[i].close, r10, fJ, cw, cat, progI, progOk });
  }

  // 트랜치 손익: 자체 앵커 스탑 -2.5%, forceI 전 강제 청산(그 가격), 아니면 종가
  const tr = (d: Day, i0: number, dir: 1 | -1, px: number, size: number, forceI?: number, forcePx?: number): number => {
    if (size <= 0) return 0;
    const s = 2.5 / 100;
    const lim = forceI ?? d.bars.length;
    for (let k = i0 + 1; k < lim; k++) {
      const b = d.bars[k];
      if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return -2.5 * size;
    }
    const px2 = forceI !== undefined ? (forcePx ?? d.close) : d.close;
    return ((px2 - px) / px) * 100 * dir * size;
  };

  const run = (mid: number | null): { total: number; prog: Record<string, number>; worst: number } => {
    let total = 0, worst = 0;
    const prog: Record<string, number> = { 공통: 0, 이견: 0, F만: 0 };
    for (const d of days) {
      let pnl = 0;
      const { fJ, cw } = d;
      const fFirst = fJ && (!cw || fJ.t < cw.t);
      if (fFirst && fJ) {
        const oppI = cw && cw.dir !== fJ.dir ? cw.i : undefined;
        const oppPx = cw && cw.dir !== fJ.dir ? cw.px : undefined;
        pnl += tr(d, fJ.i, fJ.dir, fJ.px, 0.3, oppI, oppPx); // ① 정찰 30%
        let held = 0.3;
        // ② 진행성 증액 — 창 동의·반대가 그 전에 오면 생략
        const cwEventI = cw ? cw.i : Infinity;
        if (mid !== null && d.progOk && d.progI !== null && d.progI < cwEventI) {
          const addSize = mid - held;
          const p = tr(d, d.progI, fJ.dir, d.bars[d.progI].close, addSize, oppI, oppPx);
          pnl += p;
          held = mid;
          if (d.cat === "공통" || d.cat === "이견" || d.cat === "F만") prog[d.cat] += p;
        }
        if (cw) {
          if (cw.dir === fJ.dir) pnl += tr(d, cw.i, cw.dir, cw.px, 1.0 - held); // ③ 동의 → 100%
          else pnl += tr(d, cw.i, cw.dir, cw.px, 1.0); // ③ 반대 → 역전환 100% (기존 트랜치는 위에서 강제 청산)
        }
      } else if (cw) {
        pnl += tr(d, cw.i, cw.dir, cw.px, 1.0); // ④ 창 선행 → 즉시 100%
      }
      total += pnl;
      worst = Math.min(worst, pnl);
    }
    return { total, prog, worst };
  };

  const base = run(null);
  console.log(`2단 기준선 (30→창100):        합 ${base.total >= 0 ? "+" : ""}${base.total.toFixed(1)}%p · 최악일 ${base.worst.toFixed(2)}%`);
  for (const mid of [0.5, 0.6, 0.7]) {
    const r = run(mid);
    const d = r.total - base.total;
    console.log(`3단 30→${Math.round(mid * 100)}(진행성)→창100: 합 ${r.total >= 0 ? "+" : ""}${r.total.toFixed(1)}%p (기준선 대비 ${d >= 0 ? "+" : ""}${d.toFixed(1)}) · 최악일 ${r.worst.toFixed(2)}%`);
    console.log(`   └ 진행성 증액분 기여: F단독일 ${r.prog["F만"] >= 0 ? "+" : ""}${r.prog["F만"].toFixed(1)}%p · 공통일 ${r.prog["공통"] >= 0 ? "+" : ""}${r.prog["공통"].toFixed(1)}%p · 이견일(함정) ${r.prog["이견"] >= 0 ? "+" : ""}${r.prog["이견"].toFixed(1)}%p`);
  }
  const progDays = days.filter((dd) => dd.fJ && dd.progOk).length;
  const fDays = days.filter((dd) => dd.fJ).length;
  console.log(`\n주: F 판정 ${fDays}일 중 진행성 충족 ${progDays}일. 증액분 앵커는 5봉째 종가·스탑 -2.5%.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
