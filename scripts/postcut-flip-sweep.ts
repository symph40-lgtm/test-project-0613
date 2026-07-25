// 포스트컷 꼭지점 반전 실측 (사용자 제안 2026-07-25): 스탑컷 이후에만 무장되는 조건부 반전 —
// 방향 확인 → 스탑컷(-1.5%) 발생 → 이후 ①원판정가 회복 먼저면 회복(기존 회복 문자 경로, 동일)
// ②극값(꼭지점)에서 R×10일평균폭 되돌림이 N봉 유지되면 먼저면 → 반대 방향 선언(신규).
// 비교: 현행(반대 선언은 C반전뿐)의 반대 진입 vs 포스트컷 선언의 반대 진입 — 회복-먼저 날은 양쪽 동일이라 제외.
//   npx tsx scripts/postcut-flip-sweep.ts [--days 224]   (.predict-cache 전용 — 무통신)
// 본피셔 = 라이브 상수 (0.15·8봉·반전3·sb 하닉0.1/삼전0.075). 반대 레그: 선언가 진입·-1.5% 스탑·종가 청산.

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
function stream(bars: MinuteBar[], offW: number, confirm: number, reversal: number, sbW: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const out: Trans[] = [];
  let st: "none" | St = "none", up = 0, dn = 0;
  for (const b of bars.slice(15)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - sbW) dn = Math.max(dn, confirm, reversal);
    }
    if (st === "none") {
      if (up >= confirm) { st = "up"; out.push({ time: b.time, to: "up", px: b.close }); }
      else if (dn >= confirm) { st = "down"; out.push({ time: b.time, to: "down", px: b.close }); }
    } else if (st === "up" && dn >= reversal) { st = "down"; out.push({ time: b.time, to: "down", px: b.close }); }
    else if (st === "down" && up >= reversal) { st = "up"; out.push({ time: b.time, to: "up", px: b.close }); }
  }
  return out;
}

(async () => {
  for (const [code, name, sb] of [["000660", "하닉", 0.1], ["005930", "삼전", 0.075]] as const) {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
    console.log(`\n════ ${name} (${code}) — 224일 ════`);
    console.log(`R×N     | 대상일 | 선언일(회복먼저 제외) | 선언레그 승/총 · 누적(전반/후반) | 현행 C반전 레그 (같은 날들)`);
    for (const R of [0.5, 0.75, 1.0]) {
      for (const N of [3, 5]) {
        let cutDays = 0, declDays = 0, win = 0, tot = 0, pnl = 0, basePnl = 0, baseTrades = 0;
        const pnlH: [number, number] = [0, 0];
        let di = 0;
        const bars224 = daily.slice(-DAYS);
        for (const bar of bars224) {
          di++;
          const half: 0 | 1 = di <= bars224.length / 2 ? 0 : 1;
          const idx = daily.findIndex((b) => b.date === bar.date);
          if (idx < 30) continue;
          const reg = readCache(`${code}-${bar.date}.json`);
          if (!reg || reg.length < 240) continue;
          const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
          if (r10 === null) continue;
          const tr = stream(reg, 0.15 * r10, 8, 3, sb * r10);
          if (!tr.length) continue;
          const dir = tr[0].to;
          const entry = tr[0].px;
          const isUp = dir === "up";
          const after = reg.filter((b) => tMin(b.time) > tMin(tr[0].time));
          // 스탑컷
          let cutI = -1;
          for (let i = 0; i < after.length; i++) {
            if (isUp ? after[i].low <= entry * (1 - STOP / 100) : after[i].high >= entry * (1 + STOP / 100)) { cutI = i; break; }
          }
          if (cutI < 0) continue;
          cutDays++;
          // 극값 (확인 후~컷까지 포함 계속 갱신), 컷 이후: 회복 vs 꼭지점 반전 — 먼저 온 쪽
          let extreme = entry;
          for (let i = 0; i <= cutI; i++) extreme = isUp ? Math.max(extreme, after[i].close) : Math.min(extreme, after[i].close);
          let run = 0, declI = -1, recovI = -1;
          for (let i = cutI + 1; i < after.length; i++) {
            const c = after[i].close;
            extreme = isUp ? Math.max(extreme, c) : Math.min(extreme, c);
            if (recovI < 0 && (isUp ? c > entry : c < entry)) { recovI = i; break; } // 회복 먼저 — 기존 경로
            run = (isUp ? c < extreme - R * r10 : c > extreme + R * r10) ? run + 1 : 0;
            if (run >= N) { declI = i; break; }
          }
          if (declI < 0) continue; // 회복 먼저였거나 둘 다 없음
          declDays++;
          // 신규: 선언 시 반대 진입
          const dpx = after[declI].close;
          let leg = ((bar.close - dpx) / dpx) * 100 * (isUp ? -1 : 1);
          for (let i = declI + 1; i < after.length; i++) {
            if (isUp ? after[i].high >= dpx * (1 + STOP / 100) : after[i].low <= dpx * (1 - STOP / 100)) { leg = -STOP; break; }
          }
          tot++;
          if (leg > 0) win++;
          pnl += leg;
          pnlH[half] += leg;
          // 현행: 같은 날 C반전(스트림 2번째 전이)이 있었으면 그 시점 반대 진입
          if (tr.length >= 2 && tMin(tr[1].time) > tMin(after[cutI].time)) {
            const fp = tr[1].px;
            let bleg = ((bar.close - fp) / fp) * 100 * (isUp ? -1 : 1);
            for (const b of reg.filter((b) => tMin(b.time) > tMin(tr[1].time))) {
              if (isUp ? b.high >= fp * (1 + STOP / 100) : b.low <= fp * (1 - STOP / 100)) { bleg = -STOP; break; }
            }
            basePnl += bleg;
            baseTrades++;
          }
        }
        const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
        console.log(`${R}×${N}봉  | ${String(cutDays).padStart(4)}일 | ${String(declDays).padStart(6)}일 | ${String(win).padStart(3)}/${String(tot).padEnd(3)} · ${s(pnl)}%p (${s(pnlH[0])}/${s(pnlH[1])}) | ${baseTrades}건 ${s(basePnl)}%p`);
      }
    }
  }
  console.log(`\n주: 본주 %. 선언 = 컷 이후 극값에서 R×평균폭 되돌림 N봉 유지 (원판정가 회복이 먼저면 회복 경로 — 제외).`);
})();
