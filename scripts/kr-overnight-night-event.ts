// "밤사이 사건 크기가 동의 신호의 유효/무효를 가른다"는 가설 검증 (사용자 가설 2026-08-08):
//   npx tsx scripts/kr-overnight-night-event.ts
// 국장 t일 15:30 종가 → (그날 밤 미장 t일 세션 = KST 22:30~05:00) → t+1일 09:00 시가.
// 밤 사건의 대리변수 = SOXX t일 등락률. 층화해서 본다.
//   ① 갭 방향이 SOX 방향을 얼마나 따라가나 (밤 사건이 갭을 지배하는 정도)
//   ② |SOX| 크기 구간별로 동의 신호의 갭 적중률이 어떻게 변하나
//   ③ 동의 방향과 SOX 방향이 '같은 날' vs '반대인 날' — 가설의 핵심
//   ④ 응용: SOX가 반대로 간 날 NXT 프리장(08:00~)에서 조기 청산하면? (미장 결과는 05:00에 이미 안다)
// ⚠①~③은 사후 분석이다. 1박 진입 결정은 15:30이라 밤 사건을 미리 알 수 없다 — ④만 실행 가능한 규칙.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { candleJudgeStream, unitArr, simLadder, ovnWeight, hxOvnFisherDir } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type Day = { date: string; reg: MinuteBar[]; pre: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };
function collect(code: string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, pre, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d });
    daily.push(d);
  }
  return out;
}

type Row = { date: string; dir: number; w: number; gap: number; sox: number | null; preRet: number | null };

async function build(days: Day[], isHx: boolean, soxBy: Map<string, number>): Promise<Row[]> {
  const cuts: boolean[] = []; const out: Row[] = [];
  for (let i = 0; i < days.length; i++) {
    const D = days[i], next = days[i + 1];
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const ssF = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const ssIdx = ssF.length ? D.bars.findIndex(b => b.time === ssF[0].time) : -1;
    const ssJ = ssF.length && ssIdx >= 0 ? { i: ssIdx, t: hm(ssF[0].time), dir: (ssF[0].to === "up" ? 1 : -1) as 1 | -1, px: ssF[0].px } : null;
    const base = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs, defense, isHighVolDay(D.hist)).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, ssJ, C.newModel.ssV2.win).pnl;
    cuts.push(base <= -2.4);
    if (!next || !trs.length || base <= -2.4) continue;
    const dir = trs[0].to === "up" ? 1 : -1;
    const fDir = isHx ? hxOvnFisherDir(D.bars, D.hist, D.date) : (ssJ ? ssJ.dir : 0);
    if (fDir !== dir) continue;
    if (!isHx && ssJ && ssJ.t < hm(D.bars[trs[0].i].time)) continue;
    // 익일 NXT 프리장 마지막 완성봉(08:50 무렵) — 미장 결과 반영된 조기 청산 후보가
    const nPre = next.pre.filter(b => hm(b.time) >= hm("08:00") && hm(b.time) <= hm("08:55"));
    out.push({
      date: D.date, dir, w: ovnWeight(hm(D.bars[trs[0].i].time), gapBig),
      gap: ((next.d.open - D.d.close) / D.d.close) * 100,
      sox: soxBy.get(D.date) ?? null,
      preRet: nPre.length ? ((nPre[nPre.length - 1].close - D.d.close) / D.d.close) * 100 : null,
    });
  }
  return out;
}

