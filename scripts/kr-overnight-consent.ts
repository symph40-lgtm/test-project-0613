// 국장 1박 자격 정의 비교 (사용자 질문 2026-08-08 "비이견일이 아니라 동의일만 하면 어떻게 돼?"):
//   npx tsx scripts/kr-overnight-consent.ts
// 확정 사양(8/7)은 비이견일 = 동의(F 방향=창1 방향, F 확인이 창1 이후) + 무판정(F 신호 없음).
// 이 스크립트는 자격일을 4분류(동의·동의F선행·무판정·이견)해 각 레그의 1박(종가→익일 시가) 기여를 분리 측정.
// 데이터·판정 경로는 kr-overnight-sweep.ts와 동일(같은 캐시·같은 파라미터).
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
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

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };
type Cat = "동의" | "동의(F선행)" | "무판정" | "이견";

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

function analyze(name: string, days: Day[], isHx: boolean) {
  const cuts: boolean[] = [];
  type R = { date: string; base: number; dir: number; cat: Cat | null; ovn: number; t1: number; tF: number };
  const rows: R[] = [];
  for (let n = 0; n < days.length; n++) {
    const D = days[n], next = days[n + 1];
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const fT = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fT.length ? D.bars.findIndex(b => b.time === fT[0].time) : -1;
    const fJ = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
    const base = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs, prevCut2 || gapBig, isHighVolDay(D.hist)).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, fJ, C.newModel.ssV2.win).pnl;
    cuts.push(base <= -2.4);
    const first = trs.length ? trs[0] : null;
    let dir = 0, cat: Cat | null = null, ovn = 0;
    if (first && next && base > -2.4) {
      dir = first.to === "up" ? 1 : -1;
      const fd = fJ ? fJ.dir : 0;
      cat = fd === 0 ? "무판정" : fd === dir ? (fJ!.t >= hm(D.bars[first.i].time) ? "동의" : "동의(F선행)") : "이견";
      ovn = ((next.d.open - D.d.close) / D.d.close) * 100 * dir;
    }
    rows.push({ date: D.date, base, dir, cat, ovn, t1: first ? hm(D.bars[first.i].time) : -1, tF: fJ ? fJ.t : -1 });
  }
  const jul = (a: R[]) => a.filter(r => r.date >= "2026-07-01");
  const sum = (a: R[], f: (r: R) => number) => a.reduce((x, r) => x + f(r), 0);
  const worst = (a: R[], f: (r: R) => number) => a.length ? Math.min(...a.map(f)) : 0;

  console.log(`\n════ ${name} (${rows.length}일) ════`);
  console.log(`  ① 현행 당일청산            : 전체 ${s1(sum(rows, r => r.base))}%p (최악 ${worst(rows, r => r.base).toFixed(2)}) · 7월 ${s1(sum(jul(rows), r => r.base))}%p`);

  console.log(`  ── 레그별 1박(종가→익일 시가) 기여 ──`);
  for (const c of ["동의", "무판정", "동의(F선행)", "이견"] as Cat[]) {
    const g = rows.filter(r => r.cat === c);
    const win = g.filter(r => r.ovn > 0).length;
    console.log(`  ${c.padEnd(12)} ${String(g.length).padStart(3)}일: 1박 ${s1(sum(g, r => r.ovn))}%p (승률 ${g.length ? Math.round((win / g.length) * 100) : 0}% · 최악 ${worst(g, r => r.ovn).toFixed(2)} · 일당 ${s2(sum(g, r => r.ovn) / Math.max(1, g.length))}) · 7월 ${s1(sum(jul(g), r => r.ovn))}%p/${jul(g).length}일`);
  }

  // 왜 'F선행 동의'가 많은가 — 창1(사다리/누적)과 F(피셔 0.05·확인1)의 확인 시각 분포
  const t = (m: number) => m < 0 ? "--:--" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const med = (a: number[]) => a.length ? t(a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]) : "--:--";
  console.log(`  ── 확인 시각(중앙값) ──`);
  for (const c of ["동의", "동의(F선행)", "이견"] as Cat[]) {
    const g = rows.filter(r => r.cat === c);
    const pre = g.filter(r => r.tF >= 0 && r.tF < 540).length; // 09:00 이전 = NXT 프리장 확인
    console.log(`  ${c.padEnd(12)} ${String(g.length).padStart(3)}일: 창1 ${med(g.map(r => r.t1))} · F ${med(g.filter(r => r.tF >= 0).map(r => r.tF))} · F가 프리장(09시 전) 확인 ${pre}일`);
  }
  const withF = rows.filter(r => r.cat !== null && r.tF >= 0);
  console.log(`  전체 F 판정일 ${withF.length}일 중 F가 창1보다 이른 날 ${withF.filter(r => r.tF < r.t1).length}일`);

  console.log(`  ── 자격 정의별 합계(①+1박) ──`);
  const defs: [string, (r: R) => boolean][] = [
    ["A 비이견(동의+무판정)=확정본", r => r.cat === "동의" || r.cat === "무판정"],
    ["B 동의만", r => r.cat === "동의"],
    ["C 동의(F선행 포함)", r => r.cat === "동의" || r.cat === "동의(F선행)"],
    ["D 이견 제외 전부", r => r.cat !== null && r.cat !== "이견"],
    ["E 자격 무제한(이견 포함)", r => r.cat !== null],
  ];
  for (const [label, ok] of defs) {
    const f = (r: R) => r.base + (ok(r) ? r.ovn : 0);
    const n = rows.filter(ok).length;
    console.log(`  ${label.padEnd(26)}: 전체 ${s1(sum(rows, f))}%p (자격 ${String(n).padStart(3)}일 · 최악 ${worst(rows, f).toFixed(2)}) · 7월 ${s1(sum(jul(rows), f))}%p (일당 ${s2(sum(jul(rows), f) / Math.max(1, jul(rows).length))})`);
  }
}

const hx = collect("000660"); analyze("하이닉스", hx, true);
const ss = collect("005930"); analyze("삼성전자", ss, false);
