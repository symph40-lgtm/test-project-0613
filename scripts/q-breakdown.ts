// 삼전·하닉 레짐 Q1~Q4 상세 분해 (사용자 요청 2026-07-26).
//   npx tsx scripts/q-breakdown.ts   (.predict-cache 무통신)
// Q별: 일수·당일 추세일 비율·평균|시→종| / F(08창)·본(09창) 레그 성적 / 일합산 통계(평균·최악일·전후반)

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { labelDay } from "../lib/predict/label";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const STOP = 1.5;

type St = "none" | "up" | "down";
type Trans = { to: St; px: number; idx: number };
function stream(bars: MinuteBar[], orN: number, offW: number, confirm: number, reversal: number, sbW: number): Trans[] {
  if (bars.length < orN + 1) return [];
  const or = bars.slice(0, orN);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const out: Trans[] = [];
  let st: St = "none", up = 0, dn = 0;
  for (let i = orN; i < bars.length; i++) {
    const b = bars[i];
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - sbW) dn = Math.max(dn, confirm, reversal);
    }
    if (st === "none") {
      if (up >= confirm) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
      else if (dn >= confirm) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    } else if (st === "up" && dn >= reversal) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    else if (st === "down" && up >= reversal) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
  }
  return out;
}
function legsOf(bars: MinuteBar[], ts: Trans[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    const endIdx = k + 1 < ts.length ? ts[k + 1].idx : bars.length - 1;
    const dirUp = t.to === "up";
    let pnl: number | null = null;
    for (let j = t.idx + 1; j <= endIdx; j++) {
      const adv = dirUp ? ((bars[j].low - t.px) / t.px) * 100 : ((t.px - bars[j].high) / t.px) * 100;
      if (adv <= -STOP) { pnl = -STOP; break; }
    }
    out.push(pnl ?? ((bars[endIdx].close - t.px) / t.px) * 100 * (dirUp ? 1 : -1));
  }
  return out;
}

async function run(code: string, name: string, sb: number): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 364)).filter((b) => b.date < today);
  const dates = daily.slice(-224).map((b) => b.date).filter((d) => (readCache(`${code}-${d}.json`)?.length ?? 0) >= 240);
  type D = { q: 1 | 2 | 3 | 4; f: number[]; b: number[]; roc: number; trend: boolean; half: 0 | 1; date: string };
  const days: D[] = [];
  for (const d of dates) {
    const i = daily.findIndex((b) => b.date === d);
    if (i < 90) continue;
    const r10 = avgRange(daily.slice(Math.max(0, i - 120), i), 10);
    if (r10 === null) continue;
    const hv = isHighVolDay(daily.slice(0, i));
    const prevTrend = labelDay(daily[i - 1]).label !== "none";
    const q = (hv ? (prevTrend ? 3 : 4) : prevTrend ? 1 : 2) as 1 | 2 | 3 | 4;
    const reg = readCache(`${code}-${d}.json`)!;
    const pre = readCache(`${code}NX-${d}.json`) ?? [];
    const cont = [...pre, ...reg];
    const l = labelDay(daily[i]);
    days.push({
      q,
      f: legsOf(cont, stream(cont, 15, 0.05 * r10, 4, 3, sb * r10)),
      b: legsOf(reg, stream(reg, 15, 0.15 * r10, 8, 3, sb * r10)),
      roc: Math.abs(l.rOC), trend: l.label !== "none",
      half: dates.indexOf(d) < dates.length / 2 ? 0 : 1, date: d,
    });
  }
  const QN = { 1: "저변동·전일추세", 2: "저변동·전일무추세", 3: "고변동·전일추세", 4: "고변동·전일무추세" } as const;
  console.log(`\n════════ ${name} — ${days.length}일 ════════`);
  for (const q of [1, 2, 3, 4] as const) {
    const a = days.filter((d) => d.q === q);
    const f = a.flatMap((d) => d.f), b = a.flatMap((d) => d.b);
    const daySums = a.map((d) => [...d.f, ...d.b].reduce((s, x) => s + x, 0));
    const worst = a.length ? Math.min(...daySums) : 0;
    const worstDate = a[daySums.indexOf(worst)]?.date ?? "-";
    const cum = daySums.reduce((s, x) => s + x, 0);
    const h = [0, 1].map((hh) => a.filter((d) => d.half === hh).flatMap((d) => [...d.f, ...d.b]).reduce((s, x) => s + x, 0).toFixed(1));
    const win = (x: number[]) => (x.length ? Math.round((100 * x.filter((v) => v > 0).length) / x.length) : 0);
    const sum = (x: number[]) => x.reduce((s, v) => s + v, 0);
    const st = (x: number[]) => x.filter((v) => v === -STOP).length;
    console.log(`\n■ Q${q} ${QN[q]} — ${a.length}일 (당일 추세일 ${Math.round((100 * a.filter((d) => d.trend).length) / a.length)}%·평균|시→종| ${(a.reduce((s, d) => s + d.roc, 0) / a.length).toFixed(2)}%)`);
    console.log(`  F(조기): ${f.length}레그 누적 ${sum(f) >= 0 ? "+" : ""}${sum(f).toFixed(1)}%p·승률 ${win(f)}%·스탑컷 ${st(f)}`);
    console.log(`  본(확정): ${b.length}레그 누적 ${sum(b) >= 0 ? "+" : ""}${sum(b).toFixed(1)}%p·승률 ${win(b)}%·스탑컷 ${st(b)}`);
    console.log(`  합계 ${cum >= 0 ? "+" : ""}${cum.toFixed(1)}%p (전/후반 ${h.join("/")}) · 일평균 ${(cum / a.length).toFixed(3)}%p · 흑자일 ${Math.round((100 * daySums.filter((x) => x > 0).length) / a.length)}% · 최악일 ${worst.toFixed(2)}%p (${worstDate})`);
  }
}

async function main() {
  await run("005930", "삼전", 0.075);
  await run("000660", "하닉", 0.1);
}
main().catch((e) => { console.error(e); process.exit(1); });
