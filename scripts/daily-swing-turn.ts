// 단기 전환(빠른 꼭지 탈출·바닥 포착) 탐지기 + 중장기 투표 조합 채점. 스펙 5-6 후속 (사용자 지시 2026-07-22).
//   npx tsx scripts/daily-swing-turn.ts
// ①최근 5~7월 실제 변곡점 감사: 각 탐지기가 언제 전환 신호를 냈나 (5/14·6/2·6/19 꼭지, 5/20·6/11 상승)
// ②10.5년 지그재그 10%(중간 산골) 채점: 꼭지→탈출 손실 / 바닥→진입 지연 / 전환 빈도(헛신호)
// ③중장기: 와인스타인·골든크로스·엘더조류 투표(2/3) — 지그재그 20% 기준 채점

import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";
import { MODELS, sma, ema, isoWeekKey, supertrendUp, type Stance } from "./daily-swing-models";

const WARMUP = 272;

function atrN(bars: PredictDailyBar[], period: number): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let prev: number | null = null, sum = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (prev === null) { sum += tr; if (i === period) { prev = sum / period; out[i] = prev; } }
    else { prev = (prev * (period - 1) + tr) / period; out[i] = prev; }
  }
  return out;
}

function supertrendVar(bars: PredictDailyBar[], period: number, mult: number): boolean[] {
  const n = bars.length, atr = atrN(bars, period);
  const out: boolean[] = new Array(n).fill(true);
  let fu = NaN, fl = NaN, up = true;
  for (let i = period + 1; i < n; i++) {
    const mid = (bars[i].high + bars[i].low) / 2;
    const bu = mid + mult * atr[i]!, bl = mid - mult * atr[i]!;
    fu = isNaN(fu) || bu < fu || bars[i - 1].close > fu ? bu : fu;
    fl = isNaN(fl) || bl > fl || bars[i - 1].close < fl ? bl : fl;
    if (up && bars[i].close < fl) up = false;
    else if (!up && bars[i].close > fu) up = true;
    out[i] = up;
  }
  return out;
}

// 파라볼릭 SAR (0.02, 0.2)
function psarUp(bars: PredictDailyBar[]): boolean[] {
  const n = bars.length;
  const out: boolean[] = new Array(n).fill(true);
  let up = true, sar = bars[0].low, ep = bars[0].high, af = 0.02;
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      if (bars[i].low < sar) { up = false; sar = ep; ep = bars[i].low; af = 0.02; }
      else if (bars[i].high > ep) { ep = bars[i].high; af = Math.min(0.2, af + 0.02); }
    } else {
      if (bars[i].high > sar) { up = true; sar = ep; ep = bars[i].high; af = 0.02; }
      else if (bars[i].low < ep) { ep = bars[i].low; af = Math.min(0.2, af + 0.02); }
    }
    out[i] = up;
  }
  return out;
}

// 샹들리에 엑시트 (22, 3×ATR22) — 방향 상태
function chandelierUp(bars: PredictDailyBar[]): boolean[] {
  const n = bars.length, atr = atrN(bars, 22);
  const out: boolean[] = new Array(n).fill(true);
  let up = true;
  for (let i = 23; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 21; j <= i; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
    if (up && bars[i].close < hh - 3 * atr[i]!) up = false;
    else if (!up && bars[i].close > ll + 3 * atr[i]!) up = true;
    out[i] = up;
  }
  return out;
}

function zigzag(bars: PredictDailyBar[], th: number): { idx: number; type: "peak" | "valley" }[] {
  const c = bars.map((b) => b.close);
  const piv: { idx: number; type: "peak" | "valley" }[] = [];
  let dir = 0, hiIdx = 0, loIdx = 0;
  for (let i = 1; i < c.length; i++) {
    if (c[i] > c[hiIdx]) hiIdx = i;
    if (c[i] < c[loIdx]) loIdx = i;
    if (dir >= 0 && c[i] <= c[hiIdx] * (1 - th)) { piv.push({ idx: hiIdx, type: "peak" }); dir = -1; loIdx = i; }
    else if (dir <= 0 && c[i] >= c[loIdx] * (1 + th)) { piv.push({ idx: loIdx, type: "valley" }); dir = 1; hiIdx = i; }
  }
  return piv;
}

