// 0930 OR 라이브 계층 완전 재현 스윕 (8/6 결정 대기 항목의 남은 검증 ① — 가이드 §8):
//   npx tsx scripts/or0930-live-sweep.ts
// 8/1 밤 연구 실측(간이 미러, 임시 스크립트 — 저장소 미보존)은 F +78.5→+115.6 · M +93.3→+114.3 ·
// 본 +50.9→+69.4 · 사다리 +120.7→+123.5%p. 여기서는 라이브 엔진(runFisher — 완충·강돌파·C3·
// 프리장 게이트·트레일 전부 포함)에 신설 rebox 옵션을 걸어 같은 227일 캐시로 재현한다.
//   현행: F·M = 08 연속창(pre+reg) 시초 15봉 OR · 본 = 09창(reg) — 라이브 service.ts 호출과 동일 cfg
//   0930: F·M = 09:45부터 09:30~45 박스로 앵커 전환(상태 승계·카운터 리셋, reboxHHMM) · 본 = 박스 이동(reg 09:30~)
// 레그 회계는 stop-width-sweep 관례: 전이마다 재진입·컷(-2.5% 본주) 후 다음 전이까지 관망·종가 청산.
// 사다리는 라이브 simLadder(defense=false·레짐 분기) — 0930은 F 첫판정만 주입(fJOverride).
// + 09창 반전경보(rev9, service.ts 2.12) 역할 중복 정량화 (남은 검증 ②).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { runFisher, type FisherCfg } from "../lib/predict/models/fisher";
import { candleJudgeStream, unitArr, simLadder, fisherFirstKr } from "../lib/predict/candleWindow";
import { PREDICT_CONFIG } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

type Trans = { time: string; to: "up" | "down"; px: number };
const C = PREDICT_CONFIG;
// 라이브 service.ts 호출과 동일한 cfg (하닉) — rebox만 변형에서 추가
const F_CFG: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
const M_CFG: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
const B_CFG: FisherCfg = { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes };
const REBOX: FisherCfg = { reboxHHMM: "09:30", reboxMinutes: 15 };

