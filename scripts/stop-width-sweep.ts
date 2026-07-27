// 스탑 폭 재실측 (사용자 문제 제기 2026-07-28 — 7/27 삼전 인버스가 본주 +2% 역행(ETF -4%)에
// 컷: "최근 이런 역행이 빈번한가? 스탑을 늘려야 하나?"):
//   ① 피셔 확인 후 레그별 최대 역행폭(MAE) 분포 — 전체 vs 최근 30·60일 (고변동기 빈도 변화)
//   ② 스탑 폭 스윕: 본주 -1.5%(현행 ETF-3) / -2 / -2.5 / -3 / 무스탑 — 누적 손익·컷 수,
//      전/후반·최근 60일. 스트림 = 라이브 채택값 그대로 (C반전3·sb 종목별·고변동일 트레일 신규 문턱).
//   npx tsx scripts/stop-width-sweep.ts [--days 224]   (.predict-cache — 무통신)

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type St = "up" | "down";
type Trans = { time: string; to: St; px: number };
function stream(bars: MinuteBar[], offW: number, confirm: number, reversal: number, sbW: number, trailW: number, trailN: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const out: Trans[] = [];
  let state: "none" | St = "none", up = 0, dn = 0, trailRun = 0, extreme = 0;
  for (const b of bars.slice(15)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - sbW) dn = Math.max(dn, confirm, reversal);
    }
    if (state === "none") {
      if (up >= confirm) { state = "up"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "up", px: b.close }); }
      else if (dn >= confirm) { state = "down"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "down", px: b.close }); }
      continue;
    }
    if (state === "up") {
      extreme = Math.max(extreme, b.close);
      trailRun = trailW > 0 && b.close < extreme - trailW ? trailRun + 1 : 0;
      if (dn >= reversal || (trailW > 0 && trailRun >= trailN)) { state = "down"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "down", px: b.close }); }
    } else {
      extreme = Math.min(extreme, b.close);
      trailRun = trailW > 0 && b.close > extreme + trailW ? trailRun + 1 : 0;
      if (up >= reversal || (trailW > 0 && trailRun >= trailN)) { state = "up"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "up", px: b.close }); }
    }
  }
  return out;
}

