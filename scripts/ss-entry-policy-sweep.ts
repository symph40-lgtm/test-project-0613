// 삼전 v2 진입 정책 스윕 (사용자 질문 2026-08-08 — 8/6 레버 오진입 후속: "창판정 먼저 오면 50%만?
// 아예 피셔 올 때까지 기다릴까? 09:07 인버스로 갔어야 하는데 어떻게 수정하면 될까"):
//   npx tsx scripts/ss-entry-policy-sweep.ts
// 변형 (모두 스탑 본주 -1.5% 레그별·종가 청산·F는 rebox판):
//   A 현행: 창1 100% 즉시 → F 반대 확인 시 전량 청산+100% 역진입, 창 전환 무시
//   B 창1 50% → F 동의 시 +50%(100%) / F 반대 시 전량 청산+100% 역진입
//   C F 대기: F 첫확인만 100% 진입 (창 무시)
//   D 창 전환 반영: 창1 100% + 창 전환 시 전량 전환 (F 무시)
//   E 창1 50% → F 동의 100% / F 반대 역진입 + '창 전환도 50% 축소' 절충
// 8/6 실사례(첫판정 오인·레버 컷 -3.0%)가 각 변형에서 어떻게 되는지도 별도 표기.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { unitArr } from "../lib/predict/candleWindow";
import { cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const STOP = 1.5;

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; close: number };
function collect(): Day[] {
  const code = "005930";
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, close: d.close });
    daily.push(d);
  }
  return out;
}

// 레그: i0에서 dir 방향 size 진입, endI(강제 청산) 전까지 스탑 감시, 아니면 종가
function leg(bars: MinuteBar[], close: number, i0: number, dir: 1 | -1, px: number, size: number, endI?: number, endPx?: number): { pnl: number; cut: boolean } {
  if (size <= 0) return { pnl: 0, cut: false };
  const s = STOP / 100, lim = endI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    if (dir === 1 ? bars[k].low <= px * (1 - s) : bars[k].high >= px * (1 + s)) return { pnl: -STOP * size, cut: true };
  }
  const px2 = endI !== undefined ? (endPx ?? close) : close;
  return { pnl: ((px2 - px) / px) * 100 * dir * size, cut: false };
}

type J = { i: number; t: number; dir: 1 | -1; px: number };

function runDay(D: Day, policy: "A" | "B" | "C" | "D" | "E"): { pnl: number; cut: boolean } {
  const unit = unitArr(D.bars, D.r10);
  const trs = cumStream(D.bars, unit, C.newModel.ssV2.tan, C.newModel.ssV2.win);
  const cw: J | null = trs.length ? { i: trs[0].i, t: hm(D.bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const flip = trs.length >= 2 ? { i: trs[1].i, dir: (trs[1].to === "up" ? 1 : -1) as 1 | -1, px: trs[1].px } : null;
  const fT = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
  const fIdx = fT.length ? D.bars.findIndex(b => b.time === fT[0].time) : -1;
  const fJ: J | null = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
  const fFirst = fJ && cw && fJ.t < cw.t;
  let pnl = 0, cut = false;
  const add = (r: { pnl: number; cut: boolean }) => { pnl += r.pnl; cut = cut || r.cut; };

  if (policy === "C") {
    if (fJ) add(leg(D.bars, D.close, fJ.i, fJ.dir, fJ.px, 1));
    return { pnl, cut };
  }
  if (!cw || fFirst) return { pnl: 0, cut: false }; // F 선행일 관망 (현행 동일)

  if (policy === "A") {
    const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
    add(leg(D.bars, D.close, cw.i, cw.dir, cw.px, 1, fOpp?.i, fOpp?.px));
    if (fOpp) add(leg(D.bars, D.close, fOpp.i, fOpp.dir, fOpp.px, 1));
  } else if (policy === "B" || policy === "E") {
    const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
    const fAgree = fJ && fJ.dir === cw.dir && fJ.t > cw.t ? fJ : null;
    const flipEnd = policy === "E" && flip && (!fOpp || flip.i < fOpp.i) && flip.i > cw.i ? flip : null;
    // 정찰 50%
    add(leg(D.bars, D.close, cw.i, cw.dir, cw.px, 0.5, fOpp?.i ?? flipEnd?.i, fOpp?.px ?? flipEnd?.px));
    // F 동의 시 +50%
    if (fAgree && (!flipEnd || fAgree.i < flipEnd.i)) add(leg(D.bars, D.close, fAgree.i, cw.dir, fAgree.px, 0.5, fOpp?.i ?? flipEnd?.i, fOpp?.px ?? flipEnd?.px));
    // F 반대 시 100% 역진입
    if (fOpp) add(leg(D.bars, D.close, fOpp.i, fOpp.dir, fOpp.px, 1));
  } else if (policy === "D") {
    add(leg(D.bars, D.close, cw.i, cw.dir, cw.px, 1, flip?.i, flip?.px));
    if (flip) add(leg(D.bars, D.close, flip.i, flip.dir, flip.px, 1));
  }
  return { pnl, cut };
}

const days = collect();
console.log(`삼성전자 ${days.length}일 (${days[0].date} ~ ${days[days.length - 1].date})\n`);
console.log(`  정책                                     전체      일당    승률   컷률   최악    최근1개월   8/6 실사례`);
for (const [p, label] of [["A", "현행: 창 100% 즉시·F 반대 역진입"], ["B", "창 50% → F동의 100% / F반대 역진입"], ["C", "F 확인까지 대기 (창 무시)"], ["D", "창 100% + 창 전환 반영 (F 무시)"], ["E", "B + 창 전환 시 정찰 청산"]] as ["A" | "B" | "C" | "D" | "E", string][]) {
  const rows = days.map(D => ({ date: D.date, ...runDay(D, p) }));
  const traded = rows.filter(r => r.pnl !== 0 || r.cut);
  const tot = rows.reduce((a, r) => a + r.pnl, 0);
  const wins = traded.filter(r => r.pnl > 0).length;
  const cuts = traded.filter(r => r.cut).length;
  const worst = Math.min(...rows.map(r => r.pnl));
  const m1 = rows.slice(-21).reduce((a, r) => a + r.pnl, 0);
  const d86 = rows.find(r => r.date === "2026-08-06");
  console.log(`  ${p} ${label.padEnd(34)} ${s1(tot).padStart(7)}%p ${s2(tot / days.length).padStart(6)} ${`${Math.round(wins / Math.max(1, traded.length) * 100)}%`.padStart(5)} ${`${Math.round(cuts / Math.max(1, traded.length) * 100)}%`.padStart(5)} ${worst.toFixed(2).padStart(6)} ${s1(m1).padStart(8)}%p ${d86 ? s2(d86.pnl).padStart(8) : "     —"}`);
}
console.log(`\n  ※ 8/6 열은 '완전 데이터 기준' 재현 — 라이브는 프리장 결손으로 첫판정을 09:00 상승으로 오인해 실제 -3.00%.`);