function report(name: string, rows: Row[]) {
  const withSox = rows.filter(r => r.sox !== null) as (Row & { sox: number })[];
  console.log(`\n════ ${name} — 자격일 ${rows.length}일 (SOX 매칭 ${withSox.length}일) ════`);
  const soxHit = withSox.filter(r => r.gap * r.sox > 0).length;
  console.log(`  ① 갭 방향이 SOX 방향과 일치: ${pctOf(soxHit, withSox.length)} (${soxHit}/${withSox.length}) ← 밤 사건이 갭을 지배하는 정도`);

  console.log(`  ② |SOX| 크기 구간별 동의 신호의 갭 적중률`);
  const bands: [string, (a: number) => boolean][] = [
    ["|SOX| < 1%   (조용한 밤)", a => a < 1],
    ["1 ~ 2%", a => a >= 1 && a < 2],
    ["2 ~ 3%", a => a >= 2 && a < 3],
    ["≥ 3%        (큰 사건)", a => a >= 3],
  ];
  for (const [lb, f] of bands) {
    const g = withSox.filter(r => f(Math.abs(r.sox)));
    if (!g.length) { console.log(`     ${lb.padEnd(22)} 0일`); continue; }
    const hit = g.filter(r => r.gap * r.dir > 0).length;
    console.log(`     ${lb.padEnd(22)} ${String(g.length).padStart(3)}일 · 동의방향 갭적중 ${pctOf(hit, g.length).padStart(4)} · 방향기준 평균갭 ${s2(g.reduce((a, r) => a + r.gap * r.dir, 0) / g.length).padStart(6)}%`);
  }

  console.log(`  ③ 동의 방향 vs 밤 미장 방향 (가설의 핵심)`);
  for (const [lb, same] of [["같은 방향 (SOX가 동의를 지지)", true], ["반대 방향 (SOX가 동의를 부정)", false]] as [string, boolean][]) {
    const g = withSox.filter(r => (r.sox * r.dir > 0) === same);
    if (!g.length) continue;
    const hit = g.filter(r => r.gap * r.dir > 0).length;
    const avg = g.reduce((a, r) => a + r.gap * r.dir, 0) / g.length;
    console.log(`     ${lb.padEnd(30)} ${String(g.length).padStart(3)}일 · 갭적중 ${pctOf(hit, g.length).padStart(4)} · 평균 ${s2(avg).padStart(6)}% · 합 ${s1(g.reduce((a, r) => a + r.gap * r.dir * r.w, 0)).padStart(6)}%p(비중반영)`);
  }

  console.log(`  ④ 응용: SOX가 반대로 간 날 NXT 프리장(08:50) 조기 청산 vs 시가 청산`);
  const pre = withSox.filter(r => r.preRet !== null) as (Row & { sox: number; preRet: number })[];
  if (pre.length < 10) { console.log(`     프리장 데이터 ${pre.length}일 — 부족`); return; }
  // ⚠수익은 반드시 방향(dir)을 곱해야 한다 — 숏 자격일이 거꾸로 계산되지 않도록
  const total = (f: (r: typeof pre[0]) => number) => pre.reduce((a, r) => a + f(r) * r.dir * r.w, 0);
  console.log(`     프리장 데이터 있는 자격일 ${pre.length}일`);
  console.log(`     기준: 전부 시가 청산            합 ${s1(total(r => r.gap)).padStart(7)}%p`);
  console.log(`     전부 프리장 청산               합 ${s1(total(r => r.preRet)).padStart(7)}%p`);
  console.log(`     SOX 반대일만 프리장 청산        합 ${s1(total(r => (r.sox * r.dir < 0 ? r.preRet : r.gap))).padStart(7)}%p`);
  for (const th of [1, 2, 3]) {
    console.log(`     SOX 반대 & |SOX|≥${th}%만 프리장 청산  합 ${s1(total(r => (r.sox * r.dir < 0 && Math.abs(r.sox) >= th ? r.preRet : r.gap))).padStart(7)}%p`);
  }
}

async function main() {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 2 * 365 * 86400e3), interval: "1d" });
  const q = (r.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
  const soxBy = new Map<string, number>();
  for (let i = 1; i < q.length; i++) {
    const d = (q[i].date instanceof Date ? q[i].date : new Date(q[i].date)).toISOString().slice(0, 10);
    soxBy.set(d, ((q[i].close - q[i - 1].close) / q[i - 1].close) * 100);
  }
  report("하이닉스", await build(collect("000660"), true, soxBy));
  report("삼성전자", await build(collect("005930"), false, soxBy));
  console.log(`\n  ※ SOX = SOXX ETF의 미국 같은 날짜 등락률(한국 t일 밤 22:30~05:00 세션). ①~③은 사후 분석, ④만 실행 가능.`);
}
main();