async function run(code: string, name: string, sb: number, trailR: number, trailN: number): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 200)).filter((b) => b.date < today);
  type Day = { date: string; r10: number; vol10: number; reg: MinuteBar[]; close: number; hv: boolean };
  const seq: Day[] = [];
  const all = daily.slice(-(DAYS + 70));
  for (const bar of all) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    const prevClose = daily[idx - 1]?.close;
    if (r10 === null || !prevClose) continue;
    seq.push({ date: bar.date, r10, vol10: (r10 / prevClose) * 100, reg: readCache(`${code}-${bar.date}.json`) ?? [], close: bar.close, hv: false });
  }
  for (let i = 60; i < seq.length; i++) {
    const prior = seq.slice(Math.max(0, i - 60), i).map((x) => x.vol10).sort((a, b) => a - b);
    if (prior.length >= 40) seq[i].hv = seq[i].vol10 >= prior[Math.floor((2 * prior.length) / 3)];
  }
  const days = seq.slice(60).filter((d) => d.reg.length >= 240);

  // 레그 목록 (MAE·구간 손익 계산용)
  type Leg = { date: string; entry: number; dir: St; mae: number; endPx: number; bars: MinuteBar[]; startT: number; endT: number };
  const legs: Leg[] = [];
  for (const d of days) {
    const tr = d.hv
      ? stream(d.reg, 0.15 * d.r10, 8, 3, sb * d.r10, trailR * d.r10, trailN)
      : stream(d.reg, 0.15 * d.r10, 8, 3, sb * d.r10, 0, 0);
    for (let i = 0; i < tr.length; i++) {
      const startT = tMin(tr[i].time);
      const endT = i + 1 < tr.length ? tMin(tr[i + 1].time) : Infinity;
      let mae = 0;
      for (const b of d.reg) {
        const tm = tMin(b.time);
        if (tm <= startT) continue;
        if (tm >= endT) break;
        const adverse = tr[i].to === "up" ? (tr[i].px - b.low) / tr[i].px : (b.high - tr[i].px) / tr[i].px;
        mae = Math.max(mae, adverse * 100);
      }
      legs.push({ date: d.date, entry: tr[i].px, dir: tr[i].to, mae, endPx: i + 1 < tr.length ? tr[i + 1].px : d.close, bars: d.reg, startT, endT });
    }
  }

  // ① MAE 분포 — 전체 / 최근 60일 / 최근 30일
  const recentDates = days.map((d) => d.date);
  const cut60 = recentDates[Math.max(0, recentDates.length - 60)];
  const cut42 = recentDates[Math.max(0, recentDates.length - 42)]; // 최근 2개월 (사용자 지정 — 레버리지 ETF 출시 후 변동 확대 가설)
  const cut30 = recentDates[Math.max(0, recentDates.length - 30)];
  const maeStat = (sel: Leg[], label: string) => {
    if (!sel.length) return;
    const ge = (x: number) => Math.round((100 * sel.filter((l) => l.mae >= x).length) / sel.length);
    console.log(`  ${label}: 레그 ${sel.length} — 역행 ≥1.5% ${ge(1.5)}% · ≥2% ${ge(2)}% · ≥2.5% ${ge(2.5)}% · ≥3% ${ge(3)}%`);
  };
  console.log(`\n════ ${name} — ${days.length}일 · 레그 ${legs.length} (라이브 스트림 재현: sb ${sb}·트레일 ${trailR}×${trailN}) ════`);
  console.log(`① 확인 후 최대 역행폭(MAE, 본주 %) — "얼마나 자주 흔드는가"`);
  maeStat(legs, "전체       ");
  maeStat(legs.filter((l) => l.date >= cut60), "최근 60일  ");
  maeStat(legs.filter((l) => l.date >= cut42), "최근 2개월 ");
  maeStat(legs.filter((l) => l.date >= cut30), "최근 30일  ");

  // ② 스탑 폭 스윕
  console.log(`② 스탑 폭 스윕 (레그별 손익 합, 본주 % — 컷 후 다음 전이까지 관망·전이마다 재진입)`);
  console.log(`   스탑(본주/ETF) | 전체 손익(컷 수) | 전반 / 후반 | 최근 60일 | 최근 2개월(컷)`);
  const half = days[Math.floor(days.length / 2)]?.date ?? "";
  for (const stop of [1.5, 2.0, 2.5, 3.0, 99]) {
    let tot = 0, cuts = 0;
    let front = 0, back = 0, rec = 0, rec42 = 0, cuts42 = 0;
    for (const l of legs) {
      let pnl: number | null = null;
      for (const b of l.bars) {
        const tm = tMin(b.time);
        if (tm <= l.startT) continue;
        if (tm >= l.endT) break;
        if (l.dir === "up" && b.low <= l.entry * (1 - stop / 100)) { pnl = -stop; break; }
        if (l.dir === "down" && b.high >= l.entry * (1 + stop / 100)) { pnl = -stop; break; }
      }
      const isCut = pnl !== null;
      if (pnl === null) pnl = ((l.endPx - l.entry) / l.entry) * 100 * (l.dir === "up" ? 1 : -1);
      else cuts++;
      tot += pnl;
      if (l.date < half) front += pnl; else back += pnl;
      if (l.date >= cut60) rec += pnl;
      if (l.date >= cut42) { rec42 += pnl; if (isCut) cuts42++; }
    }
    const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
    console.log(`   ${stop === 99 ? "무스탑     " : `-${stop.toFixed(1)}%/-${(stop * 2).toFixed(0)}%   `} | ${s(tot)}%p (${cuts}컷) | ${s(front)} / ${s(back)} | ${s(rec)}%p | ${s(rec42)}%p (${cuts42}컷)`);
  }
}

(async () => {
  await run("005930", "삼전", 0.075, 0.3, 3);
  await run("000660", "하닉", 0.1, 0.35, 5);
  console.log(`\n주: 현행 = 본주 -1.5%(ETF -3%). 무스탑 = 다음 전이/종가까지 보유. 트레일 반전이 컷보다 먼저 오면 전이로 처리.`);
})();
