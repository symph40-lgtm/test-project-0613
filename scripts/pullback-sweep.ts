// 되돌림(추세 반납) 스윕 (사용자 지시 2026-07-28 밤 — "시가 후 추세가 반전돼 종가가 시가
// 근처로 회귀하면 헛수고. 되돌림을 빠르게 정확하게 판정할 방법?"):
//   npx tsx scripts/pullback-sweep.ts [--days 224]
// ① 되돌림일 정의·빈도: 정규장 편위(시가→극값) ≥ 0.8×r10 인데 |종가-시가| ≤ 0.35×편위 —
//    본피셔 확인일 기준 되돌림일 vs 추세일의 스트림 손익 대조 (문제 크기 실측).
// ② 트레일 반전 전일(全日) 확대: 현행(고변동일 한정, 하닉 0.35×5·삼전 0.3×3) vs 전일 적용 —
//    4분기 손익·왕복·최악일 (채택 기준: 양 종목·다수 분기 개선).
// ③ 되돌림 조기경보 청산 정책: 확인 후 진행폭 ≥0.5×r10에서 50% 반납 3봉 지속 시 청산했다면 —
//    레그별 '경보 청산 vs 실제 청산' 손익 델타를 되돌림일/추세일로 나눠 실측.
// 프레임 = hx-trail-soften-verify와 동일 (본피셔 0.15·8봉·C반전3·sb, 레그 -1.5% 스탑, 고변동일 66.7분위).

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
const STOP = 1.5;
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const f1 = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);

type St = "up" | "down";
type Trans = { time: string; to: St; px: number };
// hx-trail-soften-verify.ts의 stream과 동일
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

