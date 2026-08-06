// 당일 우세 모델(신사다리 vs 계층) 사전 예측 가능성 실측 (사용자 질문 2026-08-06):
//   npx tsx scripts/nm-model-switch.ts
// 사전(개장 전·직후) 신호 4종으로 nm-old 격차를 조건화: ①고변동 예상(isHighVolDay, 전일까지 일봉)
// ②직전 3일 왕복성(|시가→종가|/고저폭 평균 — 낮으면 왕복장) ③직전 5일 추세일(|oc|≥3%) 수(추세 클러스터)
// ④개장 갭 크기. 이어서 단순 스위치/배합 규칙을 두 모델 단독과 비교. ⚠규칙 후보 소수 고정 — 과적합 경계.

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher, type FisherCfg } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

type Row = { date: string; nm: number; old: number; hv: boolean; eff3: number; trend5: number; gap: number };

type Tr = { time: string; to: "up" | "down"; px: number };
function leg(bb: MinuteBar[], tl: Tr[], close: number, stopPct: number): number {
  const idx = new Map<string, number>();
  bb.forEach((x, i) => { if (!idx.has(x.time)) idx.set(x.time, i); });
  const s = stopPct / 100;
  let p = 0;
  for (let k = 0; k < tl.length; k++) {
    const t = tl[k];
    const i0 = idx.get(t.time);
    if (i0 === undefined) continue;
    const endI = k + 1 < tl.length ? idx.get(tl[k + 1].time) ?? bb.length : bb.length;
    const dir = t.to === "up" ? 1 : -1;
    let cutHit = false;
    for (let i = i0 + 1; i < endI; i++) if (dir === 1 ? bb[i].low <= t.px * (1 - s) : bb[i].high >= t.px * (1 + s)) { cutHit = true; break; }
    p += cutHit ? -stopPct : (((k + 1 < tl.length ? tl[k + 1].px : close) - t.px) / t.px) * 100 * dir;
  }
  return p;
}
const loadDay = (f: string): MinuteBar[] | null => (existsSync(resolve(CACHE, f)) ? (JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as MinuteBar[]) : null);

