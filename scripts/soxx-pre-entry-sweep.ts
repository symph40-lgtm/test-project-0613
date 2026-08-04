// SOXX 프리장 확인 즉시 진입 vs 개장가 대기 (사용자 지시 2026-08-05 "프리장에서 직접 매수하도록 해줘"):
//   npx tsx scripts/soxx-pre-entry-sweep.ts
// 현행 사양: F 프리장 확인일은 09:30 개장가 진입 (백테스트 전 계열 동일). 변경안: 확인가(프리장) 즉시 진입 +
// 스탑 -2%를 프리장 봉부터 감시. 나머지(창1 반대 전환·비이견 1박·인버 보호 09:30~10:30)는 동일.
// 기준선 = rebox + 인버 보호 주기준 (+130.9/246일). 보호 트리거는 정규장 봉만(검증 셀 유지).

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { judgeSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar, type SoxxJ } from "../lib/signal/us/soxxV2";
import { PREDICT_CONFIG } from "../lib/predict/config";
import type { PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE = resolve(process.cwd(), ".predict-cache");
const STOP = 2.0;
const PR = PREDICT_CONFIG.newModel.soxxV2.protect;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

type Day = { date: string; raw: SoxxBar[]; reg: SoxxBar[]; close: number; nextOpen: number | null; c1: SoxxJ | null; fJ: SoxxJ | null };

function simDay(d: Day, preEntry: boolean, preStop = true): { p: number; cut: boolean; preN: boolean } {
  const { raw } = d;
  const fFirst = d.fJ && (!d.c1 || d.fJ.t < d.c1.t);
  const first = fFirst ? d.fJ : d.c1;
  if (!first) return { p: 0, cut: false, preN: false };
  let cutAny = false;
  let usedPre = false;
  const runLeg = (j: SoxxJ, allowOvn: boolean, forceI?: number, forcePx?: number): number => {
    let i0 = j.i, px = j.px;
    const isPre = raw[j.i].etMin < SOXX_ET_OPEN;
    if (isPre && !preEntry) { i0 = raw.findIndex((b) => b.etMin >= SOXX_ET_OPEN); px = d.reg[0].open; }
    if (isPre && preEntry) usedPre = true;
    if (i0 < 0 || (forceI !== undefined && forceI <= i0)) return 0;
    const s = STOP / 100;
    const lim = forceI ?? raw.length;
    let ext = px;
    for (let k = i0 + 1; k < lim; k++) {
      const b = raw[k];
      if (b.etMin < SOXX_ET_OPEN && !(isPre && preEntry && preStop)) continue; // 프리장 스탑 감시는 preStop 변형만
      if (j.dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) { cutAny = true; return -STOP; }
      if (j.dir === -1 && b.etMin >= SOXX_ET_OPEN) {
        ext = Math.min(ext, b.low);
        const armGain = ((px - ext) / px) * 100;
        if (b.etMin <= PR.untilEt && armGain >= PR.arm) {
          const retr = ((b.close - ext) / px) * 100;
          if (retr >= PR.trail) return ((px - b.close) / px) * 100;
        }
      }
    }
    if (forceI !== undefined) return (((forcePx ?? d.close) - px) / px) * 100 * j.dir;
    return (((allowOvn && d.nextOpen !== null ? d.nextOpen : d.close) - px) / px) * 100 * j.dir;
  };
  let p = 0;
  if (fFirst && d.fJ) {
    const oppC = d.c1 && d.c1.dir !== d.fJ.dir ? d.c1 : null;
    p += runLeg(d.fJ, !oppC, oppC?.i, oppC?.px);
    if (oppC) p += runLeg(oppC, false);
  } else if (d.c1) {
    const fOpp = d.fJ && d.fJ.dir !== d.c1.dir ? d.fJ : null;
    p += runLeg(d.c1, !fOpp);
  }
  return { p, cut: cutAny, preN: usedPre };
}

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const days: Day[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 });
    const next = dIdx.find((x) => x > date);
    days.push({ date, raw, reg, close: reg[reg.length - 1].close, nextOpen: next ? dBy.get(next)!.open : null, c1, fJ });
  }
  const variants: [string, boolean, boolean][] = [
    ["현행 (개장가 대기)              ", false, true],
    ["프리장 진입 + 프리장 스탑       ", true, true],
    ["프리장 진입 + 스탑 정규장부터   ", true, false],
  ];
  for (const [label, preEntry, preStop] of variants) {
    let tot = 0, cutN = 0, worst = 0, preN = 0;
    for (const d of days) {
      const r = simDay(d, preEntry, preStop);
      tot += r.p; if (r.cut) cutN++; worst = Math.min(worst, r.p); if (r.preN) preN++;
    }
    console.log(`${label}: ${s1(tot)}%p · 최악 ${worst.toFixed(2)} · 컷 ${cutN}일 · 프리장 진입 ${preN}일 / ${days.length}일`);
  }
  // 프리장 확인일 한정 — 확인가→개장가 드리프트 분포
  let drift = 0, dn = 0, worstD = 0, bestD = 0;
  for (const d of days) {
    const fFirst = d.fJ && (!d.c1 || d.fJ.t < d.c1.t);
    if (!fFirst || !d.fJ || d.raw[d.fJ.i].etMin >= SOXX_ET_OPEN) continue;
    const dd = ((d.reg[0].open - d.fJ.px) / d.fJ.px) * 100 * d.fJ.dir;
    drift += dd; dn++; worstD = Math.min(worstD, dd); bestD = Math.max(bestD, dd);
  }
  console.log(`\nF 프리장 확인일 ${dn}일: 확인→개장 드리프트 합 ${s1(drift)}%p (평균 ${s2(drift / Math.max(1, dn))}%·최악 ${s2(worstD)}·최선 ${s2(bestD)}) — 개장가 대기가 놓치는 몫`);
}
main().catch((e) => { console.error(e); process.exit(1); });
