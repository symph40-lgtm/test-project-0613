// 레짐별 비중 조절 정책 실측 (사용자 제안 2026-07-26 — "추세 높은 날 투자금↑·작은 날↓·없는 날 미진입").
//   npx tsx scripts/regime-sizing-sweep.ts   (.predict-cache 무통신)
//
// "추세가 높은 날"의 실행 가능한 정의 = 장전 레짐(4분면 — 개장 전 확정, 2.20 실측으로 피셔 성적
// 분리 확인). 비중안: 레짐 브리핑 결론 그대로 — Q1 100% / Q3 75%(분할) / Q2 50% / Q4 33%,
// 추가로 Q4 관망(0%) 변형. 피셔 레그(F 08창+본 09창, 스탑 -1.5%)에 가중 적용:
//   평가 = 누적 가중손익 · 자본효율(손익/평균노출) · 최악 레그·최악 날 — 균등 100% 대비.

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

async function run(code: string, name: string, sb: number): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 364)).filter((b) => b.date < today);
  const dates = daily.slice(-224).map((b) => b.date).filter((d) => (readCache(`${code}-${d}.json`)?.length ?? 0) >= 240);
  type DayLegs = { q: 1 | 2 | 3 | 4; pnls: number[] };
  const days: DayLegs[] = [];
  for (const d of dates) {
    const i = daily.findIndex((b) => b.date === d);
    if (i < 90) continue;
    const r10 = avgRange(daily.slice(Math.max(0, i - 120), i), 10);
    if (r10 === null) continue;
    const hv = isHighVolDay(daily.slice(0, i));
    const trend = labelDay(daily[i - 1]).label !== "none";
    const q = (hv ? (trend ? 3 : 4) : trend ? 1 : 2) as 1 | 2 | 3 | 4;
    const reg = readCache(`${code}-${d}.json`)!;
    const pre = readCache(`${code}NX-${d}.json`) ?? [];
    const cont = [...pre, ...reg];
    const pnls: number[] = [];
    for (const [bars, ts] of [
      [cont, stream(cont, 15, 0.05 * r10, 4, 3, sb * r10)],
      [reg, stream(reg, 15, 0.15 * r10, 8, 3, sb * r10)],
    ] as const) {
      for (let k = 0; k < ts.length; k++) {
        const t = ts[k];
        const endIdx = k + 1 < ts.length ? ts[k + 1].idx : bars.length - 1;
        const dirUp = t.to === "up";
        let pnl: number | null = null;
        for (let j = t.idx + 1; j <= endIdx; j++) {
          const adv = dirUp ? ((bars[j].low - t.px) / t.px) * 100 : ((t.px - bars[j].high) / t.px) * 100;
          if (adv <= -STOP) { pnl = -STOP; break; }
        }
        if (pnl === null) pnl = ((bars[endIdx].close - t.px) / t.px) * 100 * (dirUp ? 1 : -1);
        pnls.push(pnl);
      }
    }
    days.push({ q, pnls });
  }
  const POLICIES: { name: string; w: Record<1 | 2 | 3 | 4, number> }[] = [
    { name: "균등 100%      ", w: { 1: 1, 2: 1, 3: 1, 4: 1 } },
    { name: "레짐 가중(브리핑)", w: { 1: 1, 2: 0.5, 3: 0.75, 4: 1 / 3 } },
    { name: "레짐 가중+Q4 관망", w: { 1: 1, 2: 0.5, 3: 0.75, 4: 0 } },
    { name: "Q1만 진입       ", w: { 1: 1, 2: 0, 3: 0, 4: 0 } },
  ];
  console.log(`\n════ ${name} — ${days.length}일 ════`);
  for (const p of POLICIES) {
    let cum = 0, exposure = 0, worstDay = 0, worstLeg = 0, lossSum = 0, n = 0;
    const halves = [0, 0];
    days.forEach((d, di) => {
      const w = p.w[d.q];
      const dayPnl = d.pnls.reduce((s, x) => s + x * w, 0);
      cum += dayPnl;
      halves[di < days.length / 2 ? 0 : 1] += dayPnl;
      exposure += w * (d.pnls.length > 0 ? 1 : 0);
      worstDay = Math.min(worstDay, dayPnl);
      for (const x of d.pnls) {
        const wp = x * w;
        n += w > 0 ? 1 : 0;
        worstLeg = Math.min(worstLeg, wp);
        if (wp < 0) lossSum += wp;
      }
    });
    const eff = exposure > 0 ? cum / exposure : 0;
    console.log(`  ${p.name}: 누적 ${cum >= 0 ? "+" : ""}${cum.toFixed(1)}%p (전/후 ${halves[0].toFixed(1)}/${halves[1].toFixed(1)}) · 자본효율 ${eff.toFixed(3)}%/노출일 · 손실합 ${lossSum.toFixed(1)} · 최악일 ${worstDay.toFixed(2)} · 레그 ${n}`);
  }
}

async function main() {
  await run("005930", "삼전", 0.075);
  await run("000660", "하닉", 0.1);
}
main().catch((e) => { console.error(e); process.exit(1); });
