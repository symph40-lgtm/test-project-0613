// 노이즈컷 회복 재진입 실측 (사용자 승인 2026-07-25) — "스탑컷 후 C반전 없이 재상승하는 경우 대비책".
// 본피셔 스트림(0.15·8봉·sb0.1·반전3, 09창) 첫확인 진입 → 본주 -1.5% 스탑컷된 날:
// 판정 방향 유지 중 가격이 회복 레벨을 종가로 넘으면 재진입(새 스탑 -1.5%), 청산 = 재컷·판정 전환·종가.
// 회복 레벨 2변형: ①A상/하선(판정선 — 이른 신호) ②원진입가(보수 — 늦은 신호). 재진입 반복 허용(왕복 비용 실측).
//   npx tsx scripts/recut-reentry-sweep.ts [--days 224]   (.predict-cache 전용 — 무통신)
// 판단 기준: 재진입 레그 누적이 유의미한 양(+)이고 두 종목·전후반 일관일 때만 "회복 문자" 채택.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { labelDay } from "../lib/predict/label";
import type { MinuteBar, Verdict } from "../lib/predict/types";

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
function stream(bars: MinuteBar[], offW: number, confirm: number, reversal: number, sbW: number): { tr: Trans[]; aUp: number; aDn: number } {
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const tr: Trans[] = [];
  let st: "none" | St = "none", up = 0, dn = 0;
  for (const b of bars.slice(15)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - sbW) dn = Math.max(dn, confirm, reversal);
    }
    if (st === "none") {
      if (up >= confirm) { st = "up"; tr.push({ time: b.time, to: "up", px: b.close }); }
      else if (dn >= confirm) { st = "down"; tr.push({ time: b.time, to: "down", px: b.close }); }
    } else if (st === "up" && dn >= reversal) { st = "down"; tr.push({ time: b.time, to: "down", px: b.close }); }
    else if (st === "down" && up >= reversal) { st = "up"; tr.push({ time: b.time, to: "up", px: b.close }); }
  }
  return { tr, aUp, aDn };
}

(async () => {
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
    const testDays = daily.slice(-DAYS);
    type Acc = {
      cutDays: number; recovDays: number; legs: number; wins: number; pnl: number; recut: number;
      pnlH: [number, number]; labelHit: number;
    };
    const accs: Record<string, Acc> = {
      "A선 회복": { cutDays: 0, recovDays: 0, legs: 0, wins: 0, pnl: 0, recut: 0, pnlH: [0, 0], labelHit: 0 },
      "진입가 회복": { cutDays: 0, recovDays: 0, legs: 0, wins: 0, pnl: 0, recut: 0, pnlH: [0, 0], labelHit: 0 },
    };
    let dirDays = 0, half = 0, di = 0;
    const total = testDays.length;
    for (const bar of testDays) {
      di++;
      half = di <= total / 2 ? 0 : 1;
      const idx = daily.findIndex((b) => b.date === bar.date);
      if (idx < 30) continue;
      const reg = readCache(`${code}-${bar.date}.json`);
      if (!reg || reg.length < 240) continue;
      const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
      if (r10 === null) continue;
      const { tr, aUp, aDn } = stream(reg, 0.15 * r10, 8, 3, 0.1 * r10);
      if (!tr.length) continue;
      dirDays++;
      const dir = tr[0].to;
      const entry0 = tr[0].px;
      const sgn = dir === "up" ? 1 : -1;
      const flipT = tr.length >= 2 ? tMin(tr[1].time) : Infinity; // 판정 전환 — 이후 재진입 없음
      const flipPx = tr.length >= 2 ? tr[1].px : null;
      const { label } = labelDay(bar);
      // 첫 진입 스탑컷 시각
      let cutAt: number | null = null;
      for (const b of reg.filter((b) => tMin(b.time) > tMin(tr[0].time) && tMin(b.time) <= Math.min(flipT, 15 * 60 + 30))) {
        if (dir === "up" && b.low <= entry0 * (1 - STOP / 100)) { cutAt = tMin(b.time); break; }
        if (dir === "down" && b.high >= entry0 * (1 + STOP / 100)) { cutAt = tMin(b.time); break; }
      }
      if (cutAt === null) continue;

      for (const [vName, level] of [
        ["A선 회복", dir === "up" ? aUp : aDn],
        ["진입가 회복", entry0],
      ] as const) {
        const a = accs[vName];
        a.cutDays++;
        if (label === (dir === "up" ? "leverage" : "inverse")) a.labelHit++; // 컷일 중 실제 그 방향이 맞았던 날
        let from = cutAt;
        let recovered = false;
        // 재진입 사이클 (판정 전환 전까지 반복)
        for (let cycle = 0; cycle < 5; cycle++) {
          const rb = reg.find((b) => tMin(b.time) > from! && tMin(b.time) < flipT
            && (dir === "up" ? b.close > level : b.close < level));
          if (!rb) break;
          if (!recovered) { a.recovDays++; recovered = true; }
          a.legs++;
          const re = rb.close;
          let leg: number | null = null;
          let cutT: number | null = null;
          for (const b of reg.filter((b) => tMin(b.time) > tMin(rb.time))) {
            const tm = tMin(b.time);
            if (tm >= flipT) { leg = flipPx !== null ? ((flipPx - re) / re) * 100 * sgn : null; break; }
            if (dir === "up" && b.low <= re * (1 - STOP / 100)) { leg = -STOP; cutT = tm; break; }
            if (dir === "down" && b.high >= re * (1 + STOP / 100)) { leg = -STOP; cutT = tm; break; }
          }
          if (leg === null) leg = ((bar.close - re) / re) * 100 * sgn; // 종가 청산
          a.pnl += leg;
          a.pnlH[half] += leg;
          if (leg > 0) a.wins++;
          if (cutT !== null) { a.recut++; from = cutT; continue; } // 재컷 → 다음 회복 대기
          break; // 전환·종가 청산으로 종료
        }
      }
    }
    console.log(`\n════ ${name} (${code}) — 방향판정 ${dirDays}일 ════`);
    for (const [vName, a] of Object.entries(accs)) {
      console.log(`[${vName}] 첫진입 컷 ${a.cutDays}일 (컷일 중 실제 그 방향 ${a.labelHit}일)`);
      console.log(`  회복 신호: ${a.recovDays}일 (컷일의 ${a.cutDays ? Math.round((100 * a.recovDays) / a.cutDays) : 0}%) · 재진입 레그 ${a.legs}회 (재컷 ${a.recut}회)`);
      console.log(`  재진입 손익: 승 ${a.wins}/${a.legs} (${a.legs ? Math.round((100 * a.wins) / a.legs) : 0}%) · 누적 ${a.pnl >= 0 ? "+" : ""}${a.pnl.toFixed(1)}%p (전반 ${a.pnlH[0] >= 0 ? "+" : ""}${a.pnlH[0].toFixed(1)} / 후반 ${a.pnlH[1] >= 0 ? "+" : ""}${a.pnlH[1].toFixed(1)})`);
    }
  }
  console.log(`\n주: 본주 % (ETF 2x는 ×2). 재진입 = 회복봉 종가, 새 스탑 -1.5%, 청산 = 재컷·판정 전환·종가. 최대 5사이클.`);
})();
