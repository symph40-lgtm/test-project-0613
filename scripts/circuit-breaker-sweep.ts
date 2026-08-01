// 연쇄 컷 서킷브레이커 실측 (사용자 승인 2026-08-01 — 7/30부터 승인 대기였던 마지막 미실측 항목):
//   npx tsx scripts/circuit-breaker-sweep.ts
// 바탕: 통합 4단 사다리 (F 30%→진행성 70%→전진0.3/창동의 100%·창선행 100%·이견 청산+역진입·F반대 청산,
//   ladder3-sweep 통합 최종 +113.5%p와 동일 — 재진입 100% 기준, 최종 채택 50%와의 차이는 별도 표기).
// 규칙: 직전 K거래일 중 컷 발생일 ≥ M이면 오늘 방어 모드 —
//   [정찰절반] 정찰 트랜치만 30→15% / [전체절반] 그날 전 트랜치 ×0.5.
// 컷 발생 여부는 가격 경로가 결정(비중 무관)하므로 방어 스케줄은 기준 런의 컷 플래그로 확정 — 무선견.
// + 클러스터링 검정: P(컷|어제 컷), P(컷|최근 3일 컷≥2) vs 기저율. + 2026-07 구간 분리.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { candleJudgeStream, unitArr } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

function fisherFirst(bars: MinuteBar[], r10: number): { t: number; i: number; dir: 1 | -1; px: number } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = tMin("10:30");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = tMin(b.time) < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (up >= 4) return { t: tMin(b.time), i, dir: 1, px: b.close };
    if (dn >= 4) return { t: tMin(b.time), i, dir: -1, px: b.close };
  }
  return null;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  // 일별 시뮬: pnl(기준 비중)·scoutPnl(정찰 트랜치 기여)·cut(스탑 발생 여부)
  type DayR = { date: string; pnl: number; scoutPnl: number; cut: boolean };
  const res: DayR[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const cw = trs.length ? { t: tMin(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
    const fJ = fisherFirst(bars, r10);
    let pnl = 0, scoutPnl = 0, cut = false;
    const close = daily[i].close;
    const tr = (i0: number, dir: 1 | -1, px: number, size: number, forceI?: number, forcePx?: number): number => {
      if (size <= 0) return 0;
      const s = 2.5 / 100;
      const lim = forceI ?? bars.length;
      for (let k = i0 + 1; k < lim; k++) {
        const b = bars[k];
        if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) { cut = true; return -2.5 * size; }
      }
      const px2 = forceI !== undefined ? (forcePx ?? close) : close;
      return ((px2 - px) / px) * 100 * dir * size;
    };
    const fFirst = fJ && (!cw || fJ.t < cw.t);
    if (fFirst && fJ) {
      const oppI = cw && cw.dir !== fJ.dir ? cw.i : undefined;
      const oppPx = cw && cw.dir !== fJ.dir ? cw.px : undefined;
      scoutPnl = tr(fJ.i, fJ.dir, fJ.px, 0.3, oppI, oppPx);
      pnl += scoutPnl;
      let held = 0.3;
      let progI: number | null = null;
      if (fJ.i + 5 < bars.length && (bars[fJ.i + 5].close - fJ.px) * fJ.dir >= 0.1 * r10) progI = fJ.i + 5;
      let advI: number | null = null;
      for (let k = fJ.i + 1; k < bars.length; k++) {
        if ((bars[k].close - fJ.px) * fJ.dir >= 0.3 * r10) { advI = k; break; }
      }
      type Ev = { i: number; target: number; px: number };
      const evs: Ev[] = [];
      if (progI !== null) evs.push({ i: progI, target: 0.7, px: bars[progI].close });
      if (advI !== null) evs.push({ i: advI, target: 1.0, px: bars[advI].close });
      if (cw && cw.dir === fJ.dir) evs.push({ i: cw.i, target: 1.0, px: cw.px });
      evs.sort((a, b) => a.i - b.i);
      for (const ev of evs) {
        if (oppI !== undefined && ev.i >= oppI) break;
        const add = ev.target - held;
        if (add <= 0) continue;
        pnl += tr(ev.i, fJ.dir, ev.px, add, oppI, oppPx);
        held = ev.target;
      }
      if (cw && cw.dir !== fJ.dir) pnl += tr(cw.i, cw.dir, cw.px, 1.0);
    } else if (cw) {
      const fOpp = fJ && fJ.dir !== cw.dir;
      pnl += tr(cw.i, cw.dir, cw.px, 1.0, fOpp ? fJ!.i : undefined, fOpp ? fJ!.px : undefined);
    }
    res.push({ date: daily[i].date, pnl, scoutPnl, cut });
  }

  // ① 클러스터링 검정
  const cutDays = res.filter((r) => r.cut).length;
  const base = cutDays / res.length;
  let afterCut = 0, afterCutHit = 0, after2of3 = 0, after2of3Hit = 0;
  for (let i = 1; i < res.length; i++) {
    if (res[i - 1].cut) { afterCut++; if (res[i].cut) afterCutHit++; }
    if (i >= 3 && res.slice(i - 3, i).filter((r) => r.cut).length >= 2) { after2of3++; if (res[i].cut) after2of3Hit++; }
  }
  console.log(`컷 발생일 ${cutDays}/${res.length} (기저율 ${(100 * base).toFixed(0)}%)`);
  console.log(`P(컷|어제 컷) = ${(100 * afterCutHit / afterCut).toFixed(0)}% (${afterCutHit}/${afterCut}) · P(컷|최근3일 컷≥2) = ${(100 * after2of3Hit / after2of3).toFixed(0)}% (${after2of3Hit}/${after2of3})`);

  // ② K·M 격자 — 방어 스케줄은 전일까지의 컷 플래그만 사용 (무선견)
  const july = (r: DayR) => r.date.startsWith("2026-07");
  const baseTotal = res.reduce((a, r) => a + r.pnl, 0);
  const baseJuly = res.filter(july).reduce((a, r) => a + r.pnl, 0);
  console.log(`\n기준(브레이커 없음): 합 ${baseTotal.toFixed(1)}%p · 7월 ${baseJuly.toFixed(1)}%p · 최악일 ${Math.min(...res.map((r) => r.pnl)).toFixed(2)}%`);
  console.log("\nK(관찰일)·M(컷 문턱)·모드별 — 합 / 7월 / 최악일 / 방어일수");
  for (const mode of ["정찰절반", "전체절반"] as const) {
    for (const K of [3, 5, 7]) {
      for (const M of [2, 3, 4]) {
        if (M > K) continue;
        let total = 0, julySum = 0, worst = 0, defN = 0;
        for (let i = 0; i < res.length; i++) {
          const recent = res.slice(Math.max(0, i - K), i).filter((r) => r.cut).length;
          const def = recent >= M;
          if (def) defN++;
          const p = def ? (mode === "전체절반" ? res[i].pnl * 0.5 : res[i].pnl - 0.5 * res[i].scoutPnl) : res[i].pnl;
          total += p;
          if (july(res[i])) julySum += p;
          worst = Math.min(worst, p);
        }
        console.log(`${mode} K=${K} M=${M}: 합 ${total >= 0 ? "+" : ""}${total.toFixed(1)}%p (${(total - baseTotal) >= 0 ? "+" : ""}${(total - baseTotal).toFixed(1)}) · 7월 ${julySum >= 0 ? "+" : ""}${julySum.toFixed(1)}%p · 최악일 ${worst.toFixed(2)}% · 방어 ${defN}일`);
      }
    }
  }
  console.log("\n주: 정찰절반 = 방어일 정찰 30→15%(증액 단계 불변) / 전체절반 = 방어일 전 트랜치 ×0.5. 재진입 100% 기준 시뮬.");
}
main().catch((e) => { console.error(e); process.exit(1); });
