// 추세 전환 속도 실측 (사용자 지시 2026-07-25 — 설계 기준 3번 "추세 전환 시 신속한 판정").
//   npx tsx scripts/reversal-sweep.ts [--days 224]   (.predict-cache 전용 — 무통신)
//
// ① 반전일 실측: 본피셔(0.15·8봉·sb0.1·반전5봉, 09:00창)가 장중 C반전한 날 —
//    피셔F(0.05·4봉·sb0.1, 08:00 연속창)의 반대방향 경보 시각 vs 본피셔 전환 시각,
//    그 사이 가격 손실(기존 방향 보유 관점), 스탑(-1.5% 본주)이 먼저 끊었을지 여부.
// ② 반전봉 스윕: 본피셔 reversalMinutes 5→4→3→2 — 전환 조기화(분·가격) 이득 vs
//    가짜 반전(전환 후 종가까지 방향이 틀린 경우) 증가 비용. 2레그 손익:
//    레그1 = 첫확인 진입→전환(또는 종가) 청산 / 레그2 = 전환 시 반대 진입→종가.
// 채택 기준(다른 스윕과 동일): 하닉·삼전 모두 + 전·후반 모두 개선일 때만 후보.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const STOP_PCT = 1.5;

const readCache = (file: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

// fisher.ts 상태기계의 스트리밍판 — 전이 타임라인 반환 (로직 동일: 연속봉 카운트 + 강돌파 오버라이드)
type St = "none" | "up" | "down";
type Trans = { time: string; to: St; px: number };
function stream(bars: MinuteBar[], orN: number, offsetWon: number, confirm: number, reversal: number, strongWon: number): Trans[] {
  if (bars.length < orN + 1) return [];
  const or = bars.slice(0, orN);
  const aUp = Math.max(...or.map((b) => b.high)) + offsetWon;
  const aDown = Math.min(...or.map((b) => b.low)) - offsetWon;
  const out: Trans[] = [];
  let state: St = "none", upRun = 0, downRun = 0;
  for (const b of bars.slice(orN)) {
    upRun = b.close > aUp ? upRun + 1 : 0;
    downRun = b.close < aDown ? downRun + 1 : 0;
    if (strongWon > 0) {
      if (b.close > aUp + strongWon) upRun = Math.max(upRun, confirm, reversal);
      if (b.close < aDown - strongWon) downRun = Math.max(downRun, confirm, reversal);
    }
    if (state === "none") {
      if (upRun >= confirm) { state = "up"; out.push({ time: b.time, to: state, px: b.close }); }
      else if (downRun >= confirm) { state = "down"; out.push({ time: b.time, to: state, px: b.close }); }
    } else if (state === "up" && downRun >= reversal) {
      state = "down"; out.push({ time: b.time, to: state, px: b.close });
    } else if (state === "down" && upRun >= reversal) {
      state = "up"; out.push({ time: b.time, to: state, px: b.close });
    }
  }
  return out;
}

type Day = { date: string; hist120: number | null; pre: MinuteBar[]; reg: MinuteBar[]; close: number; half: 0 | 1 };

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
    out.push({ date: bar.date, hist120: r10, pre: readCache(`${code}NX-${bar.date}.json`) ?? [], reg, close: bar.close, half: 0 });
  }
  out.forEach((d, i) => { d.half = i < out.length / 2 ? 0 : 1; });
  return out;
}

const dirSign = (s: St) => (s === "up" ? 1 : -1);

