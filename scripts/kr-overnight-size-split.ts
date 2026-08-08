// 국장 1박 비중 차등(100% vs 50%) 축 탐색 (사용자 질문 2026-08-08 "100%로 할 날과 50%로 투자할 날을
// 좀더 구분할 수 없나"):
//   npx tsx scripts/kr-overnight-size-split.ts
// 자격은 확정본 C(창1 방향 == F 방향, 확인 시각 무관 / 무판정·이견 제외).
// 각 후보 축은 '15:30 종가 시점에 이미 아는 값'만 사용 — 간밤 미장 결과 등 미래 정보 금지.
// 판정 경로·파라미터는 kr-overnight-sweep.ts / kr-overnight-consent.ts와 동일.
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
type Row = {
  date: string; dir: number; ovn: number; base: number; qual: boolean;
  fLead: boolean;      // F 확인이 창1보다 이름
  t1: number;          // 창1 확인 시각(분)
  closeStr: number;    // 방향 기준 종가 위치 (0~1, 1 = 방향 쪽 끝에서 마감)
  dayRet: number;      // 방향 기준 당일 등락률%
  hiVol: boolean;      // isHighVolDay(직전 일봉 기준)
  wide: number;        // 당일 일중폭 / 최근 10일 평균폭
  gapBig: boolean;     // 당일 시가 갭 |4%| 이상
};

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

function build(days: Day[], isHx: boolean): Row[] {
  const cuts: boolean[] = []; const rows: Row[] = [];
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
    const dir = first ? (first.to === "up" ? 1 : -1) : 0;
    // 자격 C: 창1 방향 == F 방향 (무판정·이견 제외) · 컷일·다음날 없음 제외
    const qual = !!first && !!next && base > -2.4 && !!fJ && fJ.dir === dir;
    if (!qual) { rows.push({ date: D.date, dir, base, qual: false, ovn: 0, fLead: false, t1: -1, closeStr: 0, dayRet: 0, hiVol: false, wide: 0, gapBig }); continue; }
    const t1 = hm(D.bars[first!.i].time);
    const rng = Math.max(1e-9, D.d.high - D.d.low);
    const pos = (D.d.close - D.d.low) / rng;
    rows.push({
      date: D.date, dir, base, qual: true,
      ovn: ((next!.d.open - D.d.close) / D.d.close) * 100 * dir,
      fLead: fJ!.t < t1, t1,
      closeStr: dir === 1 ? pos : 1 - pos,
      dayRet: ((D.d.close - prevClose) / prevClose) * 100 * dir,
      hiVol: isHighVolDay(D.hist),
      wide: ((D.d.high - D.d.low) / D.d.close) / Math.max(1e-9, D.r10 / D.d.close),
      gapBig,
    });
  }
  return rows;
}

function split(name: string, rows: Row[], label: string, f: (r: Row) => boolean) {
  const parts: [string, Row[]][] = [["예", rows.filter(f)], ["아니오", rows.filter(r => !f(r))]];
  const out = parts.map(([k, g]) => {
    const s = g.reduce((a, r) => a + r.ovn, 0);
    const jul = g.filter(r => r.date >= "2026-07-01");
    const win = g.filter(r => r.ovn > 0).length;
    return `${k} ${String(g.length).padStart(3)}일 일당 ${s2(s / Math.max(1, g.length))} (합 ${s1(s)}·승률 ${g.length ? Math.round(win / g.length * 100) : 0}%·최악 ${(g.length ? Math.min(...g.map(r => r.ovn)) : 0).toFixed(2)}·7월 ${s1(jul.reduce((a, r) => a + r.ovn, 0))}/${jul.length}일)`;
  });
  console.log(`  ${label.padEnd(30)} ${out[0]}\n  ${" ".repeat(30)} ${out[1]}`);
}

function report(name: string, rows: Row[]) {
  const s = rows.reduce((a, r) => a + r.ovn, 0);
  console.log(`\n════ ${name} — 자격 C ${rows.length}일 · 1박 합 ${s1(s)}%p (일당 ${s2(s / rows.length)}) ════`);
  split(name, rows, "① F선행(창1이 늦은 날)", r => r.fLead);
  split(name, rows, "② 롱(레버리지) 방향", r => r.dir === 1);
  split(name, rows, "③ 당일 모델 성과 ≥ 0", r => r.base >= 0);
  split(name, rows, "④ 방향쪽 강한 마감(위치≥0.7)", r => r.closeStr >= 0.7);
  split(name, rows, "⑤ 당일 등락 방향일치 ≥ +1.5%", r => r.dayRet >= 1.5);
  split(name, rows, "⑥ 고변동일(hiVol)", r => r.hiVol);
  split(name, rows, "⑦ 당일폭 > 최근10일 평균", r => r.wide > 1);
  split(name, rows, "⑧ 창1 확인 ≤ 10:00", r => r.t1 <= 600);
  split(name, rows, "⑨ 갭 4%+ 로 시작한 날", r => r.gapBig);
}

// 배분 규칙 비교: w(r) = 그날 1박 비중(1 = 100%, 0.5 = 50%, 0 = 1박 안 함)
// all = 전 거래일(당일청산 base 포함) — 합계·최악은 base + 가중 1박으로 계산.
function alloc(all: Row[], label: string, w: (r: Row) => number) {
  const q = all.filter(r => r.qual);
  const day = (r: Row) => r.base + (r.qual ? r.ovn * w(r) : 0);
  const ovnOnly = q.reduce((a, r) => a + r.ovn * w(r), 0);
  const tot = all.reduce((a, r) => a + day(r), 0);
  const worst = Math.min(...all.map(day));
  const jul = all.filter(r => r.date >= "2026-07-01");
  const n1 = q.filter(r => w(r) === 1).length, n0 = q.filter(r => w(r) === 0).length;
  console.log(`  ${label.padEnd(30)}: 합계 ${s1(tot)}%p (1박 ${s1(ovnOnly)}) · 최악 ${worst.toFixed(2)} · 100%일 ${n1}·쉼 ${n0}/${q.length} · 7월 ${s1(jul.reduce((a, r) => a + day(r), 0))}%p`);
}

const hxAll = build(collect("000660"), true);
const ssAll = build(collect("005930"), false);
const hx = hxAll.filter(r => r.qual), ss = ssAll.filter(r => r.qual);
report("하이닉스", hx); report("삼성전자", ss);

for (const [nm, rows] of [["하이닉스", hxAll], ["삼성전자", ssAll]] as [string, Row[]][]) {
  console.log(`\n──── ${nm} 배분 규칙 (1박 레그만·가중 반영) ────`);
  const early = (r: Row) => r.t1 <= 600, noGap = (r: Row) => !r.gapBig;
  alloc(rows, "전부 100%", () => 1);
  alloc(rows, "전부 50%", () => 0.5);
  alloc(rows, "창1선행일만 100%", r => (!r.fLead ? 1 : 0.5));
  alloc(rows, "조기창1(≤10:00)만 100%", r => (early(r) ? 1 : 0.5));
  alloc(rows, "비갭일만 100%", r => (noGap(r) ? 1 : 0.5));
  alloc(rows, "★조기창1&비갭 100%·나머지 50%", r => (early(r) && noGap(r) ? 1 : 0.5));
  alloc(rows, "★★위 + 갭일은 쉼(0%)", r => (!noGap(r) ? 0 : early(r) ? 1 : 0.5));
  alloc(rows, "롱만 100%", r => (r.dir === 1 ? 1 : 0.5));
  alloc(rows, "강한마감(≥0.7)만 100%", r => (r.closeStr >= 0.7 ? 1 : 0.5));
}
