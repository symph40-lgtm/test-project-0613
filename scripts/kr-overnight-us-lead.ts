// 1박 자격에 '미장 선행지표'를 붙일 수 있나 (사용자 지시 2026-08-08):
//   npx tsx scripts/kr-overnight-us-lead.ts
// 두 시점을 나눠 본다. 각 시점에 '그때 실제로 알 수 있는 값'만 쓴다.
//   ⓐ 15:30 (국장 종가·1박 진입 결정): 전날 밤 SOX 종가 등락 + 전날 밤 SOXX 애프터 흐름
//   ⓑ 19:40 (국장 애프터장 마감 20:00 직전 · 미장 프리장 ET 06:40 진행 중, 사용자 제안):
//      SOXX 프리장 04:00~06:40 ET 흐름으로 1박 유지/청산을 재결정 → 국장 애프터장에서 실행
// 청산가: 국장 애프터(NXT) 19:40~20:00 마지막 완성봉. 하닉 000660NXA-* · 삼전 005930-ah-*.
// ⚠메모리에 '조기 프리장(04:30~07:00) 판정은 역예측' 기록이 있다(SOXX 자체 방향 기준) —
//   여기서는 대상이 다르다(국장 1박 유지 여부). 그래도 같은 결론이 나오는지 확인이 목적.
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
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type SoxxBarRaw = { etMin: number; close: number };
// 그날(미국 date) SOXX 프리장 04:00~cutoffEt 흐름 (전일 정규장 종가 대비 %)
function soxxPre(date: string, cutoffEt: number, prevClose: number | undefined): number | null {
  const f = resolve(CACHE, `SOXXM-${date}.json`);
  if (!existsSync(f) || prevClose === undefined) return null;
  const raw = JSON.parse(readFileSync(f, "utf8")) as SoxxBarRaw[];
  const pre = raw.filter(b => b.etMin >= 240 && b.etMin <= cutoffEt).sort((a, b) => a.etMin - b.etMin);
  if (pre.length < 5) return null;
  return ((pre[pre.length - 1].close - prevClose) / prevClose) * 100;
}

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar; ah: MinuteBar[] };
function collect(code: string, ahName: (d: string) => string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    const ah = (load(ahName(date)) ?? []).filter(b => hm(b.time) >= hm("19:30") && hm(b.time) <= hm("20:05"));
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d, ah });
    daily.push(d);
  }
  return out;
}

type Row = { date: string; dir: number; w: number; gap: number; prevSox: number | null; preSox: number | null; ahExit: number | null; soxNight: number | null };

async function build(days: Day[], isHx: boolean, soxDaily: Map<string, number>, soxClose: Map<string, number>): Promise<Row[]> {
  const cuts: boolean[] = []; const out: Row[] = [];
  const dates = [...soxClose.keys()].sort();
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
    // ⓐ 15:30에 아는 값 = '전날' 미국 세션 종가 등락 (한국 t일 15:30 시점 기준 최근 마감분)
    const prevUs = dates.filter(x => x < D.date).pop();
    // ⓑ 19:40에 아는 값 = 오늘 밤 미국 세션의 프리장 04:00~06:40 ET 흐름
    const preSox = soxxPre(D.date, 400, prevUs ? soxClose.get(prevUs) : undefined);
    out.push({
      date: D.date, dir, w: ovnWeight(hm(D.bars[trs[0].i].time), gapBig),
      gap: ((next.d.open - D.d.close) / D.d.close) * 100,
      prevSox: prevUs ? soxDaily.get(prevUs) ?? null : null,
      preSox,
      ahExit: D.ah.length ? ((D.ah[D.ah.length - 1].close - D.d.close) / D.d.close) * 100 : null,
      soxNight: soxDaily.get(D.date) ?? null,
    });
  }
  return out;
}

