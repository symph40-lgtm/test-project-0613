// 피셔F 하이브리드 앵커 실측 (사용자 제안 2026-07-25): 현행 F는 08:00 연속창 OR에 하루 종일
// 고정 — 프리장 급등락이 밴드를 왜곡 (7/23 삼전 실물). 제안 = 프리장엔 08창 유지(조기 판정 역할),
// 09창 OR 형성 후엔 정규장 OR로 재앵커. 상태 승계: 09창 F의 첫 확인이 나올 때까지 08창 상태 유지
// (핸드오프 유예식 — 가짜 소멸 없음), 이후 09창 상태를 따름.
//   npx tsx scripts/f-hybrid-sweep.ts [--days 224]   (.predict-cache 전용 — 무통신)
//
// 변형: F08(현행) / F09단독(참고 — 프리장 판정 포기) / F하이브리드(08→09 승계 스플라이스)
// 지표: ①판정 역할 — 방향판정일·최종상태 방향적중·첫확인 진입 스탑 경제성 ②반전 경보 —
//       본피셔(반전3·sb0.1) 반전일 커버리지 ③문자량 — 총 전이 수·스플라이스 반전(교체 순간 방향 뒤집힘) 수.

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
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
    type Acc = { dirDays: number; hit: number; pnl: number; trans: number; spliceFlip: number; cov: number; revN: number };
    const acc: Record<string, Acc> = {};
    const mk = () => ({ dirDays: 0, hit: 0, pnl: 0, trans: 0, spliceFlip: 0, cov: 0, revN: 0 });
    for (const v of ["F08(현행)", "F09단독", "F하이브리드"]) acc[v] = mk();

    for (const bar of daily.slice(-DAYS)) {
      const idx = daily.findIndex((b) => b.date === bar.date);
      if (idx < 30) continue;
      const reg = readCache(`${code}-${bar.date}.json`);
      if (!reg || reg.length < 240) continue;
      const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
      if (r10 === null) continue;
      const pre = readCache(`${code}NX-${bar.date}.json`) ?? [];
      const { label } = labelDay(bar);
      const offW = 0.05 * r10, sbW = 0.1 * r10;
      const f08 = stream([...pre, ...reg], offW, 4, 5, sbW);
      const f09 = stream(reg, offW, 4, 5, sbW);
      // 하이브리드: 09창 F 첫 확인 전 = 08창 상태 승계, 이후 = 09창 상태
      let hybrid: Trans[];
      let splice = 0;
      if (!f09.length) hybrid = [...f08];
      else {
        const t0 = tMin(f09[0].time);
        hybrid = f08.filter((t) => tMin(t.time) < t0);
        let cur: "none" | St = hybrid.length ? hybrid[hybrid.length - 1].to : "none";
        for (const t of f09) {
          if (t.to !== cur) {
            hybrid.push(t);
            if (cur !== "none" && t.time === f09[0].time) splice++; // 교체 순간 방향 뒤집힘
            cur = t.to;
          }
        }
      }
      const bon = stream(reg, 0.15 * r10, 8, 3, sbW);
      const flip = bon.length >= 2 ? bon[1] : null;
      const t1 = bon.length ? tMin(bon[0].time) : null;

      for (const [vName, tr] of [["F08(현행)", f08], ["F09단독", f09], ["F하이브리드", hybrid]] as const) {
        const a = acc[vName];
        a.trans += tr.length;
        if (vName === "F하이브리드") a.spliceFlip += splice;
        if (tr.length) {
          a.dirDays++;
          const final = tr[tr.length - 1].to;
          if ((final === "up" ? "leverage" : "inverse") === label) a.hit++;
          // 첫확인 진입 + 스탑 -1.5% + 종가 청산
          const e = tr[0];
          const entry = e.px;
          const dir = e.to;
          let pnl = ((bar.close - entry) / entry) * 100 * (dir === "up" ? 1 : -1);
          for (const b of reg.filter((b) => tMin(b.time) > tMin(e.time))) {
            if (dir === "up" && b.low <= entry * 0.985) { pnl = -1.5; break; }
            if (dir === "down" && b.high >= entry * 1.015) { pnl = -1.5; break; }
          }
          a.pnl += pnl;
        }
        if (flip && t1 !== null) {
          a.revN++;
          const t2 = tMin(flip.time);
          if (tr.some((t) => t.to === flip.to && tMin(t.time) > t1 && tMin(t.time) <= t2)) a.cov++;
        }
      }
    }
    console.log(`\n════ ${name} (${code}) ════`);
    console.log(`변형        | 방향판정일 | 최종 방향적중  | 첫확인 스탑누적 | 총전이(문자량) | 스플라이스반전 | 본반전 커버`);
    for (const [vName, a] of Object.entries(acc)) {
      console.log(`${vName.padEnd(10)} | ${String(a.dirDays).padStart(6)}일 | ${String(a.hit).padStart(4)}/${a.dirDays} (${a.dirDays ? Math.round((100 * a.hit) / a.dirDays) : 0}%) | ${(a.pnl >= 0 ? "+" : "") + a.pnl.toFixed(1).padStart(6)}%p | ${String(a.trans).padStart(6)}회 | ${vName === "F하이브리드" ? String(a.spliceFlip).padStart(4) + "일" : "   —"} | ${a.cov}/${a.revN}`);
    }
  }
  console.log(`\n주: 손익 = 첫 방향확인 봉 종가 진입·본주 -1.5% 스탑·종가 청산 (프리장 확인일은 실전상 09:00 1/3 선진입 — 근사).`);
})();
