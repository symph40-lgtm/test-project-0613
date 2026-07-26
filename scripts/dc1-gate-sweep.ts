// 실험 A — DC1 지속성 게이트 × 피셔F 진입 (사용자 승인 2026-07-26).
//   npx tsx scripts/dc1-gate-sweep.ts   (.predict-cache 전용 — 무통신)
//
// 가설 (사용자): "DC1이 60% 임계를 못 넘기는 이탈은 스윕(휩쏘)일 확률이 높다" —
// F(0.05·4봉·강돌파·반전3, 08 연속창) 확인·전환 시점의 최근 30분 DC1(5분봉 6개 중 방향 일치
// 비율)로 진입을 걸렀을 때 레그 경제성이 개선되는가. 채택 기준: 두 종목·전후반 일관 분리.
// 레그: 전이봉 종가 진입 → 다음 전이(또는 마지막봉) 청산, 스탑 본주 -1.5% 관통.

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
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const STOP = 1.5;

type St = "none" | "up" | "down";
type Trans = { to: St; px: number; idx: number };
function stream(bars: MinuteBar[], orN: number, offW: number, confirm: number, reversal: number, strongW: number): Trans[] {
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
    if (strongW > 0) {
      if (b.close > aUp + strongW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - strongW) dn = Math.max(dn, confirm, reversal);
    }
    if (st === "none") {
      if (up >= confirm) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
      else if (dn >= confirm) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    } else if (st === "up" && dn >= reversal) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    else if (st === "down" && up >= reversal) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
  }
  return out;
}

// 최근 30분 DC1 — 확인봉 포함 직전 30개 1분봉을 5분 청크 6개로 묶어 방향 일치 비율 (엔진 정의 대응)
function dc1At(bars: MinuteBar[], idx: number, dir: St, winMin: number): number | null {
  const from = idx - winMin + 1;
  if (from < 0) return null;
  const w = bars.slice(from, idx + 1);
  const chunks: number[] = [];
  for (let i = 0; i + 5 <= w.length; i += 5) chunks.push(Math.sign(w[i + 4].close - w[i].open));
  if (chunks.length < winMin / 5) return null;
  const sign = dir === "up" ? 1 : -1;
  return chunks.filter((s) => s === sign).length / chunks.length;
}

async function run(code: string, name: string, sb: number): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 364)).filter((b) => b.date < today);
  type Leg = { pnl: number; dc30: number | null; dc60: number | null; half: 0 | 1 };
  const legs: Leg[] = [];
  let days = 0;
  const dates: string[] = [];
  for (const bar of daily.slice(-224)) {
    const reg = readCache(`${code}-${bar.date}.json`);
    if (!reg || reg.length < 240) continue;
    dates.push(bar.date);
  }
  for (const d of dates) {
    const idx = daily.findIndex((b) => b.date === d);
    if (idx < 30) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    if (r10 === null) continue;
    const reg = readCache(`${code}-${d}.json`)!;
    const pre = readCache(`${code}NX-${d}.json`) ?? [];
    const cont = [...pre, ...reg];
    const ts = stream(cont, 15, 0.05 * r10, 4, 3, sb * r10);
    if (!ts.length) { days++; continue; }
    days++;
    const half: 0 | 1 = dates.indexOf(d) < dates.length / 2 ? 0 : 1;
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k];
      const endIdx = k + 1 < ts.length ? ts[k + 1].idx : cont.length - 1;
      const dirUp = t.to === "up";
      let pnl: number | null = null;
      for (let i = t.idx + 1; i <= endIdx; i++) {
        const adv = dirUp ? ((cont[i].low - t.px) / t.px) * 100 : ((t.px - cont[i].high) / t.px) * 100;
        if (adv <= -STOP) { pnl = -STOP; break; }
      }
      if (pnl === null) pnl = ((cont[endIdx].close - t.px) / t.px) * 100 * (dirUp ? 1 : -1);
      legs.push({ pnl, dc30: dc1At(cont, t.idx, t.to, 30), dc60: dc1At(cont, t.idx, t.to, 60), half });
    }
  }
  console.log(`\n════ ${name} — ${days}일·레그 ${legs.length} (전체 누적 ${legs.reduce((s, l) => s + l.pnl, 0).toFixed(1)}%p) ════`);
  const stat = (a: Leg[]) => `${a.length}레그 · 누적 ${a.reduce((s, l) => s + l.pnl, 0).toFixed(1)}%p · 승률 ${a.length ? Math.round((100 * a.filter((l) => l.pnl > 0).length) / a.length) : 0}% · 평균 ${a.length ? (a.reduce((s, l) => s + l.pnl, 0) / a.length).toFixed(3) : "-"}%`;
  for (const [key, get] of [["DC1(30분)", (l: Leg) => l.dc30], ["DC1(60분)", (l: Leg) => l.dc60]] as const) {
    console.log(`── ${key} 게이트 —`);
    for (const th of [0.5, 0.55, 0.6, 0.67]) {
      const known = legs.filter((l) => get(l) !== null);
      const pass = known.filter((l) => get(l)! >= th);
      const fail = known.filter((l) => get(l)! < th);
      const ph = [0, 1].map((h) => pass.filter((l) => l.half === h).reduce((s, l) => s + l.pnl, 0).toFixed(1));
      const fh = [0, 1].map((h) => fail.filter((l) => l.half === h).reduce((s, l) => s + l.pnl, 0).toFixed(1));
      console.log(`  θ ${th}: 통과 ${stat(pass)} (전/후 ${ph.join("/")}) | 차단 ${stat(fail)} (전/후 ${fh.join("/")})`);
    }
    const known = legs.filter((l) => get(l) !== null);
    console.log(`  (DC1 미산출 ${legs.length - known.length}레그 — 창 미형성·프리장 초반)`);
  }
}

async function main() {
  await run("005930", "삼전 (sb 0.075)", 0.075);
  await run("000660", "하닉 (sb 0.1)", 0.1);
}
main().catch((e) => { console.error(e); process.exit(1); });
