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

  // tier3 (사용자 제안 2026-08-01 "창을 기다릴 수 없으니"): 창 없이 100% 가는 제3 트리거
  //   advance: 판정가 대비 전진 ≥ x×r10 도달 봉에서 100% / prog10: F+10봉 전진 ≥ y×r10이면 100%
  type Tier3 = { type: "advance"; x: number } | { type: "prog10"; y: number } | null;
  // exitOnFOpp: 창 선행일에 F가 나중에 반대로 서면 그 시점 청산 (창선행+F반대 4일 전패 실측 — 대칭 규칙)
  const run = (mid: number | null, tier3: Tier3 = null, exitOnFOpp = false): { total: number; prog: Record<string, number>; t3: Record<string, number>; worst: number } => {
    let total = 0, worst = 0;
    const prog: Record<string, number> = { 공통: 0, 이견: 0, F만: 0 };
    const t3sum: Record<string, number> = { 공통: 0, 이견: 0, F만: 0 };
    for (const d of days) {
      let pnl = 0;
      const { fJ, cw } = d;
      const fFirst = fJ && (!cw || fJ.t < cw.t);
      if (fFirst && fJ) {
        const oppI = cw && cw.dir !== fJ.dir ? cw.i : undefined;
        const oppPx = cw && cw.dir !== fJ.dir ? cw.px : undefined;
        pnl += tr(d, fJ.i, fJ.dir, fJ.px, 0.3, oppI, oppPx); // ① 정찰 30%
        let held = 0.3;
        const cwEventI = cw ? cw.i : Infinity;
        // 제3 트리거 발동 인덱스 계산
        let t3I: number | null = null;
        if (tier3?.type === "advance") {
          for (let k = fJ.i + 1; k < d.bars.length; k++) {
            if ((d.bars[k].close - fJ.px) * fJ.dir >= tier3.x * d.r10) { t3I = k; break; }
          }
        } else if (tier3?.type === "prog10" && fJ.i + 10 < d.bars.length) {
          if ((d.bars[fJ.i + 10].close - fJ.px) * fJ.dir >= tier3.y * d.r10) t3I = fJ.i + 10;
        }
        // 이벤트를 시간순 적용: ②진행성(→mid) · ③제3트리거(→100) · 창 동의(→100)
        type Ev = { i: number; target: number; px: number; kind: "prog" | "t3" | "cw" };
        const evs: Ev[] = [];
        if (mid !== null && d.progOk && d.progI !== null) evs.push({ i: d.progI, target: mid, px: d.bars[d.progI].close, kind: "prog" });
        if (t3I !== null) evs.push({ i: t3I, target: 1.0, px: d.bars[t3I].close, kind: "t3" });
        if (cw && cw.dir === fJ.dir) evs.push({ i: cw.i, target: 1.0, px: cw.px, kind: "cw" });
        evs.sort((a, b) => a.i - b.i);
        for (const ev of evs) {
          if (ev.i >= cwEventI && ev.kind !== "cw") continue; // 창 이벤트 이후는 창이 처리
          if (oppI !== undefined && ev.i >= oppI) break;
          const add = ev.target - held;
          if (add <= 0) continue;
          const p = tr(d, ev.i, fJ.dir, ev.px, add, oppI, oppPx);
          pnl += p;
          held = ev.target;
          if (d.cat === "공통" || d.cat === "이견" || d.cat === "F만") {
            if (ev.kind === "prog") prog[d.cat] += p;
            if (ev.kind === "t3") t3sum[d.cat] += p;
          }
        }
        if (cw && cw.dir !== fJ.dir) pnl += tr(d, cw.i, cw.dir, cw.px, 1.0); // 반대 → 역전환 100%
      } else if (cw) {
        // ④ 창 선행 → 즉시 100% (옵션: 이후 F 반대 시 그 시점 청산)
        const fOppLate = exitOnFOpp && fJ && fJ.dir !== cw.dir;
        pnl += tr(d, cw.i, cw.dir, cw.px, 1.0, fOppLate ? fJ!.i : undefined, fOppLate ? fJ!.px : undefined);
      }
      total += pnl;
      worst = Math.min(worst, pnl);
    }
    return { total, prog, t3: t3sum, worst };
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

  // 4단: 창 없이 100% 가는 제3 트리거 (사용자 제안 — 전진폭 도달 or 10분 2차 진행성). 중간 70% 고정.
  console.log("\n[4단 — 30 → 70(진행성 5분) → 100(제3 트리거 or 창 동의)]");
  const base3 = run(0.7);
  console.log(`기준 3단(창 동의만 100): 합 ${base3.total >= 0 ? "+" : ""}${base3.total.toFixed(1)}%p · 최악일 ${base3.worst.toFixed(2)}%`);
  for (const x of [0.15, 0.2, 0.3, 0.4]) {
    const r = run(0.7, { type: "advance", x });
    console.log(`전진 ≥${x.toFixed(2)}×r10 → 100:  합 ${r.total >= 0 ? "+" : ""}${r.total.toFixed(1)}%p (3단 대비 ${(r.total - base3.total) >= 0 ? "+" : ""}${(r.total - base3.total).toFixed(1)}) · 최악일 ${r.worst.toFixed(2)}% · 트리거분: F만 ${r.t3["F만"] >= 0 ? "+" : ""}${r.t3["F만"].toFixed(1)} · 공통 ${r.t3["공통"] >= 0 ? "+" : ""}${r.t3["공통"].toFixed(1)} · 이견 ${r.t3["이견"] >= 0 ? "+" : ""}${r.t3["이견"].toFixed(1)}%p`);
  }
  for (const y of [0.15, 0.2, 0.3]) {
    const r = run(0.7, { type: "prog10", y });
    console.log(`10분 전진 ≥${y.toFixed(2)}×r10 → 100: 합 ${r.total >= 0 ? "+" : ""}${r.total.toFixed(1)}%p (3단 대비 ${(r.total - base3.total) >= 0 ? "+" : ""}${(r.total - base3.total).toFixed(1)}) · 최악일 ${r.worst.toFixed(2)}% · 트리거분: F만 ${r.t3["F만"] >= 0 ? "+" : ""}${r.t3["F만"].toFixed(1)} · 공통 ${r.t3["공통"] >= 0 ? "+" : ""}${r.t3["공통"].toFixed(1)} · 이견 ${r.t3["이견"] >= 0 ? "+" : ""}${r.t3["이견"].toFixed(1)}%p`);
  }

  // 통합 최종안: 4단 + 창 선행일 F 반대 청산 (순서 행렬의 마지막 칸)
  console.log("\n[통합 최종 — 4단 + 창선행 후 F반대 청산]");
  for (const x of [0.15, 0.3]) {
    const r = run(0.7, { type: "advance", x }, true);
    console.log(`X=${x.toFixed(2)}: 합 ${r.total >= 0 ? "+" : ""}${r.total.toFixed(1)}%p · 최악일 ${r.worst.toFixed(2)}%`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
