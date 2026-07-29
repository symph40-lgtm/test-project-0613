// 전일 확정 방향 대비 '반대' 아침 F 신호의 성적 실측 (사용자 문제 제기 2026-07-29 밤 —
// "인버스와 인버스 사이에 레버리지가 있었어. 두번째 레버리지는 없었던 것이 더 좋았을 듯"):
//   npx tsx scripts/counter-f-sweep.ts
// 질문: 전일 본피셔가 방향 확정한 다음날, 아침 08연속창 첫 F가 '반대 방향'으로 확인되면
// 그 첫 레그는 통계적으로 약한가? (약하면 경고 라벨/억제 근거, 아니면 기각 기록)
// 버킷: 전일 확정과 같은 방향 / 반대 방향 / 전일 무판정. 지표: 첫 F 레그 손익·승률·N·전/후반.

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
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const f1 = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);

type St = "up" | "down";
type Trans = { t: number; to: St; px: number };
function stream(bars: MinuteBar[], r10: number, off: number, conf: number, rev: number, sb: number, trailR: number, trailN: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + off * r10;
  const aDn = Math.min(...or.map((b) => b.low)) - off * r10;
  const sbW = sb * r10, trW = trailR * r10;
  const out: Trans[] = [];
  let st: "none" | St = "none", up = 0, dn = 0, run = 0, ext = 0;
  for (const b of bars.slice(15)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf, rev);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf, rev);
    }
    if (st === "none") {
      if (up >= conf) { st = "up"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "up", px: b.close }); }
      else if (dn >= conf) { st = "down"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "down", px: b.close }); }
      continue;
    }
    if (st === "up") {
      ext = Math.max(ext, b.close);
      run = trW > 0 && b.close < ext - trW ? run + 1 : 0;
      if (dn >= rev || (trW > 0 && run >= trailN)) { st = "down"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "down", px: b.close }); }
    } else {
      ext = Math.min(ext, b.close);
      run = trW > 0 && b.close > ext + trW ? run + 1 : 0;
      if (up >= rev || (trW > 0 && run >= trailN)) { st = "up"; ext = b.close; run = 0; out.push({ t: tMin(b.time), to: "up", px: b.close }); }
    }
  }
  return out;
}

async function analyze(code: string, name: string, sb: number, trailR: number, trailN: number, trailHvOnly: boolean): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 500)).filter((b) => b.date < today);
  type Cell = { n: number; sum: number; win: number; half: [number, number] };
  const mk = (): Cell => ({ n: 0, sum: 0, win: 0, half: [0, 0] });
  const cells: Record<string, Cell> = { "전일과 같은 방향": mk(), "전일과 반대 방향": mk(), "전일 무판정": mk() };
  const evalDays: { date: string; prevV: St | "none"; firstD: St; pnl: number; half: 0 | 1 }[] = [];
  for (let i = 131; i < daily.length; i++) {
    const dPrev = daily[i - 1].date, dCur = daily[i].date;
    const regPrev = rc(`${code}-${dPrev}.json`);
    const pre = rc(`${code}NX-${dCur}.json`);
    const reg = rc(`${code}-${dCur}.json`);
    if (!regPrev || regPrev.length < 240 || !reg || reg.length < 240) continue;
    const histPrev = daily.slice(Math.max(0, i - 121), i - 1);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10p = avgRange(histPrev, 10), r10 = avgRange(hist, 10);
    if (r10p === null || r10 === null) continue;
    // 전일 본피셔 최종 (09시창·현행 상수)
    const useTrailPrev = trailR > 0 && (!trailHvOnly || isHighVolDay(histPrev));
    const trPrev = stream(regPrev, r10p, 0.15, 8, 3, sb, useTrailPrev ? trailR : 0, trailN);
    const prevV: St | "none" = trPrev.length ? trPrev[trPrev.length - 1].to : "none";
    // 당일 08연속창 F 스트림 — 첫 확인 레그
    const cont = [...(pre ?? []), ...reg];
    if (cont.length < 30) continue;
    const trF = stream(cont, r10, 0.05, 4, 3, sb, 0, 0);
    if (!trF.length) continue;
    const first = trF[0];
    const endT = trF.length > 1 ? trF[1].t : Infinity;
    let pnl: number | null = null;
    for (const b of cont) {
      const tm = tMin(b.time);
      if (tm <= first.t) continue;
      if (tm >= endT) break;
      if (first.to === "up" && b.low <= first.px * 0.985) { pnl = -1.5; break; }
      if (first.to === "down" && b.high >= first.px * 1.015) { pnl = -1.5; break; }
    }
    if (pnl === null) {
      const exitPx = trF.length > 1 ? trF[1].px : reg[reg.length - 1].close;
      pnl = ((exitPx - first.px) / first.px) * 100 * (first.to === "up" ? 1 : -1);
    }
    evalDays.push({ date: dCur, prevV, firstD: first.to, pnl, half: 0 });
  }
  evalDays.forEach((e, idx) => { e.half = idx < evalDays.length / 2 ? 0 : 1; });
  for (const e of evalDays) {
    const key = e.prevV === "none" ? "전일 무판정" : (e.prevV === e.firstD ? "전일과 같은 방향" : "전일과 반대 방향");
    const c = cells[key];
    c.n++; c.sum += e.pnl; if (e.pnl > 0) c.win++; c.half[e.half] += e.pnl;
  }
  console.log(`\n════ ${name} — 첫 F 레그 ${evalDays.length}일 ════`);
  for (const [k, c] of Object.entries(cells)) {
    console.log(`  ${k.padEnd(12)} ${String(c.n).padStart(3)}일 · 평균 ${c.n ? f1(c.sum / c.n) : "—"}% · 승률 ${c.n ? Math.round((100 * c.win) / c.n) : 0}% · 합 ${f1(c.sum)}%p (전/후반 ${f1(c.half[0])}/${f1(c.half[1])})`);
  }
}

(async () => {
  await analyze("005930", "삼전", 0.075, 0.3, 3, true);
  await analyze("000660", "하닉", 0.1, 0.35, 5, false);
  console.log(`\n주: 첫 F 레그 = 아침 08연속창 F의 첫 확인 진입~첫 전환(또는 마감), 스탑 -1.5%.`);
  console.log(`   '반대 방향'이 양 종목·전/후반 일관 열위면 경고 라벨 후보, 아니면 기각 기록.`);
})().catch((e) => { console.error(e); process.exit(1); });
