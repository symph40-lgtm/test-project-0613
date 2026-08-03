// SOXX 1년(274일) 추세판정 검증 — Alpaca 1분봉 (사용자 지시 2026-08-03 "검증 데이터 최근 1년"):
//   npx tsx scripts/us-soxx-1y-sweep.ts
// 데이터: .predict-cache/SOXXA-*.json (Alpaca IEX 1분봉, 야후 교차검증 통과 — 종가차 3~5bp).
// 관찰창 07:00~16:00 ET. F는 라이브와 동일하게 5분봉 집계 후 판정(or3·0.05·확인1봉·강돌파0.1·전환1봉).
// 비교: A 현행 F 레그 회계 / B 삼전식 v2(1분 6봉 누적 순전진 창 100% → F 반대 역진입 — 이번엔 삼전과
//   동일 분해능이라 공정한 이식 재검증) / C 하닉식(F 진입→창 반대 전환) / 대조군(매일 정규장 시가 롱+스탑).
// 스탑 SOXX -2.0%·프리장 판정 진입은 정규장 시가·종가(16:00) 청산. + 최근 39일 부분합(기존 실측과 정합 확인).

import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const STOP = 2.0;
const ET_OPEN = 570, ET_CLOSE = 960, ET_PRE = 420;
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
type Dir = 1 | -1;
type Raw = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
type Tr = { i: number; t: number; dir: Dir; px: number };

const bmid = (b: Raw) => (b.open + b.close) / 2;
function unitArrL(bars: Raw[], r10: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : r10 / 100;
    return Math.max(u * 0.5, 1e-9);
  });
}
// fromMin: 판정 허용 시각 (프리장 확인 금지 — IEX 결측 왜곡 제거·소스 독립, 국장 confirmFrom 원리)
function cumFirst(bars: Raw[], unit: number[], tanA: number, win: number, fromMin = 0): Tr | null {
  const w = win - 1;
  for (let t = w; t < bars.length; t++) {
    if (bars[t].etMin < fromMin) continue;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - w])) * dir >= tanA * unit[t - w] * w) return { i: t, t: bars[t].etMin, dir, px: bars[t].close };
    }
  }
  return null;
}
function cumStreamAll(bars: Raw[], unit: number[], tanA: number, win: number, fromMin = 0): Tr[] {
  const out: Tr[] = [];
  const w = win - 1;
  let st: 0 | Dir = 0;
  for (let t = w; t < bars.length; t++) {
    if (bars[t].etMin < fromMin) continue;
    let j: Dir | null = null;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - w])) * dir >= tanA * unit[t - w] * w) { j = dir; break; }
    }
    if (!j || j === st) continue;
    st = j;
    out.push({ i: t, t: bars[t].etMin, dir: j, px: bars[t].close });
  }
  return out;
}
function to5m(bars: Raw[]): Raw[] {
  const map = new Map<number, Raw>();
  for (const b of bars) {
    const k = Math.floor(b.etMin / 5) * 5;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...map.values()].sort((a, b) => a.etMin - b.etMin);
}

