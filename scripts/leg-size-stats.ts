// "진짜 레그" 분석 (사용자 정의 2026-07-31: 저점~고점 간격 ≥8%는 되어야 레그):
//   npx tsx scripts/leg-size-stats.ts
// 하닉 227일(프리+정규 연속창) — 일중 최대 방향 스윙(저점→고점 상승 / 고점→저점 하락)의 분포와,
// 그런 큰 스윙 날에 창판정(라이브 모듈·원창6)·피셔F가 방향을 맞췄는지·진입 후 스윙 끝까지 얼마가 남았는지.
// 본주 % 기준 — 레버리지 2x ETF로는 ×2 (본주 4% ≈ ETF 8%).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { candleJudgeStream, unitArr } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type Swing = { dir: 1 | -1; pct: number; startI: number; endI: number; startPx: number; endPx: number };
// 일중 최대 방향 스윙: 상승 = (이후 고가 - 이전 최저 저가) 최대, 하락 = 대칭
function maxSwing(bars: MinuteBar[]): Swing {
  let minLow = Infinity, minI = 0, up: Swing = { dir: 1, pct: -1, startI: 0, endI: 0, startPx: 0, endPx: 0 };
  let maxHigh = -Infinity, maxI = 0, dn: Swing = { dir: -1, pct: -1, startI: 0, endI: 0, startPx: 0, endPx: 0 };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.low < minLow) { minLow = b.low; minI = i; }
    const u = ((b.high - minLow) / minLow) * 100;
    if (u > up.pct) up = { dir: 1, pct: u, startI: minI, endI: i, startPx: minLow, endPx: b.high };
    if (b.high > maxHigh) { maxHigh = b.high; maxI = i; }
    const d = ((maxHigh - b.low) / maxHigh) * 100;
    if (d > dn.pct) dn = { dir: -1, pct: d, startI: maxI, endI: i, startPx: maxHigh, endPx: b.low };
  }
  return up.pct >= dn.pct ? up : dn;
}

// 피셔F 첫 판정 (parity와 동일 상수)
function fisherFirst(bars: MinuteBar[], r10: number): { i: number; dir: 1 | -1; px: number } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = tMin("10:30");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = tMin(b.time) < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (up >= 4) return { i, dir: 1, px: b.close };
    if (dn >= 4) return { i, dir: -1, px: b.close };
  }
  return null;
}

// 피셔F 전체 전이 스트림 (판정→전환 반복, rev 3봉 — 라이브 상수)
function fisherStream(bars: MinuteBar[], r10: number): { i: number; dir: 1 | -1; px: number }[] {
  if (bars.length < 16) return [];
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  const out: { i: number; dir: 1 | -1; px: number }[] = [];
  let st: 0 | 1 | -1 = 0, up = 0, dn = 0;
  const emUntil = tMin("10:30");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = tMin(b.time) < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (st !== 1 && up >= (st === 0 ? 4 : 3)) { st = 1; out.push({ i, dir: 1, px: b.close }); }
    else if (st !== -1 && dn >= (st === 0 ? 4 : 3)) { st = -1; out.push({ i, dir: -1, px: b.close }); }
  }
  return out;
}

