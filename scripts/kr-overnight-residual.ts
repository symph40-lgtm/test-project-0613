// 국장 1박 실무 점검 (사용자 질문 2026-08-08 "진입이 없었던 날은 50%를 진입하는 것으로 해야 하나?"):
//   npx tsx scripts/kr-overnight-residual.ts
// 백테스트의 1박 수익은 '종가에 방향 포지션이 있다'는 가정으로 (익일시가-종가)/종가를 더한다.
// 그런데 라이브에서는 자격일이라도 낮에 스탑/전환으로 이미 정리돼 종가에 포지션이 없을 수 있다.
// 그런 날 1박을 하려면 '종가에 새로 사는' 행위가 필요 — 그 비중이 얼마나 되고 성적이 어디서 나오는지 분해한다.
// 잔여 추적은 simLadder(하닉)·simV2(삼전)의 레그 구조를 그대로 미러링.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder, fisherFirstKr, ovnWeight } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const HX_STOP = 2.5, SS_STOP = 1.5;

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };
function collect(code: string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d });
    daily.push(d);
  }
  return out;
}

// 종가까지 살아남은 레그의 방향별 비중 (양수 = 상승 방향 보유, 음수 = 하락 방향 보유)
function survives(bars: MinuteBar[], i0: number, dir: 1 | -1, px: number, stopPct: number, forceI?: number): boolean {
  if (forceI !== undefined) return false; // 낮에 강제 청산(전환·이견)된 레그
  const s = stopPct / 100;
  for (let k = i0 + 1; k < bars.length; k++) {
    const b = bars[k];
    if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return false; // 스탑
  }
  return true;
}

