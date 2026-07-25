// 트레일 반전 실측 (사용자 문제 제기 2026-07-25): 피셔 C반전은 반대편 A선 고정 앵커라
// "멀리 갔다 돌아서는 날"일수록 전환이 늦어 기회손실 — 반전 트리거를 '확인 후 극값에서
// R×10일평균폭 되돌림 + N봉 유지'로 바꾸면(샹들리에식), 극값에 앵커가 따라붙어 이 문제가 해소되는지.
//   npx tsx scripts/trailflip-sweep.ts [--days 224]   (.predict-cache 전용 — 무통신)
//
// 변형: 기준 C5(현행)·C3(반전봉 단축) vs 트레일 R∈{0.5,0.75,1.0}×확인 N∈{3,5} (C5와 병행 — 먼저 온 쪽).
// 판정 구조는 본피셔 스트림 그대로 (0.15·8봉·sb0.1·09창). 전환 시 극값 리셋 — 하루 다중 전환 허용.
// 손익: 멀티레그 — 각 전환(첫확인 포함) 종가 진입 → 다음 전환 또는 종가 청산, 방향 부호 합산 (스탑 미적용 원값).
// 채택 기준: 하닉·삼전 × 전·후반 4/4 개선 + 가짜 전환(레그 손실) 비율 점검.

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

type St = "up" | "down";
type Trans = { time: string; to: St; px: number };

// 본피셔 스트림 + 선택적 트레일 반전 (trailW=0이면 현행 C만)
function stream(bars: MinuteBar[], offW: number, confirm: number, reversal: number, sbW: number, trailW: number, trailN: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const out: Trans[] = [];
  let state: "none" | St = "none";
  let upRun = 0, downRun = 0, trailRun = 0, extreme = 0;
  for (const b of bars.slice(15)) {
    upRun = b.close > aUp ? upRun + 1 : 0;
    downRun = b.close < aDn ? downRun + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) upRun = Math.max(upRun, confirm, reversal);
      if (b.close < aDn - sbW) downRun = Math.max(downRun, confirm, reversal);
    }
    if (state === "none") {
      if (upRun >= confirm) { state = "up"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "up", px: b.close }); }
      else if (downRun >= confirm) { state = "down"; extreme = b.close; trailRun = 0; out.push({ time: b.time, to: "down", px: b.close }); }
      continue;
    }
    if (state === "up") {
      extreme = Math.max(extreme, b.close);
      trailRun = trailW > 0 && b.close < extreme - trailW ? trailRun + 1 : 0;
      if (downRun >= reversal || (trailW > 0 && trailRun >= trailN)) {
        state = "down"; extreme = b.close; trailRun = 0;
        out.push({ time: b.time, to: "down", px: b.close });
      }
    } else {
      extreme = Math.min(extreme, b.close);
      trailRun = trailW > 0 && b.close > extreme + trailW ? trailRun + 1 : 0;
      if (upRun >= reversal || (trailW > 0 && trailRun >= trailN)) {
        state = "up"; extreme = b.close; trailRun = 0;
        out.push({ time: b.time, to: "up", px: b.close });
      }
    }
  }
  return out;
}

type Day = { r10: number; vol10: number; reg: MinuteBar[]; close: number; half: 0 | 1 };

async function loadDays(code: string): Promise<Day[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
  const out: Day[] = [];
  for (const bar of daily.slice(-DAYS)) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const reg = readCache(`${code}-${bar.date}.json`);
    if (!reg || reg.length < 240) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    const prevClose = daily[idx - 1]?.close;
    if (r10 === null || !prevClose) continue;
    out.push({ r10, vol10: (r10 / prevClose) * 100, reg, close: bar.close, half: 0 });
  }
  out.forEach((d, i) => { d.half = i < out.length / 2 ? 0 : 1; });
  return out;
}

function run(name: string, days: Day[]): void {
  console.log(`\n════ ${name} — ${days.length}일 ════`);
  console.log(`변형          | 전환일 | 총전환 | 반전레그 익/총(진성률) | 누적 전반 / 후반 = 합`);
  const variants: { tag: string; rev: number; trailR: number; trailN: number }[] = [
    { tag: "기준 C5봉    ", rev: 5, trailR: 0, trailN: 0 },
    { tag: "C3봉        ", rev: 3, trailR: 0, trailN: 0 },
    ...[0.5, 0.75, 1.0].flatMap((r) => [3, 5].map((n) => ({ tag: `트레일 ${r}×${n}봉`.padEnd(12), rev: 5, trailR: r, trailN: n }))),
  ];
  for (const v of variants) {
    let flipDays = 0, flips = 0, revWin = 0, revTot = 0;
    const pnlH: [number, number] = [0, 0];
    for (const d of days) {
      const tr = stream(d.reg, 0.15 * d.r10, 8, v.rev, 0.1 * d.r10, v.trailR * d.r10, v.trailN);
      if (!tr.length) continue;
      if (tr.length >= 2) { flipDays++; flips += tr.length - 1; }
      let pnl = 0;
      for (let i = 0; i < tr.length; i++) {
        const exitPx = i + 1 < tr.length ? tr[i + 1].px : d.close;
        const leg = ((exitPx - tr[i].px) / tr[i].px) * 100 * (tr[i].to === "up" ? 1 : -1);
        pnl += leg;
        if (i >= 1) { revTot++; if (leg > 0) revWin++; }
      }
      pnlH[d.half] += pnl;
    }
    const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
    console.log(`${v.tag} | ${String(flipDays).padStart(4)}일 | ${String(flips).padStart(4)}회 | ${String(revWin).padStart(4)}/${String(revTot).padEnd(4)} (${revTot ? Math.round((100 * revWin) / revTot) : 0}%) | ${s(pnlH[0])} / ${s(pnlH[1])} = ${s(pnlH[0] + pnlH[1])}%p`);
  }
}

(async () => {
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    const days = await loadDays(code);
    run(`${name} (${code})`, days);
    // 레짐 조건부: vol10(10일 평균폭%) 상위⅓ 날만 — 고변동 레짐에서만 트레일을 켤 근거가 있는지
    const sorted = [...days].sort((a, b) => a.vol10 - b.vol10);
    const cut = sorted[Math.floor((2 * sorted.length) / 3)].vol10;
    run(`${name} · vol10 상위⅓ (≥${cut.toFixed(2)}%)`, days.filter((d) => d.vol10 >= cut));
    run(`${name} · vol10 하·중위⅔`, days.filter((d) => d.vol10 < cut));
  }
  console.log(`\n참고: 스탑 미적용 원값 멀티레그 — 트레일 반전은 사실상 '트레일 스탑 + 즉시 역진입'과 동일 구조.`);
})();