function report(name: string, rows: Row[]) {
  console.log(`\n════ ${name} — 자격일 ${rows.length}일 ════`);
  const W = (f: (r: Row) => number, g = rows) => g.reduce((a, r) => a + f(r) * r.dir * r.w, 0);
  console.log(`  기준(현행): 전부 시가 청산  합 ${s1(W(r => r.gap))}%p`);

  // ⓐ 15:30 시점: 전날 미국 세션 등락으로 자격을 좁히면?
  const a = rows.filter(r => r.prevSox !== null);
  console.log(`  ── ⓐ 15:30 게이트: 전날 미국 세션 방향 (${a.length}일) ──`);
  for (const [lb, ok] of [
    ["전날 SOX가 동의 방향과 같은 날만 1박", (r: Row) => (r.prevSox ?? 0) * r.dir > 0],
    ["전날 SOX 반대면 비중 절반", null],
  ] as [string, ((r: Row) => boolean) | null][]) {
    if (!ok) {
      const v = a.reduce((s, r) => s + r.gap * r.dir * r.w * ((r.prevSox ?? 0) * r.dir < 0 ? 0.5 : 1), 0);
      console.log(`     ${lb.padEnd(32)} 합 ${s1(v).padStart(7)}%p`);
      continue;
    }
    const g = a.filter(ok);
    const hit = g.filter(r => r.gap * r.dir > 0).length;
    console.log(`     ${lb.padEnd(32)} ${String(g.length).padStart(3)}일 · 합 ${s1(W(r => r.gap, g)).padStart(7)}%p · 갭적중 ${pctOf(hit, g.length)}`);
  }
  const aHit = a.filter(r => (r.prevSox ?? 0) * (r.soxNight ?? 0) > 0).length;
  console.log(`     참고: 전날 미국 방향이 '오늘 밤' 미국 방향과 같았던 비율 ${pctOf(aHit, a.filter(r => r.soxNight !== null).length)} ← 낮으면 15:30 게이트는 불가능`);

  // ⓑ 19:40 시점: 미장 프리장 흐름 + 국장 애프터장 청산
  const b = rows.filter(r => r.preSox !== null && r.ahExit !== null);
  console.log(`  ── ⓑ 19:40 재판정 → 국장 애프터장 청산 (프리장·애프터 둘 다 있는 ${b.length}일) ──`);
  if (b.length < 5) { console.log(`     표본 ${b.length}일 — 산출 불가`); return; }
  if (b.length < 25) console.log(`     ⚠표본 ${b.length}일 — 아래 수치는 참고용, 판정 불가 (SOXX 조기 프리장이 야후 30일 롤링이라 소급 불가)`);
  const preHit = b.filter(r => (r.preSox ?? 0) * (r.soxNight ?? 0) > 0).length;
  console.log(`     프리장 방향이 '그날 밤 미국 종가' 방향과 일치: ${pctOf(preHit, b.filter(r => r.soxNight !== null).length)}`);
  const preGapHit = b.filter(r => (r.preSox ?? 0) * r.gap > 0).length;
  console.log(`     프리장 방향이 '익일 국장 갭' 방향과 일치: ${pctOf(preGapHit, b.length)}`);
  console.log(`     기준(이 부분집합): 전부 시가 청산   합 ${s1(W(r => r.gap, b)).padStart(7)}%p`);
  console.log(`     전부 애프터 청산                  합 ${s1(W(r => r.ahExit ?? 0, b)).padStart(7)}%p`);
  for (const th of [0, 0.5, 1.0]) {
    const v = b.reduce((s, r) => s + ((r.preSox ?? 0) * r.dir < -th ? (r.ahExit ?? 0) : r.gap) * r.dir * r.w, 0);
    const n = b.filter(r => (r.preSox ?? 0) * r.dir < -th).length;
    console.log(`     프리장이 동의 반대 & ${th}% 초과면 애프터 청산 (${String(n).padStart(3)}일 발동) 합 ${s1(v).padStart(7)}%p`);
  }
}

async function main() {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 2 * 365 * 86400e3), interval: "1d" });
  const q = (r.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
  const soxDaily = new Map<string, number>(), soxClose = new Map<string, number>();
  for (let i = 0; i < q.length; i++) {
    const d = (q[i].date instanceof Date ? q[i].date : new Date(q[i].date)).toISOString().slice(0, 10);
    soxClose.set(d, q[i].close);
    if (i > 0) soxDaily.set(d, ((q[i].close - q[i - 1].close) / q[i - 1].close) * 100);
  }
  report("하이닉스", await build(collect("000660", d => `000660NXA-${d}.json`), true, soxDaily, soxClose));
  report("삼성전자", await build(collect("005930", d => `005930-ah-${d}.json`), false, soxDaily, soxClose));
}
main();
