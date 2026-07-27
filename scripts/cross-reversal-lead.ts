// 삼전·하닉 교차 반전 선행-후행 실측 (사용자 승인 2026-07-27 — "하닉이 먼저 반전 확인 →
// 삼전 경계"가 성립하는지): 동행성 실측(일봉 방향일치 78%·양추세일 96%·일중 경로 r 0.83)을
// 근거로, 라이브 채택 스트림(본피셔 C반전3 + 고변동일 트레일: 삼전 0.3×3 / 하닉 0.35×5,
// sb 삼전 0.075/하닉 0.1)에서 반전 이벤트의 선행 분포와 교차 대응 정책 손익을 잰다.
//   npx tsx scripts/cross-reversal-lead.ts [--days 224]   (.predict-cache — 무통신)
// 정책 (삼전 쪽, 하닉 반전을 신호로): A 현행(삼전 자체 전이만) / B 하닉 반대반전 시 삼전 조기청산 /
//   C 조기청산+반대 전환(종가까지, 스탑 -1.5%). 반대 방향: 하닉→삼전도 대칭 측정.

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

// 현행(A) 멀티레그 손익 — 레그별 스탑, 컷 후 다음 전이까지 관망. cutAt: 시각 T에 강제 청산(정책 B/C용)
function pnlLegs(reg: MinuteBar[], tr: Trans[], close: number, cutAtMin: number | null): number {
  let pnl = 0;
  for (let i = 0; i < tr.length; i++) {
    const entry = tr[i].px, dir = tr[i].to;
    const startT = tMin(tr[i].time);
    let endT = i + 1 < tr.length ? tMin(tr[i + 1].time) : Infinity;
    let exitPx = i + 1 < tr.length ? tr[i + 1].px : close;
    if (cutAtMin !== null && startT < cutAtMin && cutAtMin < endT) {
      const cutBar = [...reg].reverse().find((b) => tMin(b.time) <= cutAtMin);
      if (cutBar) { endT = cutAtMin; exitPx = cutBar.close; }
    }
    if (cutAtMin !== null && startT >= cutAtMin) {
      // 조기청산 이후의 자체 전이 재진입은 그대로 수행 (B = 청산만 앞당김)
    }
    let stopped = false;
    for (const b of reg) {
      const tm = tMin(b.time);
      if (tm <= startT) continue;
      if (tm >= endT) break;
      if (dir === "up" && b.low <= entry * (1 - STOP / 100)) { pnl -= STOP; stopped = true; break; }
      if (dir === "down" && b.high >= entry * (1 + STOP / 100)) { pnl -= STOP; stopped = true; break; }
    }
    if (!stopped) pnl += ((exitPx - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
  }
  return pnl;
}

type DayS = { date: string; r10: number; hv: boolean; reg: MinuteBar[]; close: number };

async function loadSeq(code: string): Promise<Map<string, DayS>> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 200)).filter((b) => b.date < today);
  type Row = { date: string; vol10: number; reg: MinuteBar[]; r10: number; close: number };
  const seq: Row[] = [];
  for (const bar of daily.slice(-(DAYS + 70))) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    const prevClose = daily[idx - 1]?.close;
    if (r10 === null || !prevClose) continue;
    seq.push({ date: bar.date, vol10: (r10 / prevClose) * 100, reg: readCache(`${code}-${bar.date}.json`) ?? [], r10, close: bar.close });
  }
  const out = new Map<string, DayS>();
  for (let i = 60; i < seq.length; i++) {
    const d = seq[i];
    if (d.reg.length < 240) continue;
    const prior = seq.slice(Math.max(0, i - 60), i).map((x) => x.vol10).sort((a, b) => a - b);
    if (prior.length < 40) continue;
    out.set(d.date, { date: d.date, r10: d.r10, hv: d.vol10 >= prior[Math.floor((2 * prior.length) / 3)], reg: d.reg, close: d.close });
  }
  return out;
}

