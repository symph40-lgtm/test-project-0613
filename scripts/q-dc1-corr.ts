// Q(레짐 4분면) × 당일 DC1 상관 실측 (사용자 질문 2026-07-26).
//   npx tsx scripts/q-dc1-corr.ts   (.predict-cache 무통신)
// 당일 DC1 = 누적 5분봉 중 당일 방향(시가 대비 ±0.2% 대역)과 일치한 봉 비율 — 12:00·마감 두 시점.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { isHighVolDay } from "../lib/predict/indicators";
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
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

function dc1At(reg: MinuteBar[], uptoIdx: number): number | null {
  const ch: { o: number; c: number }[] = [];
  for (let i = 0; i + 5 <= uptoIdx + 1; i += 5) ch.push({ o: reg[i].open, c: reg[i + 4].close });
  if (ch.length < 3) return null;
  const dayOpen = reg[0].open;
  const last = ch[ch.length - 1].c;
  const dir = last > dayOpen * 1.002 ? 1 : last < dayOpen * 0.998 ? -1 : 0;
  if (dir === 0) return null;
  return ch.filter((x) => Math.sign(x.c - x.o) === dir).length / ch.length;
}

async function run(code: string, name: string): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 364)).filter((b) => b.date < today);
  type Row = { q: 1 | 2 | 3 | 4; prevTrend: boolean; dcNoon: number | null; dcEnd: number | null; todayTrend: boolean };
  const rows: Row[] = [];
  for (const bar of daily.slice(-224)) {
    const i = daily.findIndex((b) => b.date === bar.date);
    if (i < 90) continue;
    const reg = readCache(`${code}-${bar.date}.json`);
    if (!reg || reg.length < 240) continue;
    const hv = isHighVolDay(daily.slice(0, i));
    const prevTrend = labelDay(daily[i - 1]).label !== "none";
    const q = (hv ? (prevTrend ? 3 : 4) : prevTrend ? 1 : 2) as 1 | 2 | 3 | 4;
    const noonIdx = reg.findIndex((b) => tMin(b.time) >= 12 * 60) - 1;
    rows.push({
      q, prevTrend,
      dcNoon: noonIdx >= 20 ? dc1At(reg, noonIdx) : null,
      dcEnd: dc1At(reg, reg.length - 1),
      todayTrend: labelDay(daily[i]).label !== "none",
    });
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.log(`\n════ ${name} — ${rows.length}일 ════`);
  for (const q of [1, 2, 3, 4] as const) {
    const a = rows.filter((r) => r.q === q);
    const dcE = a.map((r) => r.dcEnd).filter((x): x is number => x !== null);
    const dcN = a.map((r) => r.dcNoon).filter((x): x is number => x !== null);
    const hi = dcE.filter((x) => x >= 0.55).length;
    const tt = a.filter((r) => r.todayTrend).length;
    console.log(`  Q${q}: ${a.length}일 — 마감 DC1 중앙 ${med(dcE).toFixed(2)}·≥0.55 비율 ${dcE.length ? Math.round((100 * hi) / dcE.length) : 0}% · 정오 DC1 중앙 ${med(dcN).toFixed(2)} · 당일 추세일 ${Math.round((100 * tt) / a.length)}%`);
  }
  // 점이연 상관: 전일추세(0/1) vs 당일 마감 DC1
  const known = rows.filter((r) => r.dcEnd !== null);
  const x = known.map((r) => (r.prevTrend ? 1 : 0));
  const y = known.map((r) => r.dcEnd!);
  const mx = x.reduce((s: number, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < x.length; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  const r = cov / Math.sqrt(vx * vy);
  const a1 = known.filter((r2) => r2.prevTrend).map((r2) => r2.dcEnd!);
  const a0 = known.filter((r2) => !r2.prevTrend).map((r2) => r2.dcEnd!);
  console.log(`  전일추세 vs 당일 마감 DC1 — 상관 r = ${r.toFixed(3)} · 중앙 ${med(a1).toFixed(2)}(추세) vs ${med(a0).toFixed(2)}(무추세)`);
  const t1 = rows.filter((r2) => r2.prevTrend && r2.todayTrend).length, n1 = rows.filter((r2) => r2.prevTrend).length;
  const t0 = rows.filter((r2) => !r2.prevTrend && r2.todayTrend).length, n0 = rows.length - n1;
  console.log(`  당일 추세일 비율 — 전일추세 ${Math.round((100 * t1) / n1)}%(${n1}) vs 무추세 ${Math.round((100 * t0) / n0)}%(${n0})`);
}

async function main() {
  await run("005930", "삼전");
  await run("000660", "하닉");
}
main().catch((e) => { console.error(e); process.exit(1); });
