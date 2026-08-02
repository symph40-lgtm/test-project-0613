// 삼전 신모델(v2)의 SOXX 이식 검증 + 지난주 수~금 일별 비교 (사용자 지시 2026-08-03):
//   npx tsx scripts/us-ssv2-port-sweep.ts
// 데이터: 야후 SOXX 5분봉 includePrePost (~59캘린더일 ≈ 38거래일 — 소표본 명시). 관찰창 07:00~16:00 ET.
// 비교 대상:
//   A) 현행 미장 피셔F (라이브: OR 3봉·0.05·확인 1봉·강돌파 0.1·전환 1봉) — 레그 회계
//   B) 삼전식 v2: 창(누적 순전진 tan1.0·win 4/6) 첫판정 100% → F 반대 첫확인 시 전량 역진입
//   C) 하닉식: F 첫판정 100% → 창 반대 첫판정 시 전량 창 방향 100% (역할 반전 대비)
// 공통: 스탑 SOXX -2.0%(라이브 usPredict.stopPct)·16:00 종가 청산·프리장 판정 진입은 정규장 시가로 보정.
// + 선후 관계·케이스 분해(win6) + 7/29~31(ET) 일별 상세 (한국시간 병기·SOXL 3x 환산).

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar } from "../lib/predict/types";
import { fetchJudge5m, fetchJudgeDaily } from "../lib/signal/us/predictStream";
import type { UsBar } from "../lib/signal/us/models";

const STOP = 2.0; // SOXX 기준 (라이브 usPredict.stopPct)
const ET_OPEN = 9 * 60 + 30, ET_CLOSE = 16 * 60, ET_PRE = 7 * 60;
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const kstOf = (etMin: number) => {
  const k = (etMin + 13 * 60) % 1440;
  const nextDay = etMin + 13 * 60 >= 1440;
  return `${String(Math.floor(k / 60)).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}${nextDay ? "(+1일 KST)" : "(KST)"}`;
};
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);

type Dir = 1 | -1;
type Tr = { i: number; t: number; dir: Dir; px: number };

// 눈금·누적 순전진 (lib/predict 산식 그대로 — 5분봉에 적용)
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
function unitArrL(bars: MinuteBar[], r10: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : r10 / 100;
    return Math.max(u * 0.5, 1e-9);
  });
}
function cumStreamL(bars: MinuteBar[], unit: number[], tanA: number, win: number): Tr[] {
  const out: Tr[] = [];
  const w = win - 1;
  let st: "none" | "up" | "down" = "none";
  for (let t = w; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - w])) * dir >= tanA * unit[t - w] * w) { judged = dir === 1 ? "up" : "down"; break; }
    }
    if (!judged) continue;
    if (st === "none" || judged !== st) { st = judged; out.push({ i: t, t: 0, dir: judged === "up" ? 1 : -1, px: bars[t].close }); }
  }
  return out;
}

function toMinute(b: UsBar): MinuteBar {
  return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
}