(async () => {
  const [ssMap, hxMap] = await Promise.all([loadSeq("005930"), loadSeq("000660")]);
  const dates = [...ssMap.keys()].filter((d) => hxMap.has(d)).sort();
  const trOf = (s: DayS, code: "ss" | "hx") => {
    const sb = code === "ss" ? 0.075 : 0.1;
    const [r, n] = code === "ss" ? [0.3, 3] : [0.35, 5];
    return s.hv ? stream(s.reg, 0.15 * s.r10, 8, 3, sb * s.r10, r * s.r10, n) : stream(s.reg, 0.15 * s.r10, 8, 3, sb * s.r10, 0, 0);
  };
  // ① 반전 발생 분포·선행-후행
  let bothRev = 0, onlySs = 0, onlyHx = 0, neither = 0, dirMatch = 0;
  const leadHx: number[] = [], leadSs: number[] = [];
  // ② 정책 (양방향): tgt 보유 중 src가 tgt 현재 방향과 반대로 반전 → B 조기청산 / C 청산+전환
  type Pol = { a: [number, number]; b: [number, number]; c: [number, number]; sigDays: number; tgtFollowed: number };
  const mk = (): Pol => ({ a: [0, 0], b: [0, 0], c: [0, 0], sigDays: 0, tgtFollowed: 0 });
  const pol: { hx2ss: Pol; ss2hx: Pol } = { hx2ss: mk(), ss2hx: mk() };
  dates.forEach((date, di) => {
    const ss = ssMap.get(date)!, hx = hxMap.get(date)!;
    const trSs = trOf(ss, "ss"), trHx = trOf(hx, "hx");
    const revSs = trSs.slice(1), revHx = trHx.slice(1);
    if (revSs.length && revHx.length) {
      bothRev++;
      if (revSs[0].to === revHx[0].to) dirMatch++;
      const dt = tMin(revSs[0].time) - tMin(revHx[0].time);
      if (dt > 0) leadHx.push(dt); else if (dt < 0) leadSs.push(-dt);
    } else if (revSs.length) onlySs++;
    else if (revHx.length) onlyHx++;
    else neither++;
    const half: 0 | 1 = di < dates.length / 2 ? 0 : 1;
    for (const [key, src, tgt, trSrc, trTgt] of [["hx2ss", hx, ss, trHx, trSs], ["ss2hx", ss, hx, trSs, trHx]] as const) {
      const p = pol[key];
      // 신호: tgt가 방향 보유 중일 때 src가 그 반대 방향으로 반전한 첫 시각
      let sig: { min: number; to: St } | null = null;
      for (const r of trSrc.slice(1)) {
        const rm = tMin(r.time);
        const cur = [...trTgt].reverse().find((t) => tMin(t.time) <= rm);
        if (cur && cur.to !== r.to) { sig = { min: rm, to: r.to }; break; }
      }
      const pa = pnlLegs(tgt.reg, trTgt, tgt.close, null);
      p.a[half] += pa;
      if (!sig) { p.b[half] += pa; p.c[half] += pa; continue; }
      p.sigDays++;
      const tgtOwnRev = trTgt.slice(1).find((t) => tMin(t.time) > sig!.min && t.to === sig!.to);
      if (tgtOwnRev) p.tgtFollowed++;
      const pb = pnlLegs(tgt.reg, trTgt, tgt.close, sig.min);
      p.b[half] += pb;
      // C: 조기청산 + 반대 진입 (신호 시각 tgt 종가, 스탑 -1.5%, tgt 자체 동일방향 전이 나오면 그 레그는 중복 방지 위해 제거)
      const entBar = [...tgt.reg].reverse().find((b) => tMin(b.time) <= sig!.min);
      let pc = pb;
      if (entBar) {
        const entry = entBar.close, dir = sig.to;
        let stopped = false;
        for (const b of tgt.reg) {
          if (tMin(b.time) <= sig.min) continue;
          if (dir === "up" && b.low <= entry * (1 - STOP / 100)) { pc -= STOP; stopped = true; break; }
          if (dir === "down" && b.high >= entry * (1 + STOP / 100)) { pc -= STOP; stopped = true; break; }
        }
        if (!stopped) pc += ((tgt.close - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
        if (tgtOwnRev) {
          // tgt 자체 동일방향 레그(현행 A에 포함된 것) 제거 — C에서 이중 계상 방지
          const i = trTgt.findIndex((t) => t.time === tgtOwnRev.time);
          const ent2 = tgtOwnRev.px, dir2 = tgtOwnRev.to;
          const st2 = tMin(tgtOwnRev.time);
          const end2 = i + 1 < trTgt.length ? tMin(trTgt[i + 1].time) : Infinity;
          let leg = 0, stopped2 = false;
          for (const b of tgt.reg) {
            const tm = tMin(b.time);
            if (tm <= st2) continue;
            if (tm >= end2) break;
            if (dir2 === "up" && b.low <= ent2 * (1 - STOP / 100)) { leg = -STOP; stopped2 = true; break; }
            if (dir2 === "down" && b.high >= ent2 * (1 + STOP / 100)) { leg = -STOP; stopped2 = true; break; }
          }
          if (!stopped2) { const ex = i + 1 < trTgt.length ? trTgt[i + 1].px : tgt.close; leg = ((ex - ent2) / ent2) * 100 * (dir2 === "up" ? 1 : -1); }
          pc -= leg;
        }
      }
      p.c[half] += pc;
    }
  });
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  console.log(`공통 평가일 ${dates.length}일 — 반전(전이 2번째+) 발생: 둘다 ${bothRev} · 삼전만 ${onlySs} · 하닉만 ${onlyHx} · 없음 ${neither}`);
  console.log(`둘다 반전일 첫 반전 방향 일치 ${dirMatch}/${bothRev} (${bothRev ? Math.round((100 * dirMatch) / bothRev) : 0}%)`);
  console.log(`선행: 하닉 먼저 ${leadHx.length}일 (리드 중앙 ${med(leadHx)}분) · 삼전 먼저 ${leadSs.length}일 (중앙 ${med(leadSs)}분) · 동시 ${bothRev - leadHx.length - leadSs.length}일`);
  const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
  for (const [key, ko] of [["hx2ss", "하닉 반전 → 삼전 대응"], ["ss2hx", "삼전 반전 → 하닉 대응"]] as const) {
    const p = pol[key];
    console.log(`\n${ko} — 신호일 ${p.sigDays}일 (신호 후 자체 동일방향 반전 추종 ${p.tgtFollowed}일 = ${p.sigDays ? Math.round((100 * p.tgtFollowed) / p.sigDays) : 0}%)`);
    console.log(`  A 현행       : ${s(p.a[0])} / ${s(p.a[1])} = ${s(p.a[0] + p.a[1])}%p`);
    console.log(`  B 조기 청산   : ${s(p.b[0])} / ${s(p.b[1])} = ${s(p.b[0] + p.b[1])}%p (Δ ${s(p.b[0] + p.b[1] - p.a[0] - p.a[1])})`);
    console.log(`  C 청산+전환   : ${s(p.c[0])} / ${s(p.c[1])} = ${s(p.c[0] + p.c[1])}%p (Δ ${s(p.c[0] + p.c[1] - p.a[0] - p.a[1])})`);
  }
  console.log(`\n주: 라이브 채택 스트림(C반전3·트레일 삼전 0.3×3/하닉 0.35×5·고변동 게이트) 재현. 본주 %·레그별 -1.5% 스탑.`);
})();
