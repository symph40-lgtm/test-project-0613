// 피셔F 상수 이식 검증 (사용자 제안 2026-08-01 "공통날의 F 기준값을 현재 F 상수로 이식하면 어때"):
//   npx tsx scripts/f-strict-sweep.ts
// 가설: 공통날(창판정 동의)의 품질이 F 상수(오프셋·확인봉)를 조이는 것으로 재현되는가.
// 하닉 227일 — 하루 첫 판정, 스탑 -2.5%·종가 보유(범주 품질표와 동일 지표).
// 각 변형의 ①품질 ②진입일이 공통집합(창판정 동의 90일)과 겹치는 정도(정밀도·재현율)를 측정.

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

type FirstJ = { i: number; dir: 1 | -1; px: number } | null;
function fisherFirst(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, emMult: number): FirstJ {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = tMin("10:30");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = emMult > 1 && tMin(b.time) < emUntil ? emMult : 1;
    const aUp = orH + off * r10 * em, aDn = orL - off * r10 * em, sbW = sb * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf);
    }
    if (up >= conf) return { i, dir: 1, px: b.close };
    if (dn >= conf) return { i, dir: -1, px: b.close };
  }
  return null;
}

type Day = { bars: MinuteBar[]; r10: number; close: number; common: boolean; cwDir: 1 | -1 | 0 };

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  const days: Day[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    const cwDir: 1 | -1 | 0 = trs.length ? (trs[0].to === "up" ? 1 : -1) : 0;
    const fLive = fisherFirst(bars, r10, 0.05, 4, 0.1, 3);
    days.push({ bars, r10, close: daily[i].close, common: fLive !== null && cwDir !== 0 && fLive.dir === cwDir, cwDir });
  }
  const commonN = days.filter((d) => d.common).length;
  console.log(`일수 ${days.length} · 공통집합(라이브 F ∩ 창판정 동의) ${commonN}일`);

  const evalVar = (label: string, off: number, conf: number, sb: number, em: number, onlyCommon = false) => {
    const pnls: number[] = [];
    let cuts = 0, inCommon = 0, judged = 0;
    for (const d of days) {
      const j = fisherFirst(d.bars, d.r10, off, conf, sb, em);
      if (!j) continue;
      if (onlyCommon && !d.common) continue;
      judged++;
      if (d.common) inCommon++;
      const s = 2.5 / 100;
      let cut = false;
      for (let i = j.i + 1; i < d.bars.length; i++) {
        const b = d.bars[i];
        if (j.dir === 1 ? b.low <= j.px * (1 - s) : b.high >= j.px * (1 + s)) { cut = true; break; }
      }
      if (cut) cuts++;
      pnls.push(cut ? -2.5 : ((d.close - j.px) / j.px) * 100 * j.dir);
    }
    const n = pnls.length;
    const avg = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
    const win = n ? Math.round((100 * pnls.filter((v) => v > 0).length) / n) : 0;
    const sum = pnls.reduce((a, b) => a + b, 0);
    console.log(`${label} ${String(n).padStart(3)}일 평균 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%·승률 ${String(win).padStart(3)}%·컷률 ${String(n ? Math.round((100 * cuts) / n) : 0).padStart(3)}%·합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1).padStart(6)}%p · 공통집합 정밀도 ${n ? Math.round((100 * inCommon) / n) : 0}%·재현율 ${Math.round((100 * inCommon) / commonN)}%`);
  };

  console.log("\n[기준선]");
  evalVar("F 라이브(0.05·4봉·완충3)      ", 0.05, 4, 0.1, 3);
  evalVar("F 라이브 ∩ 공통날만 (목표 품질)", 0.05, 4, 0.1, 3, true);
  console.log("\n[상수 조임 스윕 — 오프셋·확인봉·강돌파·완충]");
  for (const off of [0.05, 0.075, 0.1, 0.15]) {
    for (const conf of [4, 6, 8, 10]) {
      evalVar(`off ${off.toFixed(3)} conf ${String(conf).padStart(2)}          `, off, conf, 0.1, 3);
    }
  }
  evalVar("off 0.05 conf 4 강돌파 없음    ", 0.05, 4, 0, 3);
  evalVar("off 0.10 conf 8 강돌파 없음    ", 0.10, 8, 0, 3);
  evalVar("off 0.05 conf 4 완충 없음      ", 0.05, 4, 0.1, 1);
  console.log("\n주: 정밀도 = 그 변형의 진입일 중 공통집합 비율, 재현율 = 공통집합 중 그 변형이 진입한 비율.");
  console.log("공통집합 품질이 상수 조임으로 재현되면 이식 가능, 안 되면 창판정 정보는 상수와 직교 → 병행 필수.");
}
main().catch((e) => { console.error(e); process.exit(1); });
