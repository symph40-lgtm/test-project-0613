// 삼전 계층 케이스 분해 — 피셔F(라이브 미러) × 4봉 누적 순전진(문턱 1.0/1.2) (사용자 지시 2026-08-02):
//   npx tsx scripts/ss-cw4-hier-cases.ts
// 하닉 신모델과 같은 틀: 공통/이견/F만/창만/무 케이스별 일수·선후·성과 + 2단 사다리 프로토타입
//   (F 30% → 창 동의 100% / 창 선행 즉시 100% / 이견 = 전량 청산 + 창 방향 100% / 스탑 -1.5%·종가청산).
// F = 라이브 runFisher 그대로 (0.05·4봉·강돌파 0.075(삼전)·C3·완충 ×3~10:30·확인 09:00부터, 08 연속창).
// 채점: 첫판정 진입·스탑 본주 -1.5%·종가보유 (케이스별 단독 성적), 사다리는 트랜치별 스탑.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { unitArr } from "../lib/predict/candleWindow";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Tr = { i: number; to: "up" | "down"; px: number };
const STOP = 1.5;

function streamCum(bars: MinuteBar[], unit: number[], tanA: number): Tr[] {
  const out: Tr[] = [];
  let st: "none" | "up" | "down" = "none";
  for (let t = 3; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - 3])) * dir >= tanA * unit[t - 3] * 3) { judged = dir === 1 ? "up" : "down"; break; }
    }
    if (!judged) continue;
    if (st === "none" || judged !== st) { st = judged; out.push({ i: t, to: st, px: bars[t].close }); }
  }
  return out;
}

type DayD = { date: string; bars: MinuteBar[]; r10: number; close: number; hist: PredictDailyBar[] };

