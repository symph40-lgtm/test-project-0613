// 1박 갭 관점 후속 검증 3건 (사용자 지시 2026-08-08):
//   npx tsx scripts/kr-overnight-gap-variants.ts
//   ① 삼전: 현행 자격 1박 vs '무조건 롱 1박' — 자격 규칙이 기저율보다 나은가 (리프트 0%p 실측 후속)
//   ② 하닉: 컷일 제외(현행) vs 포함 — 컷일 갭 일치 83%·평균 +4.56% 실측 후속
//   ③ 하닉: 비중 차등 축을 '갭 기준'으로 재도출 (현행 축은 당일 성과 기준으로 골랐음)
// 1박 레그만 비교한다(당일청산 base는 모든 변형에 공통이므로 차이가 없다).
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
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

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

// 하루치 상태 (변형들이 공유)
type S = {
  date: string; gap: number; dir: number; t1: number; gapBig: boolean; agree: boolean; cutDay: boolean;
  fLead: boolean; closeStr: number; dayRet: number; hiVol: boolean; wide: number; base: number;
};
function states(days: Day[], isHx: boolean): S[] {
  const cuts: boolean[] = []; const out: S[] = [];
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
    if (!next) continue;
    const first = trs.length ? trs[0] : null;
    const dir = first ? (first.to === "up" ? 1 : -1) : 0;
    const t1 = first ? hm(D.bars[first.i].time) : 9999;
    const fDir = isHx ? hxOvnFisherDir(D.bars, D.hist, D.date) : (ssJ ? ssJ.dir : 0);
    const rng = Math.max(1e-9, D.d.high - D.d.low);
    const pos = (D.d.close - D.d.low) / rng;
    out.push({
      date: D.date, gap: ((next.d.open - D.d.close) / D.d.close) * 100, dir, t1, gapBig,
      agree: dir !== 0 && fDir === dir, cutDay: base <= -2.4,
      fLead: !!ssJ && dir !== 0 && ssJ.t < t1,
      closeStr: dir === 1 ? pos : 1 - pos,
      dayRet: ((D.d.close - prevClose) / prevClose) * 100 * (dir || 1),
      hiVol: isHighVolDay(D.hist), wide: ((D.d.high - D.d.low) / D.d.close) / Math.max(1e-9, D.r10 / D.d.close),
      base,
    });
  }
  return out;
}

// 변형 = (그날 1박 방향, 비중). dir 0이면 미실행
function evalVar(label: string, S0: S[], f: (s: S) => { d: number; w: number }) {
  const legs = S0.map(s => { const { d, w } = f(s); return { s, p: d === 0 || w === 0 ? null : s.gap * d * w, raw: d === 0 ? null : s.gap * d }; }).filter(x => x.p !== null) as { s: S; p: number; raw: number }[];
  if (!legs.length) { console.log(`  ${label.padEnd(34)} 실행 0일`); return; }
  const tot = legs.reduce((a, x) => a + x.p, 0);
  const hit = legs.filter(x => x.raw > 0).length;
  const worst = Math.min(...legs.map(x => x.p));
  const jul = legs.filter(x => x.s.date >= "2026-07-01");
  console.log(`  ${label.padEnd(34)} ${String(legs.length).padStart(3)}일 · 합 ${s1(tot).padStart(7)}%p · 일당 ${s2(tot / legs.length)} · 갭적중 ${pctOf(hit, legs.length).padStart(4)} · 최악 ${worst.toFixed(2).padStart(6)} · 7월 ${s1(jul.reduce((a, x) => a + x.p, 0)).padStart(6)}/${jul.length}일`);
}

const hx = states(collect("000660"), true);
const ss = states(collect("005930"), false);