type Leg = { pnl: number; entry: number; dir: St; startT: number; endT: number; exitPx: number; stopped: boolean };
function legsOf(reg: MinuteBar[], tr: Trans[], close: number): Leg[] {
  const out: Leg[] = [];
  for (let i = 0; i < tr.length; i++) {
    const entry = tr[i].px, dir = tr[i].to;
    const startT = tMin(tr[i].time);
    const endT = i + 1 < tr.length ? tMin(tr[i + 1].time) : Infinity;
    let pnl: number | null = null, stopped = false, exitPx = i + 1 < tr.length ? tr[i + 1].px : close;
    for (const b of reg) {
      const tm = tMin(b.time);
      if (tm <= startT) continue;
      if (tm >= endT) break;
      if (dir === "up" && b.low <= entry * (1 - STOP / 100)) { pnl = -STOP; stopped = true; exitPx = entry * (1 - STOP / 100); break; }
      if (dir === "down" && b.high >= entry * (1 + STOP / 100)) { pnl = -STOP; stopped = true; exitPx = entry * (1 + STOP / 100); break; }
    }
    if (pnl === null) pnl = ((exitPx - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
    out.push({ pnl, entry, dir, startT, endT, exitPx, stopped });
  }
  return out;
}

// ③ 조기경보: 진행폭 ≥ progMin(0.5×r10)에서 반납 ≥ 50% 가 3봉 연속 → 그 봉 종가 청산 가정
function alertExit(reg: MinuteBar[], leg: Leg, r10: number): { firedT: number; exitPx: number } | null {
  const sgn = leg.dir === "up" ? 1 : -1;
  let extreme = leg.entry, run = 0;
  for (const b of reg) {
    const tm = tMin(b.time);
    if (tm <= leg.startT) continue;
    if (tm >= leg.endT) break;
    if (sgn * (b.close - extreme) > 0) extreme = b.close;
    const prog = sgn * (extreme - leg.entry);
    const giveBack = sgn * (extreme - b.close);
    run = prog >= 0.5 * r10 && giveBack >= 0.5 * prog ? run + 1 : 0;
    if (run >= 3) return { firedT: tm, exitPx: b.close };
  }
  return null;
}

async function analyze(code: string, name: string, sb: number, cur: { r: number; n: number }): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 200)).filter((b) => b.date < today);
  type D = { date: string; vol10: number; reg: MinuteBar[]; r10: number; close: number };
  const seq: D[] = [];
  for (const bar of daily.slice(-(DAYS + 70))) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    const prevClose = daily[idx - 1]?.close;
    if (r10 === null || !prevClose) continue;
    seq.push({ date: bar.date, vol10: (r10 / prevClose) * 100, reg: readCache(`${code}-${bar.date}.json`) ?? [], r10, close: bar.close });
  }

  // 평가일 + 고변동 여부 + 되돌림일 분류
  type E = { d: D; isHv: boolean; isPull: boolean; half: 0 | 1 };
  const evals: E[] = [];
  for (let i = 60; i < seq.length; i++) {
    const d = seq[i];
    if (d.reg.length < 240) continue;
    const prior = seq.slice(Math.max(0, i - 60), i).map((x) => x.vol10).sort((a, b) => a - b);
    if (prior.length < 40) continue;
    const isHv = d.vol10 >= prior[Math.floor((2 * prior.length) / 3)];
    const open = d.reg[0].open;
    const hi = Math.max(...d.reg.map((b) => b.high)), lo = Math.min(...d.reg.map((b) => b.low));
    const exc = Math.max(hi - open, open - lo);
    const isPull = exc >= 0.8 * d.r10 && Math.abs(d.close - open) <= 0.35 * exc;
    evals.push({ d, isHv, isPull, half: 0 });
  }
  evals.forEach((e, i) => { e.half = i < evals.length / 2 ? 0 : 1; });

  console.log(`\n════════ ${name} (${code}) — 평가 ${evals.length}일 ════════`);

  // ① 빈도·문제 크기 (현행 스트림 기준)
  const curTr = (e: E) => e.isHv && cur.r > 0
    ? stream(e.d.reg, 0.15 * e.d.r10, 8, 3, sb * e.d.r10, cur.r * e.d.r10, cur.n)
    : stream(e.d.reg, 0.15 * e.d.r10, 8, 3, sb * e.d.r10, 0, 0);
  let pullN = 0, pullPnl = 0, trendN = 0, trendPnl = 0, pullConf = 0;
  for (const e of evals) {
    const legs = legsOf(e.d.reg, curTr(e), e.d.close);
    const pnl = legs.reduce((s, l) => s + l.pnl, 0);
    if (e.isPull) { pullN++; pullPnl += pnl; if (legs.length) pullConf++; }
    else { trendN++; trendPnl += pnl; }
  }
  console.log(`① 되돌림일 ${pullN}일 (${Math.round((100 * pullN) / evals.length)}%) — 현행 스트림 손익 합 ${f1(pullPnl)}%p (판정 발생 ${pullConf}일)`);
  console.log(`   비되돌림일 ${trendN}일 — 손익 합 ${f1(trendPnl)}%p  → 되돌림일이 손익 훼손의 진원인지 확인`);

  // ② 트레일 전일 확대
  console.log(`② 트레일 적용 범위 스윕 (전/후반 손익 | 왕복≤15분 | 전환수 | 최악일)`);
  const variants: { tag: string; allDay: boolean; r: number; n: number }[] = [
    { tag: `현행 고변동만 ${cur.r}×${cur.n}`, allDay: false, r: cur.r, n: cur.n },
    { tag: `전일 ${cur.r}×${cur.n}`, allDay: true, r: cur.r, n: cur.n },
    ...[{ r: 0.5, n: 3 }, { r: 0.35, n: 5 }, { r: 0.5, n: 5 }]
      .filter((v) => !(v.r === cur.r && v.n === cur.n))
      .map((v) => ({ tag: `전일 ${v.r}×${v.n}`, allDay: true, r: v.r, n: v.n })),
  ];
  for (const v of variants) {
    const half = [0, 0];
    let whip = 0, flips = 0, worst = 0;
    let worstDate = "";
    for (const e of evals) {
      const useTrail = v.allDay || e.isHv;
      const tr = useTrail
        ? stream(e.d.reg, 0.15 * e.d.r10, 8, 3, sb * e.d.r10, v.r * e.d.r10, v.n)
        : stream(e.d.reg, 0.15 * e.d.r10, 8, 3, sb * e.d.r10, 0, 0);
      const legs = legsOf(e.d.reg, tr, e.d.close);
      const pnl = legs.reduce((s, l) => s + l.pnl, 0);
      half[e.half] += pnl;
      flips += Math.max(0, tr.length - 1);
      for (let i = 1; i < tr.length; i++) if (tMin(tr[i].time) - tMin(tr[i - 1].time) <= 15) whip++;
      if (pnl < worst) { worst = pnl; worstDate = e.d.date; }
    }
    console.log(`   ${v.tag.padEnd(20)} ${f1(half[0])} / ${f1(half[1])} (합 ${f1(half[0] + half[1])}) | 왕복 ${String(whip).padStart(3)} | 전환 ${String(flips).padStart(3)} | ${worst.toFixed(1)} (${worstDate})`);
  }

  // ③ 조기경보 청산 정책 (현행 스트림 레그 기준)
  let dPull = 0, dTrend = 0, firedPull = 0, firedTrend = 0, legPull = 0, legTrend = 0;
  const leads: number[] = [];
  for (const e of evals) {
    const legs = legsOf(e.d.reg, curTr(e), e.d.close);
    for (const leg of legs) {
      const a = alertExit(e.d.reg, leg, e.d.r10);
      const alertPnl = a ? ((a.exitPx - leg.entry) / leg.entry) * 100 * (leg.dir === "up" ? 1 : -1) : leg.pnl;
      const delta = alertPnl - leg.pnl; // 경보 청산이 실제 대비 얼마나 이득/손해였나
      if (e.isPull) { legPull++; if (a) { firedPull++; dPull += delta; if (leg.endT !== Infinity) leads.push(leg.endT - a.firedT); } }
      else { legTrend++; if (a) { firedTrend++; dTrend += delta; } }
    }
  }
  console.log(`③ 조기경보(진행≥0.5×r10·반납50%·3봉) 청산 시 델타:`);
  console.log(`   되돌림일: 레그 ${legPull}개 중 발화 ${firedPull} — 델타 합 ${f1(dPull)}%p (스트림 청산 대비 리드 중앙값 ${leads.length ? leads.sort((a, b) => a - b)[Math.floor(leads.length / 2)] : "—"}분)`);
  console.log(`   추세일:   레그 ${legTrend}개 중 발화 ${firedTrend} — 델타 합 ${f1(dTrend)}%p (음수 = 추세 조기이탈 비용)`);
  console.log(`   순효과 ${f1(dPull + dTrend)}%p — 양수여야 경보 청산 정책 후보`);
}

(async () => {
  await analyze("005930", "삼전", 0.075, { r: 0.3, n: 3 });
  await analyze("000660", "하닉", 0.1, { r: 0.35, n: 5 });
  console.log(`\n주: 되돌림일 = 편위≥0.8×r10 & |종가-시가|≤0.35×편위. 본주 %p·레그 -1.5% 스탑.`);
  console.log(`   채택 기준(공통): 양 종목 + 전/후반 모두 개선일 때만 정책 후보.`);
})();
