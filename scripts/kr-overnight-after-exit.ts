// 1박 청산 시점 비교 (사용자 지시 2026-08-08 "애프터 20:00 청산 vs 익일 시가 청산 — 애프터 종가가
// 정규장 종가 대비 +X% 이상이면 애프터에서 확정"):
//   npx tsx scripts/kr-overnight-after-exit.ts
// 자격·비중은 확정 사양(동의일 · 조기창&비갭 100%·나머지 50%) 그대로. 청산 경로만 바꿔 비교한다.
//   ① 익일 시가 청산 (현행 사양)  ② 항상 애프터 20:00 청산  ③ 애프터 진행 ≥X%면 애프터 확정, 아니면 1박
// 애프터 캐시: 하닉 000660NXA-*(NXT 애프터 15:30~20:00) · 삼전 005930-ah-*.
// ⚠NXT 애프터는 저유동 — 체결 가능성은 별도 문제(실측은 종가 프린트 기준).
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { candleJudgeStream, unitArr, simLadder, ovnWeight } from "../lib/predict/candleWindow";
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

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar; ahClose: number | null };
function collect(code: string, ahName: (d: string) => string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    // 애프터 마지막 완성봉 종가 (= 20:00 무렵). 15:30 이전 봉은 제외.
    const ah = (load(ahName(date)) ?? []).filter((b) => hm(b.time) >= hm("15:30"));
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d, ahClose: ah.length ? ah[ah.length - 1].close : null });
    daily.push(d);
  }
  return out;
}

type Row = { date: string; w: number; ovn: number; ah: number | null };

function build(days: Day[], isHx: boolean): Row[] {
  const cuts: boolean[] = []; const rows: Row[] = [];
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
    const first = trs.length ? trs[0] : null;
    if (!first || !next || base <= -2.4 || !ssJ) continue;
    const dir = first.to === "up" ? 1 : -1;
    if (ssJ.dir !== dir) continue;
    const t1 = hm(D.bars[first.i].time);
    if (!isHx && ssJ.t < t1) continue;
    rows.push({
      date: D.date, w: ovnWeight(t1, gapBig),
      ovn: ((next.d.open - D.d.close) / D.d.close) * 100 * dir,
      ah: D.ahClose !== null ? ((D.ahClose - D.d.close) / D.d.close) * 100 * dir : null,
    });
  }
  return rows;
}

function report(name: string, rows: Row[]) {
  const withAh = rows.filter(r => r.ah !== null);
  console.log(`\n════ ${name} — 자격 ${rows.length}일 (애프터 데이터 있는 날 ${withAh.length}일) ════`);
  const stat = (label: string, f: (r: Row) => number) => {
    const v = rows.map(f);
    const s = v.reduce((a, b) => a + b, 0);
    const jul = rows.filter(r => r.date >= "2026-07-01");
    console.log(`  ${label.padEnd(34)} 합 ${s1(s)}%p (일당 ${s2(s / rows.length)} · 최악 ${Math.min(...v).toFixed(2)}) · 7월 ${s1(jul.reduce((a, r) => a + f(r), 0))}/${jul.length}일`);
  };
  stat("① 익일 시가 청산 (현행 사양)", r => r.ovn * r.w);
  stat("② 항상 애프터 20:00 청산", r => (r.ah ?? r.ovn) * r.w);
  for (const X of [0, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0]) {
    const n = rows.filter(r => r.ah !== null && r.ah >= X).length;
    stat(`③ 애프터 진행 ≥${X.toFixed(2)}%면 애프터 확정 (${n}일)`, r => (r.ah !== null && r.ah >= X ? r.ah : r.ovn) * r.w);
  }
  // 애프터에서 번 것이 밤에 유지되는가 — 애프터 이익 구간별 '밤 추가분'
  console.log(`  ── 애프터 진행 구간별: 애프터 종가까지 vs 그 뒤 밤 추가분 (익일 시가 - 애프터 종가) ──`);
  const buckets: [string, (a: number) => boolean][] = [
    ["애프터 ≥ +1.0%", a => a >= 1.0], ["+0.3 ~ +1.0%", a => a >= 0.3 && a < 1.0],
    ["-0.3 ~ +0.3%", a => a > -0.3 && a < 0.3], ["≤ -0.3%", a => a <= -0.3],
  ];
  for (const [lb, f] of buckets) {
    const g = withAh.filter(r => f(r.ah!));
    if (!g.length) { console.log(`  ${lb.padEnd(16)} 0일`); continue; }
    const ah = g.reduce((a, r) => a + r.ah!, 0) / g.length;
    const night = g.reduce((a, r) => a + (r.ovn - r.ah!), 0) / g.length;
    const nightW = g.reduce((a, r) => a + (r.ovn - r.ah!) * r.w, 0); // 비중 반영 합 — 합계표와 같은 잣대
    console.log(`  ${lb.padEnd(16)} ${String(g.length).padStart(3)}일 · 애프터까지 평균 ${s2(ah)}% · 밤 추가분 평균 ${s2(night)}%(단순) · 비중반영 합 ${s1(nightW)}%p (양수면 밤까지 끌고 간 게 이득)`);
  }
}

report("하이닉스", build(collect("000660", (d) => `000660NXA-${d}.json`), true));
report("삼성전자", build(collect("005930", (d) => `005930-ah-${d}.json`), false));