console.log(`\n════ ① 삼성전자 — 현행 자격 1박 vs 무조건 롱 1박 (${ss.length}일) ════`);
const ssQual = (s: S) => s.agree && !s.cutDay && !s.fLead;
evalVar("현행: 자격일·비중 100/50", ss, s => (ssQual(s) ? { d: s.dir, w: ovnWeight(s.t1, s.gapBig) } : { d: 0, w: 0 }));
evalVar("현행 자격일·비중 100% 균일", ss, s => (ssQual(s) ? { d: s.dir, w: 1 } : { d: 0, w: 0 }));
evalVar("무조건 롱 1박 (매일 100%)", ss, () => ({ d: 1, w: 1 }));
evalVar("무조건 롱 1박 (컷일 제외)", ss, s => (s.cutDay ? { d: 0, w: 0 } : { d: 1, w: 1 }));
evalVar("자격일에만 무조건 롱(방향 무시)", ss, s => (ssQual(s) ? { d: 1, w: 1 } : { d: 0, w: 0 }));
evalVar("판정일 전부 창1 방향(자격 무시)", ss, s => (s.dir !== 0 && !s.cutDay ? { d: s.dir, w: 1 } : { d: 0, w: 0 }));
evalVar("자격일 무조건 롱·비중 100/50", ss, s => (ssQual(s) ? { d: 1, w: ovnWeight(s.t1, s.gapBig) } : { d: 0, w: 0 }));

console.log(`\n════ ② 하이닉스 — 컷일 제외(현행) vs 포함 (${hx.length}일) ════`);
const hxQ = (s: S) => s.agree;
evalVar("현행: 자격일·컷일 제외·100/50", hx, s => (hxQ(s) && !s.cutDay ? { d: s.dir, w: ovnWeight(s.t1, s.gapBig) } : { d: 0, w: 0 }));
evalVar("컷일 포함 (동일 비중 규칙)", hx, s => (hxQ(s) ? { d: s.dir, w: ovnWeight(s.t1, s.gapBig) } : { d: 0, w: 0 }));
evalVar("컷일 포함·컷일은 50%로", hx, s => (hxQ(s) ? { d: s.dir, w: s.cutDay ? 0.5 : ovnWeight(s.t1, s.gapBig) } : { d: 0, w: 0 }));
evalVar("컷일 포함·전부 100%", hx, s => (hxQ(s) ? { d: s.dir, w: 1 } : { d: 0, w: 0 }));
evalVar("컷일만 1박 (참고)", hx, s => (hxQ(s) && s.cutDay ? { d: s.dir, w: 1 } : { d: 0, w: 0 }));
evalVar("(대조) 무조건 롱 1박", hx, () => ({ d: 1, w: 1 }));

console.log(`\n════ ③ 하이닉스 — 비중 축 갭 기준 재도출 (자격 ${hx.filter(s => hxQ(s) && !s.cutDay).length}일) ════`);
const q = hx.filter(s => hxQ(s) && !s.cutDay);
const axes: [string, (s: S) => boolean][] = [
  ["창1 확인 ≤10:00", s => s.t1 <= 600],
  ["비갭일(갭<4%)", s => !s.gapBig],
  ["현행 축(조기창&비갭)", s => s.t1 <= 600 && !s.gapBig],
  ["롱 방향", s => s.dir === 1],
  ["강한 마감(위치≥0.7)", s => s.closeStr >= 0.7],
  ["고변동일", s => s.hiVol],
  ["당일폭 > 평균", s => s.wide > 1],
  ["당일 등락 방향일치 ≥+1.5%", s => s.dayRet >= 1.5],
];
for (const [nm, ok] of axes) {
  const a = q.filter(ok), b = q.filter(s => !ok(s));
  const m = (g: S[]) => (g.length ? `${String(g.length).padStart(3)}일 갭적중 ${pctOf(g.filter(s => s.gap * s.dir > 0).length, g.length).padStart(4)} 평균갭 ${s2(g.reduce((x, s) => x + s.gap * s.dir, 0) / g.length).padStart(6)}%` : "  0일");
  console.log(`  ${nm.padEnd(26)} 예: ${m(a)}  |  아니오: ${m(b)}`);
}
console.log(`\n  ③ 배분 비교 (자격일 한정)`);
for (const [nm, full] of [
  ["전부 100%", () => true],
  ["현행: 조기창&비갭 100%", (s: S) => s.t1 <= 600 && !s.gapBig],
  ["비갭일만 100%", (s: S) => !s.gapBig],
  ["조기창만 100%", (s: S) => s.t1 <= 600],
  ["전부 50%", () => false],
] as [string, (s: S) => boolean][]) {
  evalVar(nm, q, s => ({ d: s.dir, w: full(s) ? 1 : 0.5 }));
}