async function main() {
  const byDay = await fetchJudge5m(59);
  const daily = await fetchJudgeDaily(150);
  const dates = [...byDay.keys()].sort();
  type DayD = { date: string; bars: MinuteBar[]; etMins: number[]; regOpenI: number; close: number; rOC: number; r10: number; fTrs: Tr[]; cw6: Tr | null; cw4: Tr | null };
  const days: DayD[] = [];
  for (const date of dates) {
    const raw = (byDay.get(date) ?? []).filter((b) => b.etMin >= ET_PRE && b.etMin < ET_CLOSE);
    const reg = raw.filter((b) => b.etMin >= ET_OPEN);
    if (reg.length < 60) continue;
    const hist = daily.filter((d) => d.date < date).slice(-60);
    const r10 = avgRange(hist, 10);
    if (r10 === null || hist.length < 11) continue;
    const bars = raw.map(toMinute);
    const etMins = raw.map((b) => b.etMin);
    const regOpenI = raw.findIndex((b) => b.etMin >= ET_OPEN);
    // 현행 미장 F (라이브 상수) — 전이 전체
    const fOut = runFisher(
      { date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null },
      { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 },
    );
    const idx = new Map<string, number>();
    bars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });
    const fTrs: Tr[] = (fOut.transitions ?? []).flatMap((t) => {
      const i = idx.get(t.time);
      return i === undefined ? [] : [{ i, t: etMins[i], dir: (t.to === "up" ? 1 : -1) as Dir, px: t.px }];
    });
    const unit = unitArrL(bars, r10);
    const c6 = cumStreamL(bars, unit, 1.0, 6).map((t) => ({ ...t, t: etMins[t.i] }));
    const c4 = cumStreamL(bars, unit, 1.0, 4).map((t) => ({ ...t, t: etMins[t.i] }));
    days.push({
      date, bars, etMins, regOpenI: Math.max(0, regOpenI), close: reg[reg.length - 1].close,
      rOC: ((reg[reg.length - 1].close - reg[0].open) / reg[0].open) * 100, r10,
      fTrs, cw6: c6.length ? c6[0] : null, cw4: c4.length ? c4[0] : null,
    });
  }

  // 트랜치: 프리장 진입 보정 (판정이 09:30 전이면 정규장 첫 봉 시가로 진입)
  const tranche = (d: DayD, j: Tr, size: number, forceI?: number, forcePx?: number): { pnl: number; cut: boolean } => {
    let i0 = j.i, px = j.px;
    if (d.etMins[j.i] < ET_OPEN) { i0 = d.regOpenI; px = d.bars[d.regOpenI].open; }
    if (size <= 0 || forceI !== undefined && forceI <= i0) return { pnl: 0, cut: false };
    const s = STOP / 100;
    const lim = forceI ?? d.bars.length;
    for (let k = i0 + 1; k < lim; k++) {
      const b = d.bars[k];
      if (d.etMins[k] < ET_OPEN) continue; // 프리장 스탑 미적용 (얇은 체결)
      if (j.dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return { pnl: -STOP * size, cut: true };
    }
    const px2 = forceI !== undefined ? (forcePx ?? d.close) : d.close;
    return { pnl: ((px2 - px) / px) * 100 * j.dir * size, cut: false };
  };

  // A) 현행 F 레그 회계
  let aPnl = 0, aCuts = 0, aLegs = 0;
  // B) 삼전식 v2 (win 6 / win 4)
  const b6 = { pnl: 0, cut: 0, worst: 0 }, b4 = { pnl: 0, cut: 0, worst: 0 };
  // C) 하닉식 (F 진입 → 창6 반대 시 창 방향 100%)
  const cRes = { pnl: 0, cut: 0, worst: 0 };
  // 선후·케이스 (win6)
  let n = 0, fFirstN = 0, common = 0, opp = 0, fOnly = 0, cwOnly = 0;
  const leads: number[] = [];

  const dayPnl = new Map<string, { a: number; b6: number; c: number }>();
  for (const d of days) {
    n++;
    // A
    let a = 0;
    for (let k = 0; k < d.fTrs.length; k++) {
      const t = d.fTrs[k];
      const nx = k + 1 < d.fTrs.length ? d.fTrs[k + 1] : null;
      const r = tranche(d, t, 1, nx?.i, nx?.px);
      a += r.pnl; aLegs++;
      if (r.cut) aCuts++;
    }
    aPnl += a;
    // 선후·케이스
    const fJ = d.fTrs.length ? d.fTrs[0] : null;
    const cw = d.cw6;
    if (fJ && cw) {
      leads.push(cw.t - fJ.t);
      if (fJ.t < cw.t) fFirstN++;
      if (fJ.dir === cw.dir) common++; else opp++;
    } else if (fJ) fOnly++;
    else if (cw) cwOnly++;
    // B (win 6·4)
    const runB = (cwJ: Tr | null): number => {
      if (!cwJ || (fJ && fJ.t < cwJ.t)) return 0; // F 선행 관망 (삼전 규칙)
      const fOppJ = fJ && fJ.dir !== cwJ.dir ? fJ : null;
      let p = tranche(d, cwJ, 1, fOppJ?.i, fOppJ?.px).pnl;
      if (fOppJ) p += tranche(d, fOppJ, 1).pnl;
      return p;
    };
    const pb6 = runB(d.cw6), pb4 = runB(d.cw4);
    b6.pnl += pb6; b6.worst = Math.min(b6.worst, pb6);
    b4.pnl += pb4; b4.worst = Math.min(b4.worst, pb4);
    // C (하닉식)
    let pc = 0;
    if (fJ) {
      const cwOpp = cw && cw.dir !== fJ.dir && cw.t > fJ.t ? cw : null;
      pc += tranche(d, fJ, 1, cwOpp?.i, cwOpp?.px).pnl;
      if (cwOpp) pc += tranche(d, cwOpp, 1).pnl;
    } else if (cw) pc += tranche(d, cw, 1).pnl;
    cRes.pnl += pc; cRes.worst = Math.min(cRes.worst, pc);
    dayPnl.set(d.date, { a, b6: pb6, c: pc });
  }

  console.log(`════ SOXX 이식 검증 — ${n}거래일 (야후 5분봉 소표본·스탑 -${STOP}%·프리장 판정은 정규장 시가 진입) ════`);
  console.log(`A 현행 미장 F(레그 회계):        ${s1(aPnl)}%p · 레그 ${aLegs}·컷 ${aCuts}`);
  console.log(`B 삼전식 v2·창6봉(30분) + F심판: ${s1(b6.pnl)}%p · 최악일 ${b6.worst.toFixed(2)}%`);
  console.log(`B' 삼전식 v2·창4봉(20분):        ${s1(b4.pnl)}%p · 최악일 ${b4.worst.toFixed(2)}%`);
  console.log(`C 하닉식(F 진입→창6 반대 전환):  ${s1(cRes.pnl)}%p · 최악일 ${cRes.worst.toFixed(2)}%`);
  console.log(`\n[선후·케이스 — 창6 vs F] 동시판정 ${leads.length}일: F 선행 ${fFirstN}일(${leads.length ? Math.round((100 * fFirstN) / leads.length) : 0}%)·창-F 시차 중앙 ${Number.isNaN(med(leads)) ? "—" : `${med(leads) >= 0 ? "+" : ""}${med(leads)}분`} · 공통 ${common}·이견 ${opp}·F만 ${fOnly}·창만 ${cwOnly}`);

  console.log(`\n[지난주 수~금 상세 — ET 날짜 (정규장 = 한국시간 22:30~05:00)]`);
  for (const date of ["2026-07-29", "2026-07-30", "2026-07-31"]) {
    const d = days.find((x) => x.date === date);
    if (!d) { console.log(`${date}: 데이터 없음`); continue; }
    const p = dayPnl.get(date)!;
    const fJ = d.fTrs.length ? d.fTrs[0] : null;
    const cw = d.cw6;
    console.log(`\n■ ${date}(ET) — SOXX 시가→종가 ${s2(d.rOC)}% (SOXL 3x ≈ ${s2(d.rOC * 3)}%)`);
    console.log(`  현행 F: ${fJ ? `${fmtT(fJ.t)} ET·${kstOf(fJ.t)} ${fJ.dir === 1 ? "상승" : "하락"} 첫확인 $${fJ.px.toFixed(2)} — 전이 ${d.fTrs.length}회` : "판정 없음"} → 그날 손익 ${s2(p.a)}% (SOXL ≈ ${s2(p.a * 3)}%)`);
    console.log(`  신모델 창6: ${cw ? `${fmtT(cw.t)} ET·${kstOf(cw.t)} ${cw.dir === 1 ? "상승" : "하락"} 판정 $${cw.px.toFixed(2)}` : "판정 없음"} → v2 손익 ${s2(p.b6)}% (SOXL ≈ ${s2(p.b6 * 3)}%)`);
    console.log(`  하닉식: ${s2(p.c)}% (SOXL ≈ ${s2(p.c * 3)}%)`);
  }
  console.log(`\n주: SOXL 환산은 일중 3배 근사(복리·비용 미반영). 프리장(07:00~09:30 ET) 판정은 정규장 시가 진입·프리장 스탑 미적용.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
