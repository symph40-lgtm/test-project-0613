// 1박 = '다음날 갭 예측'인가 (사용자 지적 2026-08-08: "다음날 시초가 매도면 갭폭을 포함하니
// 다음날을 일부 예측하는 셈 아니냐"):
//   npx tsx scripts/kr-overnight-gap-predict.ts
// 1박 수익의 정의 자체가 (익일 시가 - 당일 종가)/당일 종가 = 오버나이트 갭이다. 그러면 자격 조건
// (창1 방향 == 피셔F 방향)이 '갭 방향'을 실제로 선별하는지, 아니면 그냥 갭 기저율을 따라가는지 잰다.
//   ①무조건부 기저율: 전체 날의 갭 상승 비율 ②자격일/이견일/무판정일별 방향 일치율과 리프트
//   ③비중(100%/50%) 구분이 갭 적중과 상관 있는지 ④갭 크기 분포
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder, ovnWeight, hxOvnFisherDir } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

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

type Row = { date: string; kind: "자격(동의)" | "이견" | "무판정" | "판정없음" | "컷일"; dir: number; gap: number; w: number };

function build(days: Day[], isHx: boolean): { rows: Row[]; allGaps: number[] } {
  const cuts: boolean[] = []; const rows: Row[] = []; const allGaps: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const D = days[i], next = days[i + 1];
    if (!next) continue;
    const gap = ((next.d.open - D.d.close) / D.d.close) * 100;
    allGaps.push(gap);
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const ssF = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const ssIdx = ssF.length ? D.bars.findIndex(b => b.time === ssF[0].time) : -1;
    const ssJ = ssF.length && ssIdx >= 0 ? { i: ssIdx, t: hm(ssF[0].time), dir: (ssF[0].to === "up" ? 1 : -1) as 1 | -1 } : null;
    const base = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs, defense, isHighVolDay(D.hist)).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, ssJ ? { ...ssJ, px: ssF.length ? ssF[0].px : 0 } : null, C.newModel.ssV2.win).pnl;
    cuts.push(base <= -2.4);
    const first = trs.length ? trs[0] : null;
    if (!first) { rows.push({ date: D.date, kind: "판정없음", dir: 0, gap, w: 0 }); continue; }
    const dir = first.to === "up" ? 1 : -1;
    const t1 = hm(D.bars[first.i].time);
    const fDir = isHx ? hxOvnFisherDir(D.bars, D.hist, D.date) : (ssJ ? ssJ.dir : 0);
    const kind: Row["kind"] = base <= -2.4 ? "컷일" : fDir === 0 ? "무판정" : fDir === dir ? "자격(동의)" : "이견";
    rows.push({ date: D.date, kind, dir, gap, w: ovnWeight(t1, gapBig) });
  }
  return { rows, allGaps };
}

function report(name: string, days: Day[], isHx: boolean) {
  const { rows, allGaps } = build(days, isHx);
  const upBase = allGaps.filter(g => g > 0).length;
  console.log(`\n════ ${name} — ${allGaps.length}일 ════`);
  console.log(`  ① 무조건부 갭 기저율: 상승 갭 ${pctOf(upBase, allGaps.length)} (${upBase}/${allGaps.length}) · 평균 ${s2(allGaps.reduce((a, b) => a + b, 0) / allGaps.length)}% · 중앙 ${s2(med(allGaps))}% · |갭| 중앙 ${med(allGaps.map(Math.abs)).toFixed(2)}%`);
  console.log(`  ② 유형별 '진입 방향 == 갭 방향' 일치율 (= 모델의 갭 예측력)`);
  for (const k of ["자격(동의)", "이견", "무판정", "컷일"] as Row["kind"][]) {
    const g = rows.filter(r => r.kind === k && r.dir !== 0);
    if (!g.length) { console.log(`     ${k.padEnd(10)} 0일`); continue; }
    const hit = g.filter(r => r.gap * r.dir > 0).length;
    const avg = g.reduce((a, r) => a + r.gap * r.dir, 0) / g.length;
    // 그 유형의 방향 구성에 맞춘 기저율 (롱 비율만큼 상승갭 기저, 숏 비율만큼 하락갭 기저)
    const longs = g.filter(r => r.dir === 1).length;
    const baseHit = (longs * upBase + (g.length - longs) * (allGaps.length - upBase)) / allGaps.length;
    console.log(`     ${k.padEnd(10)} ${String(g.length).padStart(3)}일 · 일치 ${pctOf(hit, g.length).padStart(4)} · 방향기준 평균갭 ${s2(avg).padStart(6)}% · 기저 대비 리프트 ${(((hit - baseHit) / g.length) * 100).toFixed(0).padStart(3)}%p`);
  }
  const q = rows.filter(r => r.kind === "자격(동의)");
  console.log(`  ③ 비중별 (자격일 ${q.length}일)`);
  for (const w of [1, 0.5]) {
    const g = q.filter(r => r.w === w);
    if (!g.length) continue;
    const hit = g.filter(r => r.gap * r.dir > 0).length;
    console.log(`     비중 ${w * 100}%: ${String(g.length).padStart(3)}일 · 일치 ${pctOf(hit, g.length)} · 방향기준 평균갭 ${s2(g.reduce((a, r) => a + r.gap * r.dir, 0) / g.length)}%`);
  }
}

report("하이닉스", collect("000660"), true);
report("삼성전자", collect("005930"), false);
console.log(`\n  ※ '리프트' = 그 유형의 롱/숏 구성에 맞춘 무조건부 갭 기저율 대비 초과 적중. 0이면 모델이 갭에 대해 아무 정보도 없다는 뜻.`);
