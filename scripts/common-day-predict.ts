// 공통날(피셔F ∩ 창판정 동의) 사전 예측 가능성 실측 (사용자 제안 2026-08-01
// "공통날 기준을 미리 알고 파라미터를 바꾸면 더 좋지 않나" — 레짐 감지·파라미터 적응 축):
//   npx tsx scripts/common-day-predict.ts
// 장 시작 전·초반에 알 수 있는 특징으로 P(오늘 공통) 리프트를 측정. 기저율 ~40%.
// 특징: 전일 공통 여부 / 전일 고저폭 / 전일 몸통 추세 / 시가 갭 / 프리장 순진행(08:50 시점 = 판정 전).

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

function fisherFirst(bars: MinuteBar[], r10: number): { dir: 1 | -1; i: number; px: number } | null {
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
    if (up >= 4) return { dir: 1, i, px: b.close };
    if (dn >= 4) return { dir: -1, i, px: b.close };
  }
  return null;
}

type Rec = {
  common: boolean; fOnly: boolean; pnlF: number | null;
  prevCommon: boolean | null; prevRangeP: number; prevTrendP: number; gapP: number; preNetR: number | null;
};

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  const recs: Rec[] = [];
  let prevCommonFlag: boolean | null = null;
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) { prevCommonFlag = null; continue; }
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const cwDir = trs.length ? (trs[0].to === "up" ? 1 : -1) : 0;
    const fJ = fisherFirst(bars, r10);
    const common = fJ !== null && cwDir !== 0 && fJ.dir === cwDir;
    let pnlF: number | null = null;
    if (fJ) {
      const s = 2.5 / 100;
      let cut = false;
      for (let k = fJ.i + 1; k < bars.length; k++) {
        const b = bars[k];
        if (fJ.dir === 1 ? b.low <= fJ.px * (1 - s) : b.high >= fJ.px * (1 + s)) { cut = true; break; }
      }
      pnlF = cut ? -2.5 : ((daily[i].close - fJ.px) / fJ.px) * 100 * fJ.dir;
    }
    const prev = daily[i - 1];
    const preNetR = pre && pre.length >= 10 ? Math.abs(pre[pre.length - 1].close - pre[0].open) / r10 : null;
    recs.push({
      common, fOnly: fJ !== null && cwDir === 0, pnlF,
      prevCommon: prevCommonFlag,
      prevRangeP: ((prev.high - prev.low) / prev.close) * 100,
      prevTrendP: Math.abs((prev.close - prev.open) / prev.open) * 100,
      gapP: Math.abs((daily[i].open - prev.close) / prev.close) * 100,
      preNetR,
    });
    prevCommonFlag = common;
  }
  const base = recs.filter((r) => r.common).length / recs.length;
  console.log(`일수 ${recs.length} · 공통 기저율 ${(100 * base).toFixed(0)}%`);
  const show = (label: string, sel: (r: Rec) => boolean | null) => {
    const yes = recs.filter((r) => sel(r) === true);
    const no = recs.filter((r) => sel(r) === false);
    const p = (a: Rec[]) => (a.length ? Math.round((100 * a.filter((r) => r.common).length) / a.length) : 0);
    const avgPnl = (a: Rec[]) => {
      const v = a.map((r) => r.pnlF).filter((x): x is number => x !== null);
      return v.length ? (v.reduce((x, y) => x + y, 0) / v.length).toFixed(2) : "—";
    };
    console.log(`${label}: 해당 ${String(yes.length).padStart(3)}일 P(공통) ${String(p(yes)).padStart(3)}%·F평균 ${avgPnl(yes)}% | 비해당 ${String(no.length).padStart(3)}일 P(공통) ${String(p(no)).padStart(3)}%·F평균 ${avgPnl(no)}%`);
  };
  const medOf = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mRange = medOf(recs.map((r) => r.prevRangeP));
  const mTrend = medOf(recs.map((r) => r.prevTrendP));
  const mGap = medOf(recs.map((r) => r.gapP));
  const preVals = recs.map((r) => r.preNetR).filter((x): x is number => x !== null);
  const mPre = medOf(preVals);
  console.log(`중앙값: 전일폭 ${mRange.toFixed(2)}% · 전일추세 ${mTrend.toFixed(2)}% · 갭 ${mGap.toFixed(2)}% · 프리장진행 ${mPre.toFixed(2)}×r10\n`);
  show("전일 공통이었다        ", (r) => r.prevCommon);
  show(`전일 고저폭 > 중앙     `, (r) => r.prevRangeP > mRange);
  show(`전일 몸통추세 > 중앙   `, (r) => r.prevTrendP > mTrend);
  show(`시가 갭 > 중앙         `, (r) => r.gapP > mGap);
  show(`프리장 순진행 > 중앙   `, (r) => (r.preNetR === null ? null : r.preNetR > mPre));
  show(`프리장 순진행 상위 25% `, (r) => {
    if (r.preNetR === null) return null;
    const q = [...preVals].sort((x, y) => x - y)[Math.floor(preVals.length * 0.75)];
    return r.preNetR > q;
  });
  console.log("\n주: P(공통) = 그 조건일 때 그날이 공통날일 확률. F평균 = 피셔F 첫판정·스탑-2.5%·종가보유 평균 손익.");
}
main().catch((e) => { console.error(e); process.exit(1); });