const DAILY_OUT: Record<string, PredictDailyBar[]> = {};
function series(code: string, nmOld: (bars: MinuteBar[], krx: MinuteBar[], hist: PredictDailyBar[], r10: number, prevCut2: boolean, close: number) => { nm: number; old: number }): Row[] {
  const files = readdirSync(CACHE).filter((f) => new RegExp(`^${code}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort();
  const daily: PredictDailyBar[] = [];
  const out: Row[] = [];
  const cuts: boolean[] = [];
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
      const r = nmOld([...pre, ...reg], reg, hist, r10, prevCut2, day.close);
      const p3 = hist.slice(-3);
      const eff3 = p3.reduce((a, b) => a + (b.high > b.low ? Math.abs(b.close - b.open) / (b.high - b.low) : 0), 0) / p3.length;
      const trend5 = hist.slice(-5).filter((b) => Math.abs(((b.close - b.open) / b.open) * 100) >= 3).length;
      const gap = Math.abs(((reg[0].open - hist[hist.length - 1].close) / hist[hist.length - 1].close) * 100);
      out.push({ date, nm: r.nm, old: r.old, hv: isHighVolDay(hist), eff3, trend5, gap });
      cuts.push(r.nm <= -2.4);
    }
    daily.push(day);
  }
  DAILY_OUT[code] = daily;
  return out;
}

function julyProfile(name: string, rows: Row[], daily: PredictDailyBar[]) {
  const jul = daily.filter((d) => d.date >= "2026-07-01" && d.date <= "2026-07-31");
  if (!jul.length) return;
  const monthMove = ((jul[jul.length - 1].close - jul[0].open) / jul[0].open) * 100;
  const ocs = jul.map((d) => ((d.close - d.open) / d.open) * 100);
  const big5 = ocs.filter((x) => Math.abs(x) >= 5).length;
  const big3 = ocs.filter((x) => Math.abs(x) >= 3).length;
  const dn = ocs.filter((x) => x < 0).length;
  const avgAbs = ocs.reduce((a, x) => a + Math.abs(x), 0) / ocs.length;
  console.log(`\n[7월 프로필 — ${name}] 월간(시가→월말종가) ${s1(monthMove)}% · 거래일 ${jul.length}일(하락 마감 ${dn}일) · 일중 |시가→종가| 평균 ${avgAbs.toFixed(2)}% · ≥5% ${big5}일 · ≥3% ${big3}일`);
}

function analyze(name: string, rows: Row[]) {
  console.log(`\n════ ${name} (${rows.length}일) ════`);
  const diff = (a: Row[]) => a.reduce((x, r) => x + (r.nm - r.old), 0);
  const mean = (a: Row[]) => (a.length ? diff(a) / a.length : 0);
  const seg = (label: string, pred: (r: Row) => boolean) => {
    const y = rows.filter(pred), n = rows.filter((r) => !pred(r));
    console.log(`${label}: 해당 ${y.length}일 격차/일 ${s2(mean(y))} · 비해당 ${n.length}일 ${s2(mean(n))}`);
  };
  seg("① 고변동 예상일(isHighVolDay)", (r) => r.hv);
  const effMed = [...rows].sort((a, b) => a.eff3 - b.eff3)[Math.floor(rows.length / 2)].eff3;
  seg(`② 직전 3일 왕복장(효율<중앙 ${effMed.toFixed(2)})`, (r) => r.eff3 < effMed);
  seg("③ 직전 5일 추세일(|oc|≥3%) ≥1", (r) => r.trend5 >= 1);
  seg("④ 개장 갭 ≥2%", (r) => r.gap >= 2);

  const total = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  console.log(`단독: 신 ${s1(total((r) => r.nm))} · 계층 ${s1(total((r) => r.old))} · 반반 배합 ${s1(total((r) => (r.nm + r.old) / 2))}`);
  const rules: [string, (r: Row) => boolean][] = [
    ["스위치A: 고변동 예상→신, 그 외 계층", (r) => r.hv],
    ["스위치B: 최근 추세일≥1→신, 그 외 계층", (r) => r.trend5 >= 1],
    ["스위치C: 왕복장(효율<중앙)→계층, 그 외 신", (r) => !(r.eff3 < effMed)],
  ];
  for (const [label, useNm] of rules) console.log(`${label}: ${s1(total((r) => (useNm(r) ? r.nm : r.old)))}`);
  // 최악일·컷 비교 (반반 배합의 방어 효과)
  const worst = (f: (r: Row) => number) => Math.min(...rows.map(f));
  console.log(`최악일: 신 ${worst((r) => r.nm).toFixed(2)} · 계층 ${worst((r) => r.old).toFixed(2)} · 반반 ${worst((r) => (r.nm + r.old) / 2).toFixed(2)}`);
}

async function main() {
  const hxF: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const hxM: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const hxB: FisherCfg = { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes };
  const hxRows = series("000660", (bars, krx, hist, r10, prevCut2, close) => {
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const gapBig = Math.abs(((krx[0].open - hist[hist.length - 1].close) / hist[hist.length - 1].close) * 100) >= 4;
    const nm = simLadder(bars, r10, close, trs, prevCut2 || gapBig, isHighVolDay(hist)).pnl;
    const mk = (b: MinuteBar[]) => ({ date: "x", dailyHistory: hist, openPx: b[0].open, morning: b, prevDayMinutes: null });
    const old = 0.2 * leg(bars, (runFisher(mk(bars), hxF).transitions ?? []), close, 2.5)
      + 0.3 * leg(bars, (runFisher(mk(bars), hxM).transitions ?? []), close, 2.5)
      + 0.5 * leg(krx, krx.length >= 20 ? (runFisher(mk(krx), hxB).transitions ?? []) : [], close, 2.5);
    return { nm, old };
  });
  analyze("하이닉스 — 전체", hxRows);
  analyze("하이닉스 — 최근 1개월(7/1~)", hxRows.filter((r) => r.date >= "2026-07-01"));
  julyProfile("하이닉스", hxRows, DAILY_OUT["000660"] ?? []);

  const ssF: FisherCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const ssM: FisherCfg = { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
  const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  const ssRows = series("005930", (bars, krx, hist, r10, _pc, close) => {
    const fTrs = bars.length >= 20 ? (runFisher({ date: "x", dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    const fJ = fTrs.length && fIdx >= 0 ? { i: fIdx, t: hhmmToMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as 1 | -1, px: fTrs[0].px } : null;
    const nm = simV2(bars, r10, close, C.newModel.ssV2.tan, fJ, C.newModel.ssV2.win).pnl;
    const mk = (b: MinuteBar[]) => ({ date: "x", dailyHistory: hist, openPx: b[0].open, morning: b, prevDayMinutes: null });
    const ssBcfg: FisherCfg = { strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, ...(isHighVolDay(hist) ? { trailRangeRatio: C.ssTrail.rangeRatio, trailConfirmMinutes: C.ssTrail.confirmMinutes } : {}) };
    const old = 0.2 * leg(bars, (runFisher(mk(bars), ssF).transitions ?? []), close, 1.5)
      + 0.3 * leg(bars, (runFisher(mk(bars), ssM).transitions ?? []), close, 1.5)
      + 0.5 * leg(krx, krx.length >= 20 ? (runFisher(mk(krx), ssBcfg).transitions ?? []) : [], close, 1.5);
    return { nm, old };
  });
  analyze("삼성전자 — 전체", ssRows);
  analyze("삼성전자 — 최근 1개월(7/1~)", ssRows.filter((r) => r.date >= "2026-07-01"));
  julyProfile("삼성전자", ssRows, DAILY_OUT["005930"] ?? []);
}
main().catch((e) => { console.error(e); process.exit(1); });
