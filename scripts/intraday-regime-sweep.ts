// 장중 레짐(휩쏘·파도·추세) 실시간 판별 → 조건부 대응 실측 (사용자 지시 2026-07-29):
//   npx tsx scripts/intraday-regime-sweep.ts
// 질문: "장중 축적 데이터로 휩쏘·파도·추세를 종합 판단해 판정 툴을 정교화할 수 있나?"
// 설계: 10:00 스냅샷에서 세 지표를 찍고, '10시 이후' 스트림 성과가 지표 버킷별로 갈리는지 확인.
//   ①직진성 ER = |10시 종가-시가| ÷ Σ|분봉 등락| (1=한 방향 직진, 0=제자리 톱니)
//   ②파도 AMP = (현재까지 고저폭) ÷ 10일평균폭
//   ③왕복 CROSS = 종가가 시초레인지(09:00~15) 경계를 넘나든 횟수
// 대상: 삼전·하닉(현행 상수)·TOP10(확정 상수) — 각자 캐시 전 기간. 채택 기준: 방향이 3종목 일관.
// 결론이 서면 개입안(저직진성 → 신규 확인 비중 축소/확인봉 연장)을 2차 실측 후 제안.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const f1 = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);
const SNAP = tMin("10:00");

type St = "up" | "down";
type Trans = { t: number; to: St; px: number };
function stream(bars: MinuteBar[], r10: number, conf: number, sb: number, trailR: number, trailN: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + 0.15 * r10;
  const aDn = Math.min(...or.map((b) => b.low)) - 0.15 * r10;
  const sbW = sb * r10, trW = trailR * r10;
  const out: Trans[] = [];
  let state: "none" | St = "none", up = 0, dn = 0, run = 0, ext = 0;
  for (const b of bars.slice(15)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf, 3);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf, 3);
    }
    if (state === "none") {
      if (up >= conf) { state = "up"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "up", px: b.close }); }
      else if (dn >= conf) { state = "down"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "down", px: b.close }); }
      continue;
    }
    if (state === "up") {
      ext = Math.max(ext, b.close);
      run = trW > 0 && b.close < ext - trW ? run + 1 : 0;
      if (dn >= 3 || (trW > 0 && run >= trailN)) { state = "down"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "down", px: b.close }); }
    } else {
      ext = Math.min(ext, b.close);
      run = trW > 0 && b.close > ext + trW ? run + 1 : 0;
      if (up >= 3 || (trW > 0 && run >= trailN)) { state = "up"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "up", px: b.close }); }
    }
  }
  return out;
}