// 레그 구간 내 방향성 스윙(%): 상승 = 구간 내 (이전 최저 저가→이후 고가) 최대, 하락 대칭
function legSpan(bars: MinuteBar[], from: number, to: number, dir: 1 | -1): number {
  let best = 0, ext = dir === 1 ? Infinity : -Infinity;
  for (let i = from; i < to; i++) {
    const b = bars[i];
    if (dir === 1) {
      if (b.low < ext) ext = b.low;
      best = Math.max(best, ((b.high - ext) / ext) * 100);
    } else {
      if (b.high > ext) ext = b.high;
      best = Math.max(best, ((ext - b.low) / ext) * 100);
    }
  }
  return best;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  const swings: number[] = [];
  const bucket = (th: number) => ({ th, n: 0, cwCatch: 0, cwCap: [] as number[], fCatch: 0, fCap: [] as number[] });
  const buckets = [bucket(4), bucket(6), bucket(8)];
  let daysN = 0;
  // 모델 자체 레그 기준 (사용자 정의 7/31 2차): 각 모델이 판정한 레그 구간 내 스윙 ≥8% = 찐모수
  const cwSpans: number[] = [], fSpans: number[] = [];
  // 판정 겹침 (사용자 질문 7/31 3차): 하루 첫 판정 기준 공통/단독/무판정
  let bothSame = 0, bothDiff = 0, cwOnly = 0, fOnly = 0, neither = 0;
  let diffCwRight = 0, diffFRight = 0; // 방향 이견일에 일중 최대 스윙 방향과 일치한 쪽
  // 범주별 품질 (사용자 요청 7/31 4차): 큰 스윙 날을 공통/이견/창만/F만으로 나눠 각 모델 첫 판정 성적
  type Q = { pnl: number; cut: boolean; remain: number | null };
  type DayRec = { swPct: number; cat: "both" | "diff" | "cwOnly" | "fOnly"; cwQ: Q | null; fQ: Q | null };
  const dayRecs: DayRec[] = [];
  const qualOf = (bars: MinuteBar[], j: { i: number; dir: 1 | -1; px: number }, close: number, sw: Swing): Q => {
    const s = 2.5 / 100;
    let cut = false;
    for (let i = j.i + 1; i < bars.length; i++) {
      const b = bars[i];
      if (j.dir === 1 ? b.low <= j.px * (1 - s) : b.high >= j.px * (1 + s)) { cut = true; break; }
    }
    const pnl = cut ? -2.5 : ((close - j.px) / j.px) * 100 * j.dir;
    const remain = j.dir === sw.dir && j.i <= sw.endI ? ((sw.endPx - j.px) / j.px) * 100 * sw.dir : null;
    return { pnl, cut, remain };
  };
  const bigDay = { bothSame: 0, bothDiff: 0, cwOnly: 0, fOnly: 0, neither: 0 }; // 본주 스윙 ≥4% 날의 분포
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    daysN++;
    const bars = [...(pre ?? []), ...reg];
    const sw = maxSwing(bars);
    swings.push(sw.pct * sw.dir);
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const cw = trs.length ? { i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
    const fF = fisherFirst(bars, r10);
    for (let k = 0; k < trs.length; k++) {
      const endI = k + 1 < trs.length ? trs[k + 1].i : bars.length;
      cwSpans.push(legSpan(bars, trs[k].i, endI, trs[k].to === "up" ? 1 : -1));
    }
    const fTrs = fisherStream(bars, r10);
    for (let k = 0; k < fTrs.length; k++) {
      const endI = k + 1 < fTrs.length ? fTrs[k + 1].i : bars.length;
      fSpans.push(legSpan(bars, fTrs[k].i, endI, fTrs[k].dir));
    }
    const big = sw.pct >= 4;
    if (cw && fF) { if (cw.dir === fF.dir) { bothSame++; if (big) bigDay.bothSame++; } else { bothDiff++; if (big) bigDay.bothDiff++; if (cw.dir === sw.dir) diffCwRight++; else if (fF.dir === sw.dir) diffFRight++; } }
    else if (cw) { cwOnly++; if (big) bigDay.cwOnly++; }
    else if (fF) { fOnly++; if (big) bigDay.fOnly++; }
    else { neither++; if (big) bigDay.neither++; }
    if (cw || fF) {
      dayRecs.push({
        swPct: sw.pct,
        cat: cw && fF ? (cw.dir === fF.dir ? "both" : "diff") : cw ? "cwOnly" : "fOnly",
        cwQ: cw ? qualOf(bars, cw, daily[i].close, sw) : null,
        fQ: fF ? qualOf(bars, fF, daily[i].close, sw) : null,
      });
    }
    for (const bk of buckets) {
      if (sw.pct < bk.th) continue;
      bk.n++;
      // 포착 = 방향 일치 + 스윙 끝나기 전 판정. 캡처 = 진입가→스윙 극점까지 남은 폭(%)
      if (cw && cw.dir === sw.dir && cw.i <= sw.endI) {
        bk.cwCatch++;
        bk.cwCap.push(((sw.endPx - cw.px) / cw.px) * 100 * sw.dir);
      }
      if (fF && fF.dir === sw.dir && fF.i <= sw.endI) {
        bk.fCatch++;
        bk.fCap.push(((sw.endPx - fF.px) / fF.px) * 100 * sw.dir);
      }
    }
  }
  const abs = swings.map(Math.abs).sort((a, b) => a - b);
  const medSw = abs[Math.floor(abs.length / 2)];
  console.log(`${daysN}일 — 일중 최대 방향 스윙(본주): 중앙 ${medSw.toFixed(2)}% · ≥4% ${abs.filter((v) => v >= 4).length}일 · ≥5% ${abs.filter((v) => v >= 5).length}일 · ≥6% ${abs.filter((v) => v >= 6).length}일 · ≥8% ${abs.filter((v) => v >= 8).length}일`);
  const medOf = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  for (const bk of buckets) {
    console.log(`\n스윙 ≥${bk.th}% (ETF 2x ≈ ${bk.th * 2}%): ${bk.n}일`);
    console.log(`  창판정: 포착 ${bk.cwCatch}일(${bk.n ? Math.round((100 * bk.cwCatch) / bk.n) : 0}%) · 진입→극점 잔여 중앙 ${medOf(bk.cwCap).toFixed(2)}%`);
    console.log(`  피셔F : 포착 ${bk.fCatch}일(${bk.n ? Math.round((100 * bk.fCatch) / bk.n) : 0}%) · 진입→극점 잔여 중앙 ${medOf(bk.fCap).toFixed(2)}%`);
  }
  console.log("\n주: 포착 = 하루 첫 판정이 스윙과 동방향 + 스윙 종료 전. 잔여 = 판정가에서 스윙 극점까지 남은 폭(본주 %).");
  const legStat = (name: string, spans: number[]) => {
    const n = spans.length;
    const c = (th: number) => spans.filter((v) => v >= th).length;
    console.log(`${name}: 레그 ${n}건 — 구간 스윙 중앙 ${medOf(spans).toFixed(2)}% · ≥4% ${c(4)}건(${Math.round((100 * c(4)) / n)}%) · ≥5% ${c(5)}건(${Math.round((100 * c(5)) / n)}%) · ≥6% ${c(6)}건(${Math.round((100 * c(6)) / n)}%) · ≥8% ${c(8)}건(${Math.round((100 * c(8)) / n)}%)`);
  };
  console.log("\n[모델 자체 레그 기준 — 판정~다음 전환(또는 종가) 구간 내 방향성 스윙, 본주 %]");
  legStat("창판정", cwSpans);
  legStat("피셔F ", fSpans);
  console.log("\n[판정 겹침 — 하루 첫 판정 기준]");
  console.log(`둘 다·같은 방향 ${bothSame}일 · 둘 다·다른 방향 ${bothDiff}일 · 창판정만 ${cwOnly}일 · 피셔F만 ${fOnly}일 · 둘 다 무판정 ${neither}일 (합 ${bothSame + bothDiff + cwOnly + fOnly + neither}일)`);
  console.log(`큰 스윙(본주 ≥4%) ${buckets[0].n}일의 분포: 공통·같은 방향 ${bigDay.bothSame} · 다른 방향 ${bigDay.bothDiff} · 창만 ${bigDay.cwOnly} · 피셔F만 ${bigDay.fOnly} · 무판정 ${bigDay.neither}`);
  console.log(`방향 이견일 ${bothDiff}일 중 일중 최대 스윙과 일치: 창판정 ${diffCwRight}일 · 피셔F ${diffFRight}일`);
  // 범주별 품질 상세 (진입 = 각 모델 첫 판정, 스탑 -2.5% 또는 종가 보유)
  const fmtQ = (qs: Q[]): string => {
    if (!qs.length) return "0건";
    const avg = qs.reduce((a, q) => a + q.pnl, 0) / qs.length;
    const win = Math.round((100 * qs.filter((q) => q.pnl > 0).length) / qs.length);
    const cut = Math.round((100 * qs.filter((q) => q.cut).length) / qs.length);
    const rem = qs.map((q) => q.remain).filter((v): v is number => v !== null);
    const remS = rem.length ? `잔여중앙 ${medOf(rem).toFixed(2)}%(${rem.length}건)` : "잔여 —";
    const sum = qs.reduce((a, q) => a + q.pnl, 0);
    return `${qs.length}건 평균 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%·승률 ${win}%·컷률 ${cut}%·합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1)}%p·${remS}`;
  };
  const CATS = [
    { key: "both" as const, ko: "공통(같은 방향)" },
    { key: "diff" as const, ko: "이견(다른 방향)" },
    { key: "cwOnly" as const, ko: "창판정만" },
    { key: "fOnly" as const, ko: "피셔F만" },
  ];
  for (const th of [4, 5, 6]) {
    console.log(`\n[범주별 품질 — 본주 스윙 ≥${th}% 날, 진입=각 모델 첫 판정·스탑 -2.5%·종가 보유]`);
    for (const c of CATS) {
      const rows = dayRecs.filter((r) => r.swPct >= th && r.cat === c.key);
      if (!rows.length) { console.log(`${c.ko}: 0일`); continue; }
      console.log(`${c.ko}: ${rows.length}일`);
      const fQ = rows.map((r) => r.fQ).filter((q): q is Q => q !== null);
      const cQ = rows.map((r) => r.cwQ).filter((q): q is Q => q !== null);
      if (fQ.length) console.log(`  피셔F 진입: ${fmtQ(fQ)}`);
      if (cQ.length) console.log(`  창판정 진입: ${fmtQ(cQ)}`);
    }
  }
  console.log("주: 잔여 = 판정가→그날 최대 스윙 극점까지 남은 폭(스윙과 동방향 판정만 산출).");
}
main().catch((e) => { console.error(e); process.exit(1); });
