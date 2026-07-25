// 피셔F 반전 경보 앵커 실측 (사용자 지시 2026-07-25): 현행 F는 08:00 연속창(프리장 포함) OR 앵커 —
// 프리장 급등락이 밴드를 넓혀 반전 경보 커버리지가 낮았음 (reversal-sweep: 본 반전 25일 중 7일만 선행).
// 변형 = F(0.05·4봉·sb0.1)를 09:00 정규장창 앵커로. 판정자 역할이 아니라 "본피셔 반전 조기 경보" 역할만 평가.
//   npx tsx scripts/frev-anchor-sweep.ts [--days 224]   (.predict-cache 전용 — 무통신)
//
// 평가 (본피셔 = 현행 라이브: 0.15·8봉·sb0.1·반전3봉):
//   ① 본 반전일 커버리지: F가 본 전환보다 앞서 반대방향을 확인한 날 수·리드(분)·사이 절약(%)
//   ② 오경보 비용: 본이 반전하지 않은 방향 확인일에 F가 반대 경보 → "청산+반대 1단계" 가정 시
//      반대 레그(경보가→종가) 손익 — 음수면 경보가 유해.
// 채택 기준: 두 종목 모두 커버리지 개선 + 오경보 순비용이 절약을 잠식하지 않을 것.

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

const readCache = (file: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, file);
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
  let state: "none" | St = "none", up = 0, dn = 0;
  for (const b of bars.slice(15)) {
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - sbW) dn = Math.max(dn, confirm, reversal);
    }
    if (state === "none") {
      if (up >= confirm) { state = "up"; out.push({ time: b.time, to: "up", px: b.close }); }
      else if (dn >= confirm) { state = "down"; out.push({ time: b.time, to: "down", px: b.close }); }
    } else if (state === "up" && dn >= reversal) { state = "down"; out.push({ time: b.time, to: "down", px: b.close }); }
    else if (state === "down" && up >= reversal) { state = "up"; out.push({ time: b.time, to: "up", px: b.close }); }
  }
  return out;
}
const opp = (s: St): St => (s === "up" ? "down" : "up");
const sgn = (s: St) => (s === "up" ? 1 : -1);

async function runSymbol(code: string, name: string): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
  console.log(`\n════ ${name} (${code}) ════`);
  type Acc = { cov: number; revN: number; leads: number[]; saved: number[]; fa: number; faRet: number[] };
  const acc: Record<string, Acc> = {
    "F 08창(현행)": { cov: 0, revN: 0, leads: [], saved: [], fa: 0, faRet: [] },
    "F 09창(변형)": { cov: 0, revN: 0, leads: [], saved: [], fa: 0, faRet: [] },
  };
  for (const bar of daily.slice(-DAYS)) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const reg = readCache(`${code}-${bar.date}.json`);
    if (!reg || reg.length < 240) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    if (r10 === null) continue;
    const pre = readCache(`${code}NX-${bar.date}.json`) ?? [];
    const bon = stream(reg, 0.15 * r10, 8, 3, 0.1 * r10); // 현행 라이브 (반전 3봉)
    if (!bon.length) continue;
    const dir1 = bon[0].to;
    const t1 = tMin(bon[0].time);
    const flip = bon.length >= 2 ? bon[1] : null;
    const variants: [string, Trans[]][] = [
      ["F 08창(현행)", stream([...pre, ...reg], 0.05 * r10, 4, 5, 0.1 * r10)],
      ["F 09창(변형)", stream(reg, 0.05 * r10, 4, 5, 0.1 * r10)],
    ];
    for (const [tag, F] of variants) {
      const a = acc[tag];
      if (flip) {
        a.revN++;
        const t2 = tMin(flip.time);
        const al = F.find((t) => t.to === flip.to && tMin(t.time) > t1 && tMin(t.time) <= t2);
        if (al) {
          a.cov++;
          a.leads.push(t2 - tMin(al.time));
          a.saved.push(((flip.px - al.px) / al.px) * 100 * -sgn(dir1)); // +: 경보가 손실 절약
        }
      } else {
        // 본 무반전일 — F의 반대 경보 = 오경보. "청산+반대 1단계" 가정 반대 레그 손익
        const al = F.find((t) => t.to === opp(dir1) && tMin(t.time) > t1);
        if (al) {
          a.fa++;
          a.faRet.push(((bar.close - al.px) / al.px) * 100 * sgn(opp(dir1)));
        }
      }
    }
  }
  for (const [tag, a] of Object.entries(acc)) {
    const leads = [...a.leads].sort((x, y) => x - y);
    const med = leads.length ? leads[Math.floor(leads.length / 2)] : null;
    const savedSum = a.saved.reduce((x, y) => x + y, 0);
    const faSum = a.faRet.reduce((x, y) => x + y, 0);
    console.log(`\n[${tag}]`);
    console.log(`  본 반전일 커버: ${a.cov}/${a.revN} · 리드 중앙 ${med ?? "—"}분 · 절약 합 ${savedSum >= 0 ? "+" : ""}${savedSum.toFixed(1)}%p (평균 ${a.saved.length ? (savedSum / a.saved.length).toFixed(2) : "—"}%)`);
    console.log(`  오경보(본 무반전 방향일): ${a.fa}건 · 반대레그 누적 ${faSum >= 0 ? "+" : ""}${faSum.toFixed(1)}%p (평균 ${a.faRet.length ? (faSum / a.faRet.length).toFixed(2) : "—"}%)`);
    console.log(`  순효과(절약+오경보레그): ${(savedSum + faSum) >= 0 ? "+" : ""}${(savedSum + faSum).toFixed(1)}%p`);
  }
}

(async () => {
  await runSymbol("000660", "하닉");
  await runSymbol("005930", "삼전");
})();