async function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => /^SOXXA-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (r.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));

  let n = 0, aPnl = 0, aLegs = 0, aCuts = 0, b6 = 0, cRes = 0, bias = 0;
  let bWorst = 0, bCutDays = 0, bEntryDays = 0, bWins = 0;
  let fFirstN = 0, both = 0, common = 0, opp = 0;
  const fFirsts: number[] = [], cwFirsts: number[] = [];
  let last39A = 0, last39B = 0, last39C = 0;
  const dates: string[] = [];

  for (const f of files) {
    const date = f.slice(6, 16);
    const raw = (JSON.parse(readFileSync(resolve(CACHE_DIR, f), "utf8")) as Raw[]).filter((b) => b.etMin >= ET_PRE && b.etMin < ET_CLOSE);
    const reg = raw.filter((b) => b.etMin >= ET_OPEN);
    if (reg.length < 250) continue; // 결손일 제외 (1분봉 기준)
    const hist = daily.filter((d) => d.date < date).slice(-60);
    if (hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    n++; dates.push(date);
    const close = reg[reg.length - 1].close;
    const regOpenI = raw.findIndex((b) => b.etMin >= ET_OPEN);

    const tranche = (j: Tr, size: number, forceI?: number, forcePx?: number): number => {
      let i0 = j.i, px = j.px;
      if (raw[j.i].etMin < ET_OPEN) { i0 = regOpenI; px = raw[regOpenI].open; }
      if (size <= 0 || (forceI !== undefined && forceI <= i0)) return 0;
      const s = STOP / 100;
      const lim = forceI ?? raw.length;
      for (let k = i0 + 1; k < lim; k++) {
        if (raw[k].etMin < ET_OPEN) continue;
        if (j.dir === 1 ? raw[k].low <= px * (1 - s) : raw[k].high >= px * (1 + s)) return -STOP * size;
      }
      const px2 = forceI !== undefined ? (forcePx ?? close) : close;
      return ((px2 - px) / px) * 100 * j.dir * size;
    };

    // A: 현행 F (5분봉 집계 → 라이브 cfg) — 레그 회계
    const b5 = to5m(raw);
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
    const t5 = new Map<string, number>();
    b5.forEach((b, k) => t5.set(b.time, k));
    // 5분 전이 → 1분 인덱스 매핑 (해당 5분봉 종료 시점의 1분봉)
    const fTrs: Tr[] = (fOut.transitions ?? []).flatMap((t) => {
      const k5 = t5.get(t.time);
      if (k5 === undefined) return [];
      const endMin = b5[k5].etMin + 4;
      let i1 = raw.findIndex((b) => b.etMin >= endMin);
      if (i1 < 0) i1 = raw.length - 1;
      return [{ i: i1, t: raw[i1].etMin, dir: (t.to === "up" ? 1 : -1) as Dir, px: t.px }];
    });
    let aDay = 0;
    for (let k = 0; k < fTrs.length; k++) {
      const nx = k + 1 < fTrs.length ? fTrs[k + 1] : null;
      const p = tranche(fTrs[k], 1, nx?.i, nx?.px);
      aDay += p; aLegs++;
      if (p === -STOP) aCuts++;
    }
    aPnl += aDay;
    if (fTrs.length) fFirsts.push(fTrs[0].t);

    // B: 삼전식 v2 (1분 6봉 창 정찰 + F 심판)
    const unit = unitArrL(raw, r10);
    const cw = cumFirst(raw, unit, 1.0, 6, ET_OPEN);
    if (cw) cwFirsts.push(cw.t);
    const fJ = fTrs.length ? fTrs[0] : null;
    if (fJ && cw) { both++; if (fJ.t < cw.t) fFirstN++; if (fJ.dir === cw.dir) common++; else opp++; }
    let bDay = 0;
    if (cw && !(fJ && fJ.t < cw.t)) {
      bEntryDays++;
      const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
      const t1 = tranche(cw, 1, fOpp?.i, fOpp?.px);
      bDay += t1;
      let t2 = 0;
      if (fOpp) { t2 = tranche(fOpp, 1); bDay += t2; }
      if (t1 === -STOP || t2 === -STOP) bCutDays++;
      if (bDay > 0) bWins++;
    }
    b6 += bDay;
    bWorst = Math.min(bWorst, bDay);

    // C: 하닉식 (F 진입 → 창 전이 반대 시 전환)
    let cDay = 0;
    if (fJ) {
      const cwTrs = cumStreamAll(raw, unit, 1.0, 6, ET_OPEN);
      const cwOpp = cwTrs.find((t) => t.t > fJ.t && t.dir !== fJ.dir) ?? null;
      cDay += tranche(fJ, 1, cwOpp?.i, cwOpp?.px);
      if (cwOpp) cDay += tranche(cwOpp, 1);
    } else if (cw) cDay += tranche(cw, 1);
    cRes += cDay;

    // 대조군: 정규장 시가 롱 + 스탑
    {
      const e = raw[regOpenI].open;
      let cut = false;
      for (let k = regOpenI + 1; k < raw.length; k++) { if (raw[k].low <= e * (1 - STOP / 100)) { cut = true; break; } }
      bias += cut ? -STOP : ((close - e) / e) * 100;
    }
    if (files.indexOf(f) >= files.length - 39) { last39A += aDay; last39B += bDay; last39C += cDay; }
  }

  console.log(`════ SOXX 1년 검증 — ${n}거래일 (${dates[0]} ~ ${dates[dates.length - 1]}) · Alpaca 1분봉·스탑 -${STOP}% ════`);
  console.log(`A 현행 미장 F(레그 회계):        ${s1(aPnl)}%p · 레그 ${aLegs}·컷 ${aCuts} · 첫확인중앙 ${fmtT(med(fFirsts))} ET`);
  console.log(`B 삼전식 v2(1분 6봉 창+F심판):   ${s1(b6)}%p · 진입 ${bEntryDays}일·승률 ${bEntryDays ? Math.round((100 * bWins) / bEntryDays) : 0}%·컷일 ${bCutDays}·최악일 ${bWorst.toFixed(2)}%`);
  console.log(`C 하닉식(F 진입→창 반대 전환):   ${s1(cRes)}%p`);
  console.log(`대조군(매일 정규장 시가 롱+스탑): ${s1(bias)}%p`);
  console.log(`\n[선후·케이스 — 1분 창6 vs F] 동시판정 ${both}일: F 선행 ${fFirstN}일(${both ? Math.round((100 * fFirstN) / both) : 0}%) · 창 첫판정중앙 ${fmtT(med(cwFirsts))} ET · 공통 ${common}·이견 ${opp}`);
  console.log(`[최근 39일 부분합] A ${s1(last39A)} · B ${s1(last39B)} · C ${s1(last39C)}  (기존 야후 5분봉 39일 실측: A +15.1·B -4.3·C +8.0 — 소스·분해능 차이 참고)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
