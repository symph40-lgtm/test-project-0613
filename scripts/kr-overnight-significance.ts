// 1박 갭 예측력의 통계적 유의성 (사용자 질문 2026-08-08 "삼전은 무의미해 보이는데 하닉은 괄목할 만한
// 유의미한 점이 있나"):
//   npx tsx scripts/kr-overnight-significance.ts
// 기술통계(적중률·평균)만으로는 '운'과 구분이 안 된다. 두 가지 귀무가설을 순열검정으로 깬다.
//   H0-A: 모델 방향은 무작위 부호와 다르지 않다   (방향 선별력이 있는가)
//   H0-B: 모델 방향은 '무조건 롱'과 다르지 않다   (기저 상승편향을 넘어서는가)
// 순열검정 = 실제 관측치가 귀무분포의 몇 퍼센타일인지 직접 세는 방식(분포 가정 불필요).
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder, hxOvnFisherDir } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

// 결정적 난수 (재현 가능 — Date.now/Math.random 미사용)
let seed = 20260808;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

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

function qualDays(days: Day[], isHx: boolean): { gap: number; dir: number }[] {
  const cuts: boolean[] = []; const out: { gap: number; dir: number }[] = [];
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
    if (!isHx && ssJ && ssJ.t < hm(D.bars[trs[0].i].time)) continue; // 삼전 F 선행 관망일
    out.push({ gap: ((next.d.open - D.d.close) / D.d.close) * 100, dir });
  }
  return out;
}

const ITER = 20000;
function permTest(rows: { gap: number; dir: number }[], name: string) {
  const n = rows.length;
  const obs = rows.reduce((a, r) => a + r.gap * r.dir, 0) / n;      // 모델 방향 평균 수익
  const longM = rows.reduce((a, r) => a + r.gap, 0) / n;            // 같은 날 무조건 롱 평균
  const nShort = rows.filter(r => r.dir === -1).length;
  // H0-A: 방향을 무작위 부호로 (숏 비율은 유지)
  let geA = 0;
  for (let k = 0; k < ITER; k++) {
    const idx = rows.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let s = 0;
    for (let i = 0; i < n; i++) s += rows[i].gap * (idx[i] < nShort ? -1 : 1);
    if (s / n >= obs) geA++;
  }
  // H0-B: 모델 방향 vs 무조건 롱의 차이 — 차이값 d_i = gap*dir - gap 의 부호를 무작위로 뒤집는 부트스트랩
  const diffs = rows.map(r => r.gap * r.dir - r.gap);
  const obsD = diffs.reduce((a, b) => a + b, 0) / n;
  let geB = 0;
  for (let k = 0; k < ITER; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[i] * (rnd() < 0.5 ? -1 : 1);
    if (s / n >= obsD) geB++;
  }
  const hit = rows.filter(r => r.gap * r.dir > 0).length;
  console.log(`\n════ ${name} — 자격일 ${n}일 ════`);
  console.log(`  모델 방향 평균 갭 ${s2(obs)}% · 같은 날 무조건 롱 ${s2(longM)}% · 차이 ${s2(obsD)}%p · 갭적중 ${Math.round((hit / n) * 100)}%`);
  console.log(`  H0-A(무작위 방향과 같다) : p = ${(geA / ITER).toFixed(4)} ${geA / ITER < 0.05 ? "→ 기각 (방향 선별력 있음)" : "→ 기각 못함 (운과 구분 안 됨)"}`);
  console.log(`  H0-B(무조건 롱과 같다)   : p = ${(geB / ITER).toFixed(4)} ${geB / ITER < 0.05 ? "→ 기각 (롱 편향을 넘어섬)" : "→ 기각 못함 (롱 대비 우위 없음)"}`);
  // 참고: 숏 자격일만 따로 (롱 편향과 무관한 순수 검증)
  const sh = rows.filter(r => r.dir === -1);
  if (sh.length >= 10) {
    const shHit = sh.filter(r => r.gap < 0).length;
    console.log(`  참고 — 숏 자격일 ${sh.length}일: 갭 하락 적중 ${Math.round((shHit / sh.length) * 100)}% · 평균 ${s2(sh.reduce((a, r) => a - r.gap, 0) / sh.length)}% (롱 편향이 도울 수 없는 구간)`);
  }
}

permTest(qualDays(collect("000660"), true), "하이닉스");
permTest(qualDays(collect("005930"), false), "삼성전자");
console.log(`\n  ※ 순열검정 ${ITER.toLocaleString()}회, 결정적 시드(재현 가능). p < 0.05를 기준으로 판단.`);