async function main() {
  for (const [code, name] of [["005930", "삼성전자"], ["000660", "SK하이닉스"]] as const) {
    const bars = await fetchDailyPredict(code, 2600);
    const n = bars.length;
    const closes = bars.map((b) => b.close);
    const st = new Map<string, Stance[]>(MODELS.map((m) => [m.id, m.run(bars)]));
    const S = (id: string, i: number) => st.get(id)![i];

    // 단기 후보
    const e5 = ema(closes, 5), e20 = ema(closes, 20);
    const st103 = supertrendUp(bars), st72 = supertrendVar(bars, 7, 2), ps = psarUp(bars), ch = chandelierUp(bars);
    const shortDets: { label: string; up: (i: number) => boolean }[] = [
      { label: "수퍼트렌드(10,3)[현행 브레이크]", up: (i) => st103[i] },
      { label: "수퍼트렌드(7,2) 고속", up: (i) => st72[i] },
      { label: "파라볼릭 SAR", up: (i) => ps[i] },
      { label: "EMA5×EMA20 크로스", up: (i) => e5[i] !== null && e20[i] !== null && e5[i]! > e20[i]! },
      { label: "샹들리에(22,3ATR)", up: (i) => ch[i] },
      { label: "돈치안10 채널", up: (() => { let up = true; const arr: boolean[] = new Array(n).fill(true); for (let i = 11; i < n; i++) { let hh = -Infinity, ll = Infinity; for (let j = i - 10; j < i; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); } if (up && closes[i] < ll) up = false; else if (!up && closes[i] > hh) up = true; arr[i] = up; } return (i: number) => arr[i]; })() },
    ];
    // 중장기: 와인스타인·골든크로스·엘더조류 투표
    const ma50 = sma(closes, 50), ma200 = sma(closes, 200);
    const weekKeys = bars.map((b) => isoWeekKey(b.date));
    const wkKey: string[] = [], wkClose: number[] = [];
    for (let i = 0; i < n; i++) {
      if (wkKey.length && wkKey[wkKey.length - 1] === weekKeys[i]) wkClose[wkClose.length - 1] = closes[i];
      else { wkKey.push(weekKeys[i]); wkClose.push(closes[i]); }
    }
    const wkEma = ema(wkClose, 13);
    const wkIdx = new Map(wkKey.map((k, j) => [k, j]));
    const midVote = (i: number): number => {
      let v = 0;
      v += S("weinstein", i) === "long" ? 1 : S("weinstein", i) === "short" ? -1 : 0;
      if (ma50[i] !== null && ma200[i] !== null) v += ma50[i]! > ma200[i]! ? 1 : -1;
      const w = wkIdx.get(weekKeys[i])!;
      if (w >= 2 && wkEma[w - 1] !== null && wkEma[w - 2] !== null) v += wkEma[w - 1]! > wkEma[w - 2]! ? 1 : -1;
      return v;
    };
    const midDets: { label: string; up: (i: number) => boolean }[] = [
      { label: "중장기 투표(와인·크로스·조류 2/3)", up: (i) => midVote(i) >= 1 },
      { label: "미너비니(현행 판정자)", up: (i) => S("minervini", i) === "long" },
    ];

    const pc = (x: number) => `${(100 * x).toFixed(1)}%`;

    // ① 최근 변곡점 감사 (최근 60일 지그재그 8%로 자동 추출)
    const recentPiv = zigzag(bars, 0.08).filter((p) => p.idx >= n - 60);
    console.log(`\n■ ${name} — ① 최근 변곡점 감사 (지그재그 8%):`);
    for (const p of recentPiv) {
      const kind = p.type === "peak" ? "꼭지" : "바닥";
      console.log(`   ${bars[p.idx].date} ${kind} ${closes[p.idx].toLocaleString()}:`);
      for (const det of [...shortDets, ...midDets]) {
        let out = "신호 없음(현재까지)";
        for (let i = p.idx + 1; i < n; i++) {
          const flipped = p.type === "peak" ? !det.up(i) : det.up(i);
          if (flipped) { out = `${bars[i].date} (${p.idx === i ? "당일" : `${i - p.idx}일 후`}, ${pc(closes[i] / closes[p.idx] - 1)})`; break; }
        }
        console.log(`      ${det.label.padEnd(28)} ${out}`);
      }
    }

    // ② 단기 채점 (지그재그 10%, 10.5년)
    for (const [nm, th, dets] of [["② 단기(지그재그 10%)", 0.1, shortDets], ["③ 중장기(지그재그 20%)", 0.2, midDets]] as const) {
      const piv = zigzag(bars, th).filter((p) => p.idx >= WARMUP && p.idx < n - 5);
      const peaks = piv.filter((p) => p.type === "peak"), valleys = piv.filter((p) => p.type === "valley");
      console.log(`   ${nm} — 꼭지 ${peaks.length}·바닥 ${valleys.length}:`);
      console.log(`      탐지기                          꼭지→탈출 평균(최악)   바닥→진입 평균   전환/년`);
      for (const det of dets) {
        let exS = 0, exW = 0, exN = 0, enS = 0, enN = 0, flips = 0;
        for (const p of peaks) for (let i = p.idx + 1; i < n; i++) if (!det.up(i)) { const l = closes[i] / closes[p.idx] - 1; exS += l; exW = Math.min(exW, l); exN++; break; }
        for (const v of valleys) for (let i = v.idx + 1; i < n; i++) if (det.up(i)) { enS += closes[i] / closes[v.idx] - 1; enN++; break; }
        for (let i = WARMUP + 1; i < n; i++) if (det.up(i) !== det.up(i - 1)) flips++;
        const years = (n - WARMUP) / 248;
        console.log(`      ${det.label.padEnd(28)} ${exN ? `${pc(exS / exN)} (${pc(exW)})` : "—"}`.padEnd(52) + ` ${enN ? pc(enS / enN) : "—"}`.padStart(8) + `   ${(flips / years).toFixed(1)}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
