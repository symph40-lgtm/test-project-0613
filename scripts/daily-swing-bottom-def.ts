// 바닥권 '정의' 비교 (사용자 질문 2026-08-08 "바닥 판정을 상수로밖에 못 하나? 이평선으로는?"):
//   npx tsx scripts/daily-swing-bottom-def.ts
// 앞선 스크립트가 쓴 고정 상수(60일고점比 -12%·20일 -8%)는 임의값이라 종목·레짐에 안 맞는다.
// 이평선·변동성 정규화 기반 정의들과 같은 잣대로 비교한다.
// 평가 기준: ①표본(조건일·독립 국면 수) ②이후 20일 분포가 무조건부 기준선과 얼마나 다른가(리프트)
//   ③두 종목 일관성 ④최악값. 모든 정의는 '그날 종가까지의 정보'만 사용 — 미래 정보 없음.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { sma, atr14, type DailyBar } from "../lib/predict-daily/models";

const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

type Ctx = {
  bars: DailyBar[]; c: number[];
  ma20: (number | null)[]; ma60: (number | null)[]; ma120: (number | null)[]; ma150: (number | null)[];
  atrPct: (number | null)[];       // ATR14를 종가 % 로
  disZ: (number | null)[];         // MA20 이격도의 250일 z-점수
};

function ctx(bars: DailyBar[]): Ctx {
  const c = bars.map(b => b.close);
  const ma20 = sma(c, 20), ma60 = sma(c, 60), ma120 = sma(c, 120), ma150 = sma(c, 150);
  const atr = atr14(bars);
  const atrPct = atr.map((v, i) => (v === null ? null : (v / c[i]) * 100));
  const dis = c.map((x, i) => (ma20[i] === null ? null : ((x - ma20[i]!) / ma20[i]!) * 100));
  const disZ = dis.map((v, i) => {
    if (v === null || i < 250) return null;
    const w = dis.slice(i - 250, i).filter((x): x is number => x !== null);
    if (w.length < 100) return null;
    const mu = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mu) ** 2, 0) / w.length);
    return sd > 0 ? (v - mu) / sd : null;
  });
  return { bars, c, ma20, ma60, ma120, ma150, atrPct, disZ };
}

const fromHi = (c: number[], i: number, n: number) => ((c[i] - Math.max(...c.slice(Math.max(0, i - n), i + 1))) / Math.max(...c.slice(Math.max(0, i - n), i + 1))) * 100;
const rN = (c: number[], i: number, n: number) => ((c[i] - c[i - n]) / c[i - n]) * 100;
const slope = (a: (number | null)[], i: number, n = 5) => (a[i] === null || a[i - n] === null ? null : ((a[i]! - a[i - n]!) / a[i - n]!) * 100);

type Def = { id: string; label: string; ok: (x: Ctx, i: number) => boolean };
const DEFS: Def[] = [
  { id: "FIX", label: "고정상수 (60일고점比≤-12%·20일≤-8%)", ok: (x, i) => fromHi(x.c, i, 60) <= -12 && rN(x.c, i, 20) <= -8 },
  { id: "ATR", label: "변동성 정규화 (고점比≤-4×ATR%·20일≤-2.5×ATR%)", ok: (x, i) => x.atrPct[i] !== null && fromHi(x.c, i, 60) <= -4 * x.atrPct[i]! && rN(x.c, i, 20) <= -2.5 * x.atrPct[i]! },
  { id: "MA-REV", label: "이평 역배열 (종가<MA20<MA60·MA20 하락)", ok: (x, i) => x.ma20[i] !== null && x.ma60[i] !== null && x.c[i] < x.ma20[i]! && x.ma20[i]! < x.ma60[i]! && (slope(x.ma20, i) ?? 0) < 0 },
  { id: "MA-DIS", label: "MA20 이격도 과매도 (z ≤ -1.5)", ok: (x, i) => x.disZ[i] !== null && x.disZ[i]! <= -1.5 },
  { id: "MA150", label: "장기추세 이탈 (종가<MA150·MA150 하락)", ok: (x, i) => x.ma150[i] !== null && x.c[i] < x.ma150[i]! && (slope(x.ma150, i, 10) ?? 0) < 0 },
  { id: "COMBO", label: "역배열 + 이격도 과매도 (MA-REV & z≤-1.2)", ok: (x, i) => DEFS[2].ok(x, i) && x.disZ[i] !== null && x.disZ[i]! <= -1.2 },
  { id: "TURN", label: "역배열 뒤 첫 반전 (MA-REV 였다가 종가>MA20 회복)", ok: (x, i) => i > 0 && x.ma20[i] !== null && x.c[i] > x.ma20[i]! && DEFS[2].ok(x, i - 1) },
];

