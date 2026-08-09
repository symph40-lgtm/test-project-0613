// 국장 신모델 과거일 재현 리포트 (사용자 요청 2026-08-08 — 8/6 삼전 레버 오진입 검증):
//   npx tsx scripts/kr-nm-day-report.ts --date 2026-08-06
// 그날 분봉으로 삼전 v2(창 4봉·현행)와 대조(5·6봉), 피셔F 전이, 하닉 창판정·F를 시각순으로 재현한다.
// soxx-nm-day-report.ts의 국장판 — 라이브와 같은 코드 경로(cumStream·candleJudgeStream·runFisher).
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import { candleJudgeStream, unitArr } from "../lib/predict/candleWindow";
import { cumStream, ssv2FisherCfg, simV2 } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar } from "../lib/predict/types";

const CACHE = resolve(process.cwd(), ".predict-cache");
const args = process.argv.slice(2);
const DATE = args[args.indexOf("--date") + 1] ?? "2026-08-06";
const YMD = DATE.replace(/-/g, "");
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

async function loadDay(code: string): Promise<{ pre: MinuteBar[]; reg: MinuteBar[] } | null> {
  const regF = resolve(CACHE, `${code}-${DATE}.json`), preF = resolve(CACHE, `${code}NX-${DATE}.json`);
  let reg: MinuteBar[] | null = existsSync(regF) ? JSON.parse(readFileSync(regF, "utf8")) : null;
  let pre: MinuteBar[] | null = existsSync(preF) ? JSON.parse(readFileSync(preF, "utf8")) : null;
  if (!reg) { reg = await fetchDayMinutes(code, YMD, "153000"); if (reg && reg.length >= 100) writeFileSync(regF, JSON.stringify(reg)); }
  if (!pre) { pre = await fetchNxtPremarket(code, YMD); if (pre && pre.length) writeFileSync(preF, JSON.stringify(pre)); }
  if (!reg || reg.length < 100) return null;
  return { pre: pre ?? [], reg };
}

async function main() {
  console.log(`════ 국장 신모델 재현 — ${DATE} ════`);
  for (const [code, nm, isHx] of [["005930", "삼성전자", false], ["000660", "하이닉스", true]] as [string, string, boolean][]) {
    const day = await loadDay(code);
    if (!day) { console.log(`\n── ${nm}: 분봉 없음`); continue; }
    const daily = await fetchDailyPredict(code, 140);
    const hist = daily.filter((b) => b.date < DATE).slice(-120);
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const bars = [...day.pre, ...day.reg];
    const close = day.reg[day.reg.length - 1].close;
    const prevClose = hist[hist.length - 1].close;
    console.log(`\n══ ${nm} — 전일종가 ${prevClose.toLocaleString()} · 시가 ${day.reg[0].open.toLocaleString()}(갭 ${(((day.reg[0].open - prevClose) / prevClose) * 100).toFixed(1)}%) · 종가 ${close.toLocaleString()}(${(((close - day.reg[0].open) / day.reg[0].open) * 100).toFixed(1)}%) ══`);

    // 창 판정 스트림 — 삼전은 win 스윕(4·5·6), 하닉은 창판정
    if (!isHx) {
      for (const win of [4, 5, 6]) {
        const trs = cumStream(bars, unitArr(bars, r10), C.newModel.ssV2.tan, win);
        const first3 = trs.slice(0, 5).map(t => `${bars[t.i].time} ${t.to === "up" ? "상승" : "하락"}@${t.px.toLocaleString()}`);
        const sim = simV2(bars, r10, close, C.newModel.ssV2.tan, null, win);
        console.log(`  창${win}봉${win === C.newModel.ssV2.win ? "(현행)" : "    "} 전이 ${trs.length}회: ${first3.join(" → ")}${trs.length > 5 ? " …" : ""}`);
      }
      // 피셔F (rebox판 — 라이브 검증자)
      const fT = runFisher({ date: DATE, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? [];
      console.log(`  피셔F(rebox): ${fT.length ? fT.map(t => `${t.time} ${t.to === "up" ? "상승" : "하락"}@${t.px.toLocaleString()}`).join(" → ") : "판정 없음"}`);
      // 실채점 (그날 결산과 대조)
      const fIdx = fT.length ? bars.findIndex(b => b.time === fT[0].time) : -1;
      const fJ = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
      for (const win of [4, 5, 6]) {
        const r = simV2(bars, r10, close, C.newModel.ssV2.tan, fJ, win);
        console.log(`  채점 창${win}봉+F: ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}%${r.cut ? " (컷)" : ""}`);
      }
      // 09:00~09:15 가격 경로 (사용자: "09:07 인버스로 갔어야")
      const path = day.reg.filter(b => b.time <= "09:20").map(b => `${b.time} ${b.close.toLocaleString()}`);
      console.log(`  개장 경로: ${path.join(" · ")}`);
    } else {
      const unitS = unitArr(bars, r10).map(u => u * C.newModel.cwUnitScale);
      const trs = candleJudgeStream(bars, unitS);
      console.log(`  창판정(눈금1.2) 전이 ${trs.length}회: ${trs.slice(0, 5).map(t => `${bars[t.i].time} ${t.to === "up" ? "상승" : "하락"}@${t.px.toLocaleString()}`).join(" → ")}${trs.length > 5 ? " …" : ""}`);
      const fCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr, ...C.newModel.rebox };
      const fT = runFisher({ date: DATE, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, fCfg).transitions ?? [];
      console.log(`  피셔F(시행판): ${fT.length ? fT.map(t => `${t.time} ${t.to === "up" ? "상승" : "하락"}@${t.px.toLocaleString()}`).join(" → ") : "판정 없음"}`);
    }
  }
}
main();