type DayR = { date: string; er: number; amp: number; cross: number; postPnl: number; postLegs: number; postWin: number; postStops: number };
async function analyze(code: string, name: string, conf: number, sb: number, trailR: number, trailN: number, trailHvOnly: boolean): Promise<DayR[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 500)).filter((b) => b.date < today);
  const out: DayR[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = readCache(`${code}-${daily[i].date}.json`);
    if (!reg || reg.length < 240) continue;
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (r10 === null) continue;
    const snapBars = reg.filter((b) => tMin(b.time) <= SNAP);
    if (snapBars.length < 30) continue;
    // ① 직진성 ER
    let travel = 0;
    for (let k = 1; k < snapBars.length; k++) travel += Math.abs(snapBars[k].close - snapBars[k - 1].close);
    const er = travel > 0 ? Math.abs(snapBars[snapBars.length - 1].close - snapBars[0].open) / travel : 0;
    // ② 파도
    const amp = (Math.max(...snapBars.map((b) => b.high)) - Math.min(...snapBars.map((b) => b.low))) / r10;
    // ③ 시초레인지 경계 왕복
    const orH = Math.max(...snapBars.slice(0, 15).map((b) => b.high));
    const orL = Math.min(...snapBars.slice(0, 15).map((b) => b.low));
    let cross = 0;
    let zone: -1 | 0 | 1 = 0;
    for (const b of snapBars.slice(15)) {
      const z: -1 | 0 | 1 = b.close > orH ? 1 : b.close < orL ? -1 : 0;
      if (z !== zone && z !== 0) cross++;
      if (z !== 0 || zone !== 0) zone = z;
    }
    // 10시 이후 성과 (현행/확정 스트림 — 레그 진입시각 > 10:00만)
    const useTrail = trailR > 0 && (!trailHvOnly || isHighVolDay(hist));
    const trs = stream(reg, r10, conf, sb, useTrail ? trailR : 0, trailN);
    let postPnl = 0, postLegs = 0, postWin = 0, postStops = 0;
    for (let k = 0; k < trs.length; k++) {
      if (trs[k].t <= SNAP) continue;
      const e = trs[k], endT = k + 1 < trs.length ? trs[k + 1].t : Infinity;
      let p: number | null = null;
      for (const b of reg) {
        const tm = tMin(b.time);
        if (tm <= e.t) continue;
        if (tm >= endT) break;
        if (e.to === "up" && b.low <= e.px * 0.985) { p = -1.5; postStops++; break; }
        if (e.to === "down" && b.high >= e.px * 1.015) { p = -1.5; postStops++; break; }
      }
      if (p === null) {
        const x = k + 1 < trs.length ? trs[k + 1].px : daily[i].close;
        p = ((x - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
      }
      postPnl += p; postLegs++; if (p > 0) postWin++;
    }
    out.push({ date: daily[i].date, er, amp, cross, postPnl, postLegs, postWin, postStops });
  }
  console.log(`\n════ ${name} — ${out.length}일 (10시 스냅샷 → 이후 성과) ════`);
  const tercile = (vals: number[], v: number): 0 | 1 | 2 => {
    const s = [...vals].sort((a, b) => a - b);
    return v < s[Math.floor(s.length / 3)] ? 0 : v < s[Math.floor((2 * s.length) / 3)] ? 1 : 2;
  };
  const dims: { key: "er" | "amp" | "cross"; name: string; labels: string[] }[] = [
    { key: "er", name: "①직진성 ER", labels: ["하위(톱니)", "중위", "상위(직진)"] },
    { key: "amp", name: "②파도 AMP", labels: ["하위(조용)", "중위", "상위(큰파도)"] },
    { key: "cross", name: "③왕복 CROSS", labels: ["적음", "중간", "많음"] },
  ];
  for (const d of dims) {
    const vals = out.map((x) => x[d.key]);
    const cells: DayR[][] = [[], [], []];
    for (const x of out) cells[tercile(vals, x[d.key])].push(x);
    const line = cells.map((c, bi) => {
      const pnl = c.reduce((s, x) => s + x.postPnl, 0);
      const legs = c.reduce((s, x) => s + x.postLegs, 0);
      const win = c.reduce((s, x) => s + x.postWin, 0);
      return `${d.labels[bi]}: ${c.length}일 ${f1(pnl)}%p·승률${legs ? Math.round((100 * win) / legs) : 0}%(${legs}레그)`;
    });
    console.log(`  ${d.name.padEnd(10)} ${line.join(" | ")}`);
  }
  // 조합: 직진성 중앙 분할 × 파도 중앙 분할 (2×2)
  const erMed = [...out.map((x) => x.er)].sort((a, b) => a - b)[Math.floor(out.length / 2)];
  const ampMed = [...out.map((x) => x.amp)].sort((a, b) => a - b)[Math.floor(out.length / 2)];
  const grid: Record<string, DayR[]> = { "직진+큰파도(추세장)": [], "직진+작은파도": [], "톱니+큰파도(위험휩쏘)": [], "톱니+작은파도(조용휩쏘)": [] };
  for (const x of out) {
    const k = x.er >= erMed ? (x.amp >= ampMed ? "직진+큰파도(추세장)" : "직진+작은파도") : x.amp >= ampMed ? "톱니+큰파도(위험휩쏘)" : "톱니+작은파도(조용휩쏘)";
    grid[k].push(x);
  }
  console.log(`  [2×2 조합]`);
  for (const [k, c] of Object.entries(grid)) {
    const pnl = c.reduce((s, x) => s + x.postPnl, 0);
    const legs = c.reduce((s, x) => s + x.postLegs, 0);
    const win = c.reduce((s, x) => s + x.postWin, 0);
    const stops = c.reduce((s, x) => s + x.postStops, 0);
    console.log(`    ${k.padEnd(16)} ${c.length}일 · 10시후 ${f1(pnl)}%p · 승률 ${legs ? Math.round((100 * win) / legs) : 0}% (${legs}레그·컷 ${stops})`);
  }
  return out;
}

(async () => {
  await analyze("005930", "삼전 (현행 상수)", 8, 0.075, 0.3, 3, true);
  await analyze("000660", "하닉 (현행 상수)", 8, 0.1, 0.35, 5, false);
  await analyze("396500", "TOP10 (확정 상수)", 5, 0.075, 0.5, 3, false);
  console.log(`\n주: '10시 이후 진입 레그'만 집계 — 10시 시점에 아는 정보로 이후를 가릴 수 있는지 검증.`);
  console.log(`   채택 기준: 3종목 방향 일관 버킷만 개입 후보 (비중 축소·확인봉 연장 등 2차 실측 대상).`);
})().catch((e) => { console.error(e); process.exit(1); });