// 트랜치 손익 (candleWindow.simLadder tr()와 동일 산식 — 스탑 앵커 = 자기 진입가)
function tranche(bars: MinuteBar[], close: number, i0: number, dir: 1 | -1, px: number, size: number, forceI?: number, forcePx?: number): { pnl: number; cut: boolean } {
  if (size <= 0) return { pnl: 0, cut: false };
  const s = STOP / 100;
  const lim = forceI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return { pnl: -STOP * size, cut: true };
  }
  const px2 = forceI !== undefined ? (forcePx ?? close) : close;
  return { pnl: ((px2 - px) / px) * 100 * dir * size, cut: false };
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("005930", 500)).filter((b) => b.date < today);
  const days: DayD[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`005930-${daily[i].date}.json`);
    const pre = rc(`005930NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    days.push({ date: daily[i].date, bars: [...(pre ?? []), ...reg], r10, close: daily[i].close, hist });
  }
  const C = PREDICT_CONFIG;

  for (const tanA of [1.0, 1.2]) {
    type Case = { n: number; fPnl: number; fCut: number; cwPnl: number; cwCut: number; leads: number[]; fFirstN: number; lad: number; ladWorst: number; ladCut: number };
    const mk = (): Case => ({ n: 0, fPnl: 0, fCut: 0, cwPnl: 0, cwCut: 0, leads: [], fFirstN: 0, lad: 0, ladWorst: 0, ladCut: 0 });
    const cases: Record<string, Case> = { 공통: mk(), 이견: mk(), F만: mk(), 창만: mk(), 무: mk() };
    let ladTotal = 0, ladWorstAll = 0, ladCutDays = 0;
    let lad2Total = 0, lad2Worst = 0, lad2CutDays = 0;

    for (const d of days) {
      const unit = unitArr(d.bars, d.r10);
      const trs = streamCum(d.bars, unit, tanA);
      const cw = trs.length ? { i: trs[0].i, t: tMin(d.bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
      const fOut = runFisher(
        { date: d.date, dailyHistory: d.hist, openPx: d.bars[0].open, morning: d.bars, prevDayMinutes: null },
        { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr },
      );
      const fTrs = fOut.transitions ?? [];
      const idx = new Map<string, number>();
      d.bars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });
      const fJ = fTrs.length && idx.has(fTrs[0].time)
        ? { i: idx.get(fTrs[0].time)!, t: tMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px }
        : null;

      const cat = fJ && cw ? (fJ.dir === cw.dir ? "공통" : "이견") : fJ ? "F만" : cw ? "창만" : "무";
      const cs = cases[cat];
      cs.n++;

      if (fJ) {
        const r = tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 1);
        cs.fPnl += r.pnl;
        if (r.cut) cs.fCut++;
      }
      if (cw) {
        const r = tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1);
        cs.cwPnl += r.pnl;
        if (r.cut) cs.cwCut++;
      }
      if (fJ && cw) {
        cs.leads.push(cw.t - fJ.t);
        if (fJ.t < cw.t) cs.fFirstN++;
      }

      // 2단 사다리 프로토타입: F 30% → 창 동의 100% / 창 선행 즉시 100% / 이견 청산+창 방향 100%
      let pnl = 0, anyCut = false;
      const add = (r: { pnl: number; cut: boolean }) => { pnl += r.pnl; anyCut = anyCut || r.cut; };
      const fFirst = fJ && (!cw || fJ.t < cw.t);
      if (fFirst && fJ) {
        const opp = cw && cw.dir !== fJ.dir;
        add(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw!.i : undefined, opp ? cw!.px : undefined));
        if (cw && cw.dir === fJ.dir) add(tranche(d.bars, d.close, cw.i, fJ.dir, cw.px, 0.7));
        if (opp && cw) add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0));
      } else if (cw) {
        add(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0));
      }
      ladTotal += pnl;
      ladWorstAll = Math.min(ladWorstAll, pnl);
      if (anyCut) ladCutDays++;
      cs.lad += pnl;

      // v2 (삼전형 — 케이스 분해가 시사하는 규칙): 창 선행 100% 진입 → F가 반대 확인하면
      // 잔여 청산 + F 방향 100% 역진입 ("나중 신호가 레그를 끊는다" — 하닉 원칙의 삼전판.
      // 삼전은 창이 정찰(45~76분 선행)·F가 확인 역할로 하닉과 반대). F 동의면 그대로 보유.
      {
        let p2 = 0, c2 = false;
        const add2 = (r: { pnl: number; cut: boolean }) => { p2 += r.pnl; c2 = c2 || r.cut; };
        if (fFirst && fJ) {
          const opp = cw && cw.dir !== fJ.dir;
          add2(tranche(d.bars, d.close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw!.i : undefined, opp ? cw!.px : undefined));
          if (cw && cw.dir === fJ.dir) add2(tranche(d.bars, d.close, cw.i, fJ.dir, cw.px, 0.7));
          if (opp && cw) add2(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0));
        } else if (cw) {
          const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
          add2(tranche(d.bars, d.close, cw.i, cw.dir, cw.px, 1.0, fOpp?.i, fOpp?.px));
          if (fOpp) add2(tranche(d.bars, d.close, fOpp.i, fOpp.dir, fOpp.px, 1.0));
        }
        lad2Total += p2;
        lad2Worst = Math.min(lad2Worst, p2);
        if (c2) lad2CutDays++;
      }
    }

    console.log(`\n════ 삼전 케이스 분해 — F(라이브) × 4봉 누적 순전진 ${tanA.toFixed(1)} · ${days.length}일 ════`);
    for (const [name, cs] of Object.entries(cases)) {
      if (name === "무") { console.log(`무판정: ${cs.n}일`); continue; }
      const lead = cs.leads.length ? `창-F 시차 중앙 ${med(cs.leads) >= 0 ? "+" : ""}${med(cs.leads)}분·F선행 ${Math.round((100 * cs.fFirstN) / cs.leads.length)}%` : "";
      console.log(`${name}: ${cs.n}일 · F단독 ${s1(cs.fPnl)}%p(컷 ${cs.fCut}) · 창단독 ${s1(cs.cwPnl)}%p(컷 ${cs.cwCut})${lead ? ` · ${lead}` : ""} · 사다리 기여 ${s1(cs.lad)}%p`);
    }
    console.log(`사다리 프로토타입 합(하닉 규칙 그대로): ${s1(ladTotal)}%p · 최악일 ${ladWorstAll.toFixed(2)}% · 컷일 ${ladCutDays}`);
    console.log(`v2(창선행 100% → F반대 확인 시 청산+F방향 100% 역진입): ${s1(lad2Total)}%p · 최악일 ${lad2Worst.toFixed(2)}% · 컷일 ${lad2CutDays}`);
  }
  console.log(`\n참고: 삼전 현행 실운용(계층 20/30/50+10시 지연) +82.1%p · 창 1.0 단독 +82.0 · 1.2 단독 +98.5(전체 232일 기준).`);
  console.log(`사다리 규칙은 하닉 확정판의 축소(진행성·전진폭 단계 없음) — 개념 검증용 프로토타입.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