function run(code: string, name: string, days: Day[]): void {
  console.log(`\n════ ${name} (${code}) — ${days.length}일 ════`);

  // ── ① 반전일 실측 (본피셔 반전 5봉 기준)
  type Rev = { date: string; dir1: St; t1: string; tF: string | null; t2: string; pxF: number | null; px2: number; savedPct: number | null; leadMin: number | null; stopFirst: boolean };
  const revs: Rev[] = [];
  for (const d of days) {
    if (d.hist120 === null) continue;
    const bon = stream(d.reg, 15, 0.15 * d.hist120, 8, 5, 0.1 * d.hist120);
    if (bon.length < 2) continue; // 반전 없음
    const first = bon[0], flip = bon[1];
    // 피셔F 08:00 연속창 — 본피셔 첫확인 이후 반대방향(flip.to)으로의 첫 전이
    const cont = [...d.pre, ...d.reg];
    const F = stream(cont, 15, 0.05 * d.hist120, 4, 5, 0.1 * d.hist120);
    const fAlert = F.find((t) => t.to === flip.to && tMin(t.time) > tMin(first.time) && tMin(t.time) <= tMin(flip.time)) ?? null;
    // 스탑: 레그1 진입(첫확인 종가)에서 -1.5% 도달 시각이 F 경보보다 빨랐나
    const entry = first.px;
    let stopAt: string | null = null;
    for (const b of d.reg.filter((b) => tMin(b.time) > tMin(first.time))) {
      if (first.to === "up" && b.low <= entry * (1 - STOP_PCT / 100)) { stopAt = b.time; break; }
      if (first.to === "down" && b.high >= entry * (1 + STOP_PCT / 100)) { stopAt = b.time; break; }
    }
    const savedPct = fAlert ? ((flip.px - fAlert.px) / fAlert.px) * 100 * -dirSign(first.to) : null;
    revs.push({
      date: d.date, dir1: first.to, t1: first.time, tF: fAlert?.time ?? null, t2: flip.time,
      pxF: fAlert?.px ?? null, px2: flip.px,
      savedPct: savedPct !== null ? Number(savedPct.toFixed(2)) : null,
      leadMin: fAlert ? tMin(flip.time) - tMin(fAlert.time) : null,
      stopFirst: stopAt !== null && (!fAlert || tMin(stopAt) < tMin(fAlert.time)),
    });
  }
  console.log(`\n── ① 본피셔 장중 C반전일: ${revs.length}일 / ${days.length}일 ──`);
  const withF = revs.filter((r) => r.leadMin !== null);
  const noF = revs.length - withF.length;
  if (withF.length) {
    const leads = withF.map((r) => r.leadMin!).sort((a, b) => a - b);
    const saved = withF.map((r) => r.savedPct!);
    const med = leads[Math.floor(leads.length / 2)];
    console.log(`F 반전 경보가 앞선 날: ${withF.length}일 (경보 없음/동시: ${noF}일)`);
    console.log(`  리드타임: 중앙 ${med}분 · 평균 ${Math.round(leads.reduce((a, b) => a + b, 0) / leads.length)}분 · 최대 ${leads[leads.length - 1]}분`);
    console.log(`  경보→전환 사이 추가 손실(기존 방향 보유 기준): 평균 ${(saved.reduce((a, b) => a + b, 0) / saved.length).toFixed(2)}% · 합계 ${saved.reduce((a, b) => a + b, 0).toFixed(1)}%p`);
    console.log(`  스탑(-1.5%)이 F 경보보다 먼저 끊은 날: ${revs.filter((r) => r.stopFirst).length}/${revs.length}일`);
    console.log(`  상세 (최근 10건): 날짜 · 첫확인 → F경보 → 본전환 · 사이손실`);
    for (const r of revs.slice(-10)) {
      console.log(`    ${r.date} ${r.dir1 === "up" ? "레버" : "인버"} ${r.t1} → F ${r.tF ?? "—"} → 본 ${r.t2} · ${r.savedPct !== null ? `${r.savedPct >= 0 ? "+" : ""}${r.savedPct}%` : "—"}${r.stopFirst ? " (스탑 선행)" : ""}`);
    }
  }

  // ── ② 반전봉 스윕 — 이득(조기화) vs 비용(가짜 반전)
  console.log(`\n── ② 본피셔 반전봉 스윕 (확인 8봉 고정·sb0.1) ──`);
  console.log(`반전봉 | 반전일 | 진성(레그2 익) | 가짜 | 평균 조기화 | 레그1+레그2 누적(전반/후반)`);
  for (const rv of [5, 4, 3, 2]) {
    let flips = 0, genuine = 0, fake = 0, earlySum = 0, earlyN = 0;
    const pnlH: [number, number] = [0, 0];
    for (const d of days) {
      if (d.hist120 === null) continue;
      const tr = stream(d.reg, 15, 0.15 * d.hist120, 8, rv, 0.1 * d.hist120);
      if (!tr.length) continue;
      const first = tr[0];
      let pnl = 0;
      if (tr.length >= 2) {
        flips++;
        const flip = tr[1];
        const leg2 = ((d.close - flip.px) / flip.px) * 100 * dirSign(flip.to);
        if (leg2 > 0) genuine++; else fake++;
        pnl += ((flip.px - first.px) / first.px) * 100 * dirSign(first.to) + leg2;
        // 조기화: 기준(5봉) 전환 시각 대비
        if (rv !== 5) {
          const base = stream(d.reg, 15, 0.15 * d.hist120, 8, 5, 0.1 * d.hist120);
          if (base.length >= 2 && base[1].to === flip.to) { earlySum += tMin(base[1].time) - tMin(flip.time); earlyN++; }
        }
      } else {
        pnl += ((d.close - first.px) / first.px) * 100 * dirSign(first.to);
      }
      pnlH[d.half] += pnl;
    }
    const early = rv === 5 ? "기준" : earlyN ? `${(earlySum / earlyN).toFixed(1)}분` : "—";
    console.log(`  ${rv}봉  | ${String(flips).padStart(4)}일 | ${String(genuine).padStart(6)}일 (${flips ? Math.round((100 * genuine) / flips) : 0}%) | ${String(fake).padStart(3)}일 | ${early.padStart(8)} | ${(pnlH[0] >= 0 ? "+" : "") + pnlH[0].toFixed(1)} / ${(pnlH[1] >= 0 ? "+" : "") + pnlH[1].toFixed(1)} = ${(pnlH[0] + pnlH[1] >= 0 ? "+" : "") + (pnlH[0] + pnlH[1]).toFixed(1)}%p`);
  }
}

(async () => {
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    run(code, name, await loadDays(code));
  }
  console.log(`\n참고: 레그 손익은 스탑 미적용 원값 — 실전은 레그1이 ETF -3% 스탑으로 먼저 끊기는 날이 많음(① 스탑 선행 비율 참조).`);
})();
