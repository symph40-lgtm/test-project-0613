// 신모델 최근 1개월(7월) 파라미터 재도출 (사용자 지시 2026-08-06 "최근 1달 데이터로 최적 파라미터"):
//   npx tsx scripts/nm-july-param-sweep.ts
// ⚠과적합 경계: 22일 격자의 최고 셀은 운 범위일 수 있음 — 각 셀의 '전체 217일' 성적을 병기해
//   "7월 개선 + 전체 비훼손" 셀만 채택 후보로 판정 (관례: 소표본 첨점 기각·평원만 신뢰).
// 하이닉스 사다리: ①창 눈금 스케일 k(현행 1.0 = 30봉평균폭×0.5) ②방어 변형(현행 갭4%·서킷 / 방어 off /
//   갭 7%로 완화). 삼성전자 v2: 창 크기(4/5/6봉) × 문턱 tan(0.8/1.0/1.2).

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  m && !process.env[m[1]] && (process.env[m[1]] = m[2]);
}
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const JUL = "2026-07-01";
const loadDay = (f: string): MinuteBar[] | null => (existsSync(resolve(CACHE, f)) ? (JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as MinuteBar[]) : null);

function iterate(code: string, perDay: (date: string, bars: MinuteBar[], krx: MinuteBar[], hist: PredictDailyBar[], r10: number, prevCut2: boolean, close: number) => Record<string, number>): Map<string, { jul: number; all: number }> {
  const files = readdirSync(CACHE).filter((f) => new RegExp(`^${code}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort();
  const daily: PredictDailyBar[] = [];
  const cuts: boolean[] = [];
  const acc = new Map<string, { jul: number; all: number }>();
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = loadDay(f) ?? [];
    if (reg.length < 100) continue;
    const pre = loadDay(`${code}NX-${date}.json`) ?? [];
    const hist = daily.slice(-120);
    const day: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map((b) => b.high)), low: Math.min(...reg.map((b) => b.low)), volume: 0 };
    if (hist.length >= 15) {
      const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
      const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
      const res = perDay(date, [...pre, ...reg], reg, hist, r10, prevCut2, day.close);
      for (const [k, v] of Object.entries(res)) {
        const a = acc.get(k) ?? { jul: 0, all: 0 };
        a.all += v;
        if (date >= JUL) a.jul += v;
        acc.set(k, a);
      }
      cuts.push((res["기준(현행)"] ?? 0) <= -2.4);
    }
    daily.push(day);
  }
  return acc;
}

function show(name: string, acc: Map<string, { jul: number; all: number }>, base: string) {
  console.log(`\n════ ${name} — 7월(22일) vs 전체(217일) ════`);
  const b = acc.get(base)!;
  const rows = [...acc.entries()].sort((x, y) => y[1].jul - x[1].jul);
  for (const [k, v] of rows) {
    console.log(`${k.padEnd(28)}: 7월 ${s1(v.jul)} (Δ${s1(v.jul - b.jul)}) · 전체 ${s1(v.all)} (Δ${s1(v.all - b.all)})`);
  }
}

async function main() {
  // 하이닉스: 눈금 k × 방어 변형
  const hxAcc = iterate("000660", (_d, bars, krx, hist, r10, prevCut2, close) => {
    const prevClose = hist[hist.length - 1].close;
    const gapAbs = Math.abs(((krx[0].open - prevClose) / prevClose) * 100);
    const hv = isHighVolDay(hist);
    const out: Record<string, number> = {};
    for (const k of [0.8, 1.0, 1.2, 1.4]) {
      const unit = unitArr(bars, r10).map((u) => u * k);
      const trs = candleJudgeStream(bars, unit);
      for (const [dLab, def] of [["현행방어", prevCut2 || gapAbs >= 4], ["방어off", false], ["갭7만", prevCut2 || gapAbs >= 7]] as const) {
        const lab = k === 1.0 && dLab === "현행방어" ? "기준(현행)" : `눈금${k}·${dLab}`;
        out[lab] = simLadder(bars, r10, close, trs, def as boolean, hv).pnl;
      }
    }
    return out;
  });
  show("하이닉스 사다리", hxAcc, "기준(현행)");

  // 삼성전자: win × tan
  const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  const ssAcc = iterate("005930", (_d, bars, _krx, hist, r10, _pc, close) => {
    const fTrs = bars.length >= 20 ? (runFisher({ date: "x", dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    const fJ = fTrs.length && fIdx >= 0 ? { i: fIdx, t: hhmmToMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    const out: Record<string, number> = {};
    for (const win of [4, 5, 6]) for (const tan of [0.8, 1.0, 1.2]) {
      const lab = win === C.newModel.ssV2.win && tan === C.newModel.ssV2.tan ? "기준(현행)" : `${win}봉·tan${tan}`;
      out[lab] = simV2(bars, r10, close, tan, fJ, win).pnl;
    }
    return out;
  });
  show("삼성전자 v2", ssAcc, "기준(현행)");
}
main().catch((e) => { console.error(e); process.exit(1); });