function report(name: string, bars: DailyBar[]) {
  const x = ctx(bars); const c = x.c;
  const F = 20; // 이후 20거래일
  const all: number[] = [];
  for (let i = 250; i < c.length - F; i++) all.push(((c[i + F] - c[i]) / c[i]) * 100);
  const baseUp = all.filter(v => v >= 8).length, baseDn = all.filter(v => v <= -5).length;
  console.log(`\n════ ${name} (${bars.length}일) ════`);
  console.log(`  기준선(무조건부 ${all.length}일): 반등 ${pct(baseUp, all.length)}% · 횡보 ${pct(all.length - baseUp - baseDn, all.length)}% · 추가하락 ${pct(baseDn, all.length)}% · 평균 ${s1(all.reduce((a, b) => a + b, 0) / all.length)}%`);
  console.log(`  ${"정의".padEnd(46)} 조건일 국면  반등  횡보  추가하락  평균    최악    반등리프트`);
  for (const d of DEFS) {
    const idx: number[] = [];
    for (let i = 250; i < c.length - F; i++) if (d.ok(x, i)) idx.push(i);
    if (idx.length < 10) { console.log(`  ${d.label.padEnd(46)} ${String(idx.length).padStart(4)} — 표본 부족`); continue; }
    const fwd = idx.map(i => ((c[i + F] - c[i]) / c[i]) * 100);
    const up = fwd.filter(v => v >= 8).length, dn = fwd.filter(v => v <= -5).length;
    let eps = 0, last = -999; for (const i of idx) { if (i - last >= 20) eps++; last = i; }
    const avg = fwd.reduce((a, b) => a + b, 0) / fwd.length;
    console.log(`  ${d.label.padEnd(46)} ${String(idx.length).padStart(4)} ${String(eps).padStart(4)} ${String(pct(up, fwd.length)).padStart(4)}% ${String(pct(fwd.length - up - dn, fwd.length)).padStart(4)}% ${String(pct(dn, fwd.length)).padStart(7)}% ${s1(avg).padStart(7)} ${Math.min(...fwd).toFixed(1).padStart(7)} ${s1(pct(up, fwd.length) - pct(baseUp, all.length)).padStart(8)}%p`);
  }
  // 현재 상태
  const i = c.length - 1;
  const on = DEFS.filter(d => { try { return d.ok(x, i); } catch { return false; } }).map(d => d.id);
  console.log(`  현재(${bars[i].date} ${c[i].toLocaleString()}): 충족 정의 [${on.join(", ") || "없음"}]`);
  console.log(`    MA20 ${x.ma20[i]?.toFixed(0)} · MA60 ${x.ma60[i]?.toFixed(0)} · MA150 ${x.ma150[i]?.toFixed(0)} · 이격도z ${x.disZ[i]?.toFixed(2)} · ATR ${x.atrPct[i]?.toFixed(2)}% · 60일고점比 ${fromHi(c, i, 60).toFixed(1)}%`);
}

async function main() {
  report("삼성전자", await fetchDailyPredict("005930", 2600));
  report("SK하이닉스", await fetchDailyPredict("000660", 2600));
}
main();