function hxResidual(bars: MinuteBar[], r10: number, trs: { i: number; to: "up" | "down"; px: number }[], highVol: boolean, defense: boolean, fJ: { t: number; i: number; dir: 1 | -1; px: number } | null): number {
  const cw = trs.length ? { t: hm(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const cwFlip = trs.length ? trs.find((x) => x.i > trs[0].i && x.to !== trs[0].to) ?? null : null;
  let held = 0, size = 0;
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    const oppI = opp ? cw!.i : undefined;
    if (survives(bars, fJ.i, fJ.dir, fJ.px, HX_STOP, oppI)) size += (defense ? 0.15 : 0.3);
    held = 0.3;
    const evs: { i: number; target: number; px: number }[] = [];
    if (fJ.i + 5 < bars.length && (bars[fJ.i + 5].close - fJ.px) * fJ.dir >= 0.1 * r10) evs.push({ i: fJ.i + 5, target: 0.7, px: bars[fJ.i + 5].close });
    for (let k = fJ.i + 1; k < bars.length; k++) if ((bars[k].close - fJ.px) * fJ.dir >= 0.3 * r10) { evs.push({ i: k, target: 1.0, px: bars[k].close }); break; }
    if (cw && cw.dir === fJ.dir) evs.push({ i: cw.i, target: 1.0, px: cw.px });
    evs.sort((a, b) => a.i - b.i);
    for (const ev of evs) {
      if (oppI !== undefined && ev.i >= oppI) break;
      const add = ev.target - held;
      if (add <= 0) continue;
      if (survives(bars, ev.i, fJ.dir, ev.px, HX_STOP, oppI)) size += add;
      held = ev.target;
    }
    if (opp && cw) {
      const rEnd = highVol ? cwFlip : null;
      if (survives(bars, cw.i, cw.dir, cw.px, HX_STOP, rEnd?.i)) size += 1.0;
    }
  } else if (cw) {
    const fOppLate = fJ && fJ.dir !== cw.dir ? fJ : null;
    const flipEx = highVol ? cwFlip : null;
    let endI: number | undefined;
    if (flipEx && (!fOppLate || flipEx.i <= fOppLate.i)) endI = flipEx.i;
    else if (fOppLate) endI = fOppLate.i;
    if (survives(bars, cw.i, cw.dir, cw.px, HX_STOP, endI)) size += 1.0;
  }
  return size;
}

function ssResidual(bars: MinuteBar[], trs: { i: number; to: "up" | "down"; px: number }[], fJ: { t: number; i: number; dir: 1 | -1; px: number } | null): number {
  const cw = trs.length ? { t: hm(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  let size = 0;
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    if (survives(bars, fJ.i, fJ.dir, fJ.px, SS_STOP, opp ? cw!.i : undefined)) size += 0.3;
    if (cw && cw.dir === fJ.dir && survives(bars, cw.i, fJ.dir, cw.px, SS_STOP)) size += 0.7;
    if (opp && cw && survives(bars, cw.i, cw.dir, cw.px, SS_STOP)) size += 1.0;
  } else if (cw) {
    const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
    if (survives(bars, cw.i, cw.dir, cw.px, SS_STOP, fOpp?.i)) size += 1.0;
    if (fOpp && survives(bars, fOpp.i, fOpp.dir, fOpp.px, SS_STOP)) size += 1.0;
  }
  return size;
}

function run(name: string, days: Day[], isHx: boolean) {
  const cuts: boolean[] = [];
  type R = { date: string; w: number; resid: number; ovn: number; known: number; stop3: number; dayStop: number };
  const rows: R[] = [];
  for (let i = 0; i < days.length; i++) {
    const D = days[i], next = days[i + 1];
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const hv = isHighVolDay(D.hist);
    const ssF = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const ssIdx = ssF.length ? D.bars.findIndex(b => b.time === ssF[0].time) : -1;
    const ssJ = ssF.length && ssIdx >= 0 ? { i: ssIdx, t: hm(ssF[0].time), dir: (ssF[0].to === "up" ? 1 : -1) as 1 | -1, px: ssF[0].px } : null;
    const base = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs, defense, hv).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, ssJ, C.newModel.ssV2.win).pnl;
    cuts.push(base <= -2.4);
    const first = trs.length ? trs[0] : null;
    if (!first || !next || base <= -2.4 || !ssJ) continue;
    const dir = first.to === "up" ? 1 : -1;
    if (ssJ.dir !== dir) continue;                    // 자격 C (동의일)
    const t1 = hm(D.bars[first.i].time);
    if (!isHx && ssJ.t < t1) continue;                // 삼전 F 선행일 = 관망
    const resid = isHx ? hxResidual(D.bars, D.r10, trs, hv, defense, fisherFirstKr(D.bars, D.r10)) : ssResidual(D.bars, trs, ssJ);
    const rng3 = D.hist.slice(-3).reduce((a, b) => a + ((b.high - b.low) / b.close) * 100, 0) / 3;
    rows.push({
      date: D.date, w: ovnWeight(t1, gapBig), resid,
      ovn: ((next.d.open - D.d.close) / D.d.close) * 100 * dir,
      known: Math.max(t1, ssJ.t), stop3: rng3 * 0.75, dayStop: isHx ? HX_STOP : SS_STOP,
    });
  }
  const g = (f: (r: R) => boolean) => rows.filter(f);
  const rep = (label: string, a: R[]) => {
    const s = a.reduce((x, r) => x + r.ovn * r.w, 0);
    const jul = a.filter(r => r.date >= "2026-07-01");
    console.log(`  ${label.padEnd(30)} ${String(a.length).padStart(3)}일 · 1박(비중반영) ${s1(s)}%p (일당 ${s2(s / Math.max(1, a.length))}) · 7월 ${s1(jul.reduce((x, r) => x + r.ovn * r.w, 0))}/${jul.length}일`);
  };
  console.log(`\n════ ${name} — 자격 ${rows.length}일 ════`);
  rep("종가 잔여 ≥ 목표비중 (그대로 유지)", g(r => r.resid >= r.w - 1e-9));
  rep("종가 잔여 부족 (추가 매수 필요)", g(r => r.resid < r.w - 1e-9 && r.resid > 0));
  rep("종가 잔여 0 (전량 신규 매수)", g(r => r.resid <= 1e-9));
  const need = g(r => r.resid < r.w - 1e-9);
  const short = need.reduce((a, r) => a + (r.w - r.resid), 0);
  console.log(`  → 추가 매수가 필요한 날 ${need.length}/${rows.length}일 · 평균 부족분 ${(short / Math.max(1, need.length) * 100).toFixed(0)}%p`);
  // 1박 여부를 언제 알 수 있나 (창·F 첫판정 중 늦은 쪽 = 자격 확정 시각)
  const late = (m: number) => rows.filter((r) => r.known > m).length;
  console.log(`  자격 확정 시각: 15:20 이후 확정 ${late(920)}일 · 15:00 이후 ${late(900)}일 · 14:00 이후 ${late(840)}일 (나머지는 장중 확정)`);
  // 스탑 폭 후보 — 밤 경로 데이터가 없으므로 '익일 시가가 그 폭을 불리하게 넘는 빈도'만 실측 가능
  const cand: [string, (r: R) => number][] = [
    ["3일폭×0.75 (사양)", (r) => r.stop3],
    ["낮 스탑과 동일", (r) => r.dayStop],
    ["낮 스탑×2 (재난선)", (r) => r.dayStop * 2],
  ];
  for (const [nm, f] of cand) {
    const through = rows.filter((r) => r.ovn < -f(r));
    const avgW = rows.reduce((a, r) => a + f(r), 0) / rows.length;
    console.log(`  스탑 ${nm.padEnd(20)} 평균 폭 본주 ${avgW.toFixed(2)}%(ETF ${(avgW * 2).toFixed(1)}%) · 시가가 이 폭 넘어 하락 ${through.length}일(${Math.round(through.length / rows.length * 100)}%) — 미체결·시가 청산`);
  }
  const keepOnly = rows.map(r => r.ovn * Math.min(r.w, r.resid)).reduce((a, b) => a + b, 0);
  const full = rows.reduce((a, r) => a + r.ovn * r.w, 0);
  console.log(`  1박 합계: 사양대로(부족분 종가 매수) ${s1(full)}%p · 보유분만(추가 매수 안 함) ${s1(keepOnly)}%p — 차이 ${s1(full - keepOnly)}`);
}

run("하이닉스", collect("000660"), true);
run("삼성전자", collect("005930"), false);
