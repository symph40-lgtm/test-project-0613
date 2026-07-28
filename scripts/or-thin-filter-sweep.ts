// NXT 프리장 저유동 프린트 필터(dropThinPrints) 회귀 검증 (2026-07-28 실측 사고 교정).
//   npx tsx scripts/or-thin-filter-sweep.ts   (.predict-cache 오프라인 + 당일 라이브 리플레이)
//
// ① 캐시 전 일자: 필터 전/후 프리장 봉 수·OR(첫15봉)·피셔F(08창 0.05·4봉+sb)·피셔M(08창 0.10·8봉)
//    전이 시퀀스를 비교 — 필터가 판정을 바꾸는 날이 '오염일'에 국한되는지 확인.
// ② 당일(2026-07-28) 라이브 리플레이: 필터 적용 데이터로 F/M/본이 언제 무엇을 판정했을지 재현.
// 채택 기준 (프로젝트 공통): 정상일 판정 불변 + 오염일만 교정.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { dropThinPrints, fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (file: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};

type St = "none" | "up" | "down";
type Trans = { time: string; to: St; px: number };
// fisher.ts 상태기계 스트리밍판 (f-rejudge-sweep.ts와 동일)
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
const orOf = (bars: MinuteBar[], orN: number) => {
  const or = bars.slice(0, orN);
  return { lo: Math.min(...or.map((b) => b.low)), hi: Math.max(...or.map((b) => b.high)) };
};
const fmtT = (ts: Trans[]) => ts.map((t) => `${t.time}${t.to === "up" ? "레버" : "인버"}`).join("→") || "무판정";

async function sweep(code: string, name: string): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 500)).filter((b) => b.date < today);
  const sbR = code === "005930" ? 0.075 : 0.1;
  let total = 0, dropped = 0, orChanged = 0, fChanged = 0, mChanged = 0;
  const details: string[] = [];
  for (let idx = 30; idx < daily.length; idx++) {
    const date = daily[idx].date;
    const pre = readCache(`${code}NX-${date}.json`);
    const reg = readCache(`${code}-${date}.json`);
    if (!pre || !reg || reg.length < 240) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    if (r10 === null) continue;
    total++;
    const preF = dropThinPrints(pre);
    const nDrop = pre.length - preF.length;
    if (nDrop === 0) continue;
    dropped++;
    const raw = [...pre, ...reg], flt = [...preF, ...reg];
    const orR = orOf(raw, 15), orF = orOf(flt, 15);
    const orDiff = orR.lo !== orF.lo || orR.hi !== orF.hi;
    if (orDiff) orChanged++;
    const sb = sbR * r10;
    const fR = stream(raw, 15, 0.05 * r10, 4, 3, sb), fF = stream(flt, 15, 0.05 * r10, 4, 3, sb);
    const mR = stream(raw, 15, 0.10 * r10, 8, 3, 0), mF = stream(flt, 15, 0.10 * r10, 8, 3, 0);
    const fDiff = fmtT(fR) !== fmtT(fF), mDiff = fmtT(mR) !== fmtT(mF);
    if (fDiff) fChanged++;
    if (mDiff) mChanged++;
    if (orDiff || fDiff || mDiff) {
      details.push(
        `  ${date} 제외 ${nDrop}봉 · OR ${orR.lo.toLocaleString()}~${orR.hi.toLocaleString()} → ${orF.lo.toLocaleString()}~${orF.hi.toLocaleString()}` +
        (fDiff ? `\n    F: ${fmtT(fR)} → ${fmtT(fF)}` : "") +
        (mDiff ? `\n    M: ${fmtT(mR)} → ${fmtT(mF)}` : ""),
      );
    }
  }
  console.log(`\n════ ${name} (${code}) — 캐시 ${total}일 ════`);
  console.log(`필터로 봉 제외된 날 ${dropped}일 · OR 변화 ${orChanged}일 · F 전이 변화 ${fChanged}일 · M 전이 변화 ${mChanged}일`);
  for (const d of details) console.log(d);
  if (!details.length) console.log("  (판정·OR 변화 없음 — 필터 무해)");
}

async function replayToday(code: string, name: string): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const ymd = today.replace(/-/g, "");
  const daily = await fetchDailyPredict(code, 140);
  const hist = daily.filter((b) => b.date < today).slice(-120);
  const r10 = avgRange(hist, 10);
  const pre = (await fetchNxtPremarket(code, ymd)) ?? []; // 필터 적용된 상태
  const reg = (await fetchDayMinutes(code, ymd, "153000")) ?? [];
  console.log(`\n════ 당일(${today}) ${name} 리플레이 — 필터 적용 후 ════`);
  if (r10 === null || pre.length + reg.length < 20) { console.log("데이터 부족"); return; }
  const sb = (code === "005930" ? 0.075 : 0.1) * r10;
  const cont = [...pre, ...reg];
  const or = orOf(cont, 15);
  console.log(`프리장 ${pre.length}봉 (필터 후) · OR(첫15봉) ${or.lo.toLocaleString()}~${or.hi.toLocaleString()} · 오프셋F ${Math.round(0.05 * r10).toLocaleString()}원`);
  console.log(`피셔F(08창): ${fmtT(stream(cont, 15, 0.05 * r10, 4, 3, sb))}`);
  console.log(`피셔M(08창): ${fmtT(stream(cont, 15, 0.10 * r10, 8, 3, 0))}`);
  console.log(`본피셔(09창): ${fmtT(stream(reg, 15, 0.15 * r10, 8, 3, sb))} (트레일 미반영)`);
  const last = reg[reg.length - 1];
  if (last) console.log(`종가 ${last.close.toLocaleString()} (${last.time})`);
}

async function main() {
  await sweep("000660", "하닉");
  await sweep("005930", "삼전");
  await replayToday("000660", "하닉");
  await replayToday("005930", "삼전");
}
main().catch((e) => { console.error(e); process.exit(1); });