function runStream(bars: MinuteBar[], hist: PredictDailyBar[], date: string, cfg: FisherCfg): Trans[] {
  if (bars.length < 20) return [];
  const out = runFisher({ date, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, cfg);
  return out.transitions ?? [];
}

// 레그 회계 (stop-width-sweep 관례): 전이 = 진입/전환 청산, 컷 -2.5% 본주(앵커=확인가), 잔여 종가
function legPnl(bars: MinuteBar[], trs: Trans[], close: number): { pnl: number; cuts: number; legs: number } {
  const idx = new Map<string, number>();
  bars.forEach((b, i) => { if (!idx.has(b.time)) idx.set(b.time, i); });
  const s = 2.5 / 100;
  let pnl = 0, cuts = 0;
  for (let k = 0; k < trs.length; k++) {
    const t = trs[k];
    const i0 = idx.get(t.time);
    if (i0 === undefined) continue;
    const endI = k + 1 < trs.length ? idx.get(trs[k + 1].time) ?? bars.length : bars.length;
    const dir = t.to === "up" ? 1 : -1;
    let cut = false;
    for (let i = i0 + 1; i < endI; i++) {
      const b = bars[i];
      if (dir === 1 ? b.low <= t.px * (1 - s) : b.high >= t.px * (1 + s)) { cut = true; break; }
    }
    if (cut) { pnl += -2.5; cuts++; continue; }
    const exitPx = k + 1 < trs.length ? trs[k + 1].px : close;
    pnl += ((exitPx - t.px) / t.px) * 100 * dir;
  }
  return { pnl, cuts, legs: trs.length };
}

type LayerAgg = { pnl: number; cuts: number; legs: number; days: number; firsts: number[]; byMon: Map<string, number> };
const newAgg = (): LayerAgg => ({ pnl: 0, cuts: 0, legs: 0, days: 0, firsts: [], byMon: new Map() });
function addDay(a: LayerAgg, date: string, r: { pnl: number; cuts: number; legs: number }, firstT: number | null) {
  a.pnl += r.pnl; a.cuts += r.cuts; a.legs += r.legs;
  if (r.legs > 0) a.days++;
  if (firstT !== null) a.firsts.push(firstT);
  const mon = date.slice(0, 7);
  a.byMon.set(mon, (a.byMon.get(mon) ?? 0) + r.pnl);
}
function layerLine(name: string, base: LayerAgg, v: LayerAgg) {
  const jul = (a: LayerAgg) => a.byMon.get("2026-07") ?? 0;
  console.log(`${name}: 현행 ${s1(base.pnl)}%p (레그 ${base.legs}·컷 ${base.cuts}·판정 ${base.days}일·첫확인중앙 ${fmtT(med(base.firsts))}·7월 ${s1(jul(base))})`);
  console.log(`${" ".repeat(name.length)}  0930 ${s1(v.pnl)}%p (레그 ${v.legs}·컷 ${v.cuts}·판정 ${v.days}일·첫확인중앙 ${fmtT(med(v.firsts))}·7월 ${s1(jul(v))}) → Δ ${s1(v.pnl - base.pnl)}`);
}

// 전이 목록 → 시각별 상태 조회 (rev9 발화 시뮬레이션용)
function stateAt(trs: Trans[], tmin: number): "none" | "up" | "down" {
  let st: "none" | "up" | "down" = "none";
  for (const t of trs) { if (tMin(t.time) <= tmin) st = t.to; else break; }
  return st;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  const agg = { F: [newAgg(), newAgg()], M: [newAgg(), newAgg()], B: [newAgg(), newAgg()] } as const;
  const aggBnt = [newAgg(), newAgg()];
  // 장초반 완충 종료 스윕 (사용자 지시 2026-08-01 밤 "~10:30 → 10:00까지로 변경해봐"):
  // F ×3·M ×1.25의 종료를 10:00으로 당겼을 때 — OR 현행/0930 각각. 사다리는 해당 F 첫판정 주입.
  const evAgg = new Map<string, { pnl: number; cuts: number }>();
  const evAdd = (k: string, pnl: number, cuts: number) => { const a = evAgg.get(k) ?? { pnl: 0, cuts: 0 }; a.pnl += pnl; a.cuts += cuts; evAgg.set(k, a); };
  // 박스 시작 시각 이웃 격자 (연구 '평원 09:35~55 전부 +112~121' 라이브 재현 — 첨점 여부 확인)
  const BOX_STARTS = ["09:20", "09:25", "09:30", "09:35", "09:40", "09:45"] as const;
  const boxAgg = new Map<string, { pnl: number; cuts: number }>(BOX_STARTS.map((s) => [s, { pnl: 0, cuts: 0 }]));
  let ladBase = 0, ladV = 0, ladBaseWorst = 0, ladVWorst = 0, ladBaseCut = 0, ladVCut = 0;
  const ladMonB = new Map<string, number>(), ladMonV = new Map<string, number>();
  let daysN = 0, parityMismatch = 0;
  const parityDates: string[] = [];
  // rev9 중복 정량화: 본(현행) 유지 중 09창 F 반대 확인 발화일 — 0930 F·본의 같은 방향 전이와 시차
  let revFires = 0, revF0930Same = 0, revB0930Same = 0, revFAlready = 0, revBCurSame = 0;
  const revLeadF: number[] = [], revLeadB: number[] = [], revLeadBCur: number[] = [];

  for (let i = 130; i < daily.length; i++) {
    const date = daily[i].date;
    const reg = rc(`000660-${date}.json`);
    const pre = rc(`000660NX-${date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    daysN++;
    const bars = [...(pre ?? []), ...reg];
    const close = daily[i].close;
    const hv = isHighVolDay(hist);
    const reg0930 = reg.filter((b) => b.time >= "09:30");

    // F·M: 08 연속창 → 0930은 rebox / 본: 09창 → 0930은 박스 이동
    const fB = runStream(bars, hist, date, F_CFG);
    const fV = runStream(bars, hist, date, { ...F_CFG, ...REBOX });
    const mB = runStream(bars, hist, date, M_CFG);
    const mV = runStream(bars, hist, date, { ...M_CFG, ...REBOX });
    const bB = runStream(reg, hist, date, B_CFG);
    const bV = runStream(reg0930, hist, date, B_CFG);
    // 교차검증: 연구 간이 미러(트레일 미포함 추정)의 본 — 라이브와의 격차 원인 규명용
    const BNT: FisherCfg = { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes };
    const bBnt = runStream(reg, hist, date, BNT);
    const bVnt = runStream(reg0930, hist, date, BNT);
    addDay(aggBnt[0], date, legPnl(reg, bBnt, close), null);
    addDay(aggBnt[1], date, legPnl(reg0930, bVnt, close), null);

    // 완충 종료 10:00 변형 — F·M × OR 현행/0930 + 사다리(F 첫판정 주입)
    {
      const combos: [string, Trans[], MinuteBar[]][] = [
        ["F|10:00|현행", runStream(bars, hist, date, { ...F_CFG, earlyVolUntil: "10:00" }), bars],
        ["F|10:00|0930", runStream(bars, hist, date, { ...F_CFG, earlyVolUntil: "10:00", ...REBOX }), bars],
        ["M|10:00|현행", runStream(bars, hist, date, { ...M_CFG, earlyVolUntil: "10:00" }), bars],
        ["M|10:00|0930", runStream(bars, hist, date, { ...M_CFG, earlyVolUntil: "10:00", ...REBOX }), bars],
      ];
      for (const [k, t, bb] of combos) {
        const r = legPnl(bb, t, close);
        evAdd(k, r.pnl, r.cuts);
      }
      const idx2 = new Map<string, number>();
      bars.forEach((b, k) => { if (!idx2.has(b.time)) idx2.set(b.time, k); });
      const trsCw = candleJudgeStream(bars, unitArr(bars, r10));
      for (const [k, t] of [["lad|10:00|현행", combos[0][1]], ["lad|10:00|0930", combos[1][1]]] as const) {
        const fj = t.length ? { t: tMin(t[0].time), i: idx2.get(t[0].time) ?? -1, dir: (t[0].to === "up" ? 1 : -1) as 1 | -1, px: t[0].px } : null;
        const l = simLadder(bars, r10, close, trsCw, false, hv, fj && fj.i >= 0 ? fj : null);
        evAdd(k, l.pnl, l.cut ? 1 : 0);
      }
    }
    for (const bs of BOX_STARTS) {
      const trsF = bs === "09:30" ? fV : runStream(bars, hist, date, { ...F_CFG, reboxHHMM: bs, reboxMinutes: 15 });
      const r = legPnl(bars, trsF, close);
      const a = boxAgg.get(bs)!;
      a.pnl += r.pnl; a.cuts += r.cuts;
    }

    const firstT = (t: Trans[]) => (t.length ? tMin(t[0].time) : null);
    addDay(agg.F[0], date, legPnl(bars, fB, close), firstT(fB));
    addDay(agg.F[1], date, legPnl(bars, fV, close), firstT(fV));
    addDay(agg.M[0], date, legPnl(bars, mB, close), firstT(mB));
    addDay(agg.M[1], date, legPnl(bars, mV, close), firstT(mV));
    addDay(agg.B[0], date, legPnl(reg, bB, close), firstT(bB));
    addDay(agg.B[1], date, legPnl(reg0930, bV, close), firstT(bV));

    // 미러 parity: candleWindow.fisherFirstKr(사다리 내부 F) vs 라이브 runFisher 첫 전이
    const fk = fisherFirstKr(bars, r10);
    const fkLive = fB.length ? { t: tMin(fB[0].time), dir: fB[0].to === "up" ? 1 : -1 } : null;
    const same = (fk === null && fkLive === null) || (fk !== null && fkLive !== null && fk.t === fkLive.t && fk.dir === fkLive.dir);
    if (!same) { parityMismatch++; if (parityDates.length < 10) parityDates.push(date); }

    // 사다리: 현행 = 라이브 simLadder 그대로 / 0930 = F 첫판정만 주입 (창판정·레짐 분기 동일)
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const lb = simLadder(bars, r10, close, trs, false, hv);
    const idx = new Map<string, number>();
    bars.forEach((b, k) => { if (!idx.has(b.time)) idx.set(b.time, k); });
    const fVJ = fV.length ? { t: tMin(fV[0].time), i: idx.get(fV[0].time) ?? -1, dir: (fV[0].to === "up" ? 1 : -1) as 1 | -1, px: fV[0].px } : null;
    const lv = simLadder(bars, r10, close, trs, false, hv, fVJ && fVJ.i >= 0 ? fVJ : null);
    ladBase += lb.pnl; ladV += lv.pnl;
    ladBaseWorst = Math.min(ladBaseWorst, lb.pnl); ladVWorst = Math.min(ladVWorst, lv.pnl);
    if (lb.cut) ladBaseCut++; if (lv.cut) ladVCut++;
    const mon = date.slice(0, 7);
    ladMonB.set(mon, (ladMonB.get(mon) ?? 0) + lb.pnl);
    ladMonV.set(mon, (ladMonV.get(mon) ?? 0) + lv.pnl);

    // rev9 발화 시뮬 (라이브 service.ts 2.12 미러): 매분 — 본(현행) 상태 유지 중 09창 F(완충 없음·
    // 게이트 없음, rev9 전용 cfg)가 반대 상태면 발화. 첫 발화 시각·그때의 본 상태 시작점(onset)을 기록.
    const f9 = runStream(reg, hist, date, { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes });
    let fire: { t: number; dir: "up" | "down"; onset: number } | null = null;
    for (const b of reg) {
      const tm = tMin(b.time);
      const bSt = stateAt(bB, tm);
      const fSt = stateAt(f9, tm);
      if (bSt !== "none" && fSt !== "none" && fSt !== bSt) {
        let onset = 0;
        for (const t of bB) { if (tMin(t.time) <= tm && t.to === bSt) onset = tMin(t.time); }
        fire = { t: tm, dir: fSt, onset };
        break;
      }
    }
    if (fire) {
      revFires++;
      // 발화 시점에 0930 F 상태가 이미 반전 방향 = F 계층 판정 문자가 이미 같은 말을 한 상태 (중복)
      if (stateAt(fV, fire.t) === fire.dir) revFAlready++;
      // '같은 반전'만 비교 — 본이 그 방향을 잡은(onset) 이후의 전이만 (아침 선행 전이 오염 방지)
      const fSame = fV.find((t) => t.to === fire!.dir && tMin(t.time) > fire!.onset);
      if (fSame) { revF0930Same++; revLeadF.push(tMin(fSame.time) - fire.t); }
      const bSame = bV.find((t) => t.to === fire!.dir && tMin(t.time) > fire!.onset);
      if (bSame) { revB0930Same++; revLeadB.push(tMin(bSame.time) - fire.t); }
      // 현행 본(박스 이동 없음) 자체 전환 대비 리드 — 본 현행 유지 시 rev9의 존치 가치
      const bCur = bB.find((t) => t.to === fire!.dir && tMin(t.time) > fire!.onset);
      if (bCur) { revBCurSame++; revLeadBCur.push(tMin(bCur.time) - fire.t); }
    }
  }

  console.log(`════ 0930 OR 라이브 재현 — 하닉 ${daysN}일 (연구값: F +78.5→+115.6 · M +93.3→+114.3 · 본 +50.9→+69.4 · 사다리 +120.7→+123.5) ════`);
  layerLine("피셔F", agg.F[0], agg.F[1]);
  layerLine("피셔M", agg.M[0], agg.M[1]);
  layerLine("본피셔", agg.B[0], agg.B[1]);
  console.log(`  └ 본 트레일 제외 대조(연구 미러 추정 재현): 현행 ${s1(aggBnt[0].pnl)}%p → 0930 ${s1(aggBnt[1].pnl)}%p (Δ ${s1(aggBnt[1].pnl - aggBnt[0].pnl)})`);
  console.log(`사다리: 현행 ${s1(ladBase)}%p (최악 ${ladBase >= 0 ? "" : ""}${ladBaseWorst.toFixed(2)}%·컷일 ${ladBaseCut}·7월 ${s1(ladMonB.get("2026-07") ?? 0)})`);
  console.log(`        0930 ${s1(ladV)}%p (최악 ${ladVWorst.toFixed(2)}%·컷일 ${ladVCut}·7월 ${s1(ladMonV.get("2026-07") ?? 0)}) → Δ ${s1(ladV - ladBase)}`);
  console.log(`\n미러 parity (simLadder 내부 F vs 라이브 runFisher F 첫판정): 불일치 ${parityMismatch}/${daysN}일${parityMismatch ? ` — 예: ${parityDates.join(", ")}` : ""}`);
  console.log(`\n[09창 반전경보(rev9) 역할 중복 — 0930 OR 세계에서]`);
  console.log(`rev9 발화 ${revFires}일 (본 유지 중 09창 F 반대 확인)`);
  console.log(`  → 발화 시점에 0930 F 상태가 이미 반전 방향(F 판정 문자 기중복): ${revFAlready}일`);
  console.log(`  → 0930 F가 발화 후 같은 방향 '전이' 도달: ${revF0930Same}일 · 시차 중앙 ${Number.isNaN(med(revLeadF)) ? "—" : `${med(revLeadF) >= 0 ? "+" : ""}${med(revLeadF)}분`} (양수 = rev9가 빠름)`);
  console.log(`  → 0930 본이 같은 방향 전이 도달: ${revB0930Same}일 · 시차 중앙 ${Number.isNaN(med(revLeadB)) ? "—" : `${med(revLeadB) >= 0 ? "+" : ""}${med(revLeadB)}분`}`);
  console.log(`  → 현행 본(이동 없음) 자체 전환 도달: ${revBCurSame}일 · 시차 중앙 ${Number.isNaN(med(revLeadBCur)) ? "—" : `${med(revLeadBCur) >= 0 ? "+" : ""}${med(revLeadBCur)}분`} — rev9 리드의 현재 가치`);
  console.log(`\n[장초반 완충 종료 — 10:30(현행) vs 10:00 (사용자 지시 8/1 밤)]`);
  const ev = (k: string) => evAgg.get(k) ?? { pnl: 0, cuts: 0 };
  console.log(`피셔F: 현행OR — 10:30 ${s1(agg.F[0].pnl)}%p(컷 ${agg.F[0].cuts}) vs 10:00 ${s1(ev("F|10:00|현행").pnl)}%p(컷 ${ev("F|10:00|현행").cuts})`);
  console.log(`       0930OR — 10:30 ${s1(agg.F[1].pnl)}%p(컷 ${agg.F[1].cuts}) vs 10:00 ${s1(ev("F|10:00|0930").pnl)}%p(컷 ${ev("F|10:00|0930").cuts})`);
  console.log(`피셔M: 현행OR — 10:30 ${s1(agg.M[0].pnl)}%p(컷 ${agg.M[0].cuts}) vs 10:00 ${s1(ev("M|10:00|현행").pnl)}%p(컷 ${ev("M|10:00|현행").cuts})`);
  console.log(`       0930OR — 10:30 ${s1(agg.M[1].pnl)}%p(컷 ${agg.M[1].cuts}) vs 10:00 ${s1(ev("M|10:00|0930").pnl)}%p(컷 ${ev("M|10:00|0930").cuts})`);
  console.log(`사다리: 현행OR — 10:30 ${s1(ladBase)}%p vs 10:00 ${s1(ev("lad|10:00|현행").pnl)}%p(컷일 ${ev("lad|10:00|현행").cuts})`);
  console.log(`        0930OR — 10:30 ${s1(ladV)}%p vs 10:00 ${s1(ev("lad|10:00|0930").pnl)}%p(컷일 ${ev("lad|10:00|0930").cuts})`);
  console.log(`\n[박스 시작 시각 격자 — 피셔F (전환 적용은 시작+15분부터)]`);
  for (const bs of BOX_STARTS) {
    const a = boxAgg.get(bs)!;
    console.log(`${bs}~${fmtT(tMin(bs) + 15)} 박스: ${s1(a.pnl)}%p · 컷 ${a.cuts}`);
  }
  console.log(`\n[월별 사다리]`);
  for (const [mon, v] of ladMonB) console.log(`${mon}: 현행 ${s1(v)} · 0930 ${s1(ladMonV.get(mon) ?? 0)}%p`);
}
main().catch((e) => { console.error(e); process.exit(1); });
