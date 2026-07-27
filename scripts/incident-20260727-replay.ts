// 2026-07-27 라이브 사고 재현 (사용자 보고 3건):
//   ① 하닉 10:14 "F·M 인버스 소멸" 문자 — 상태기계상 확인 후 none 복귀 불가 → 데이터 결손 의심.
//      전체 데이터로 10:14 컷 재판정 + 프리장(NXT) 결손 시나리오 대조.
//   ② 삼전 12:50~ 반등에 인버스 유지 — 본피셔 C반전 도달 불가(앵커=아침 OR) + 트레일 미적용
//      + 분봉 fetch가 judgeHour(14:00) 캡이라 확정 후 모니터(~15:25)가 동결되는지 확인.
//   ③ 삼전 hxTrail(0.5×폭·3봉) 적용 시 오늘 전환 시각·손익 차이 실측.
//   npx tsx scripts/incident-20260727-replay.ts [--date 2026-07-27]

import { readFileSync } from "fs";
import { resolve } from "path";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { runFisher } from "../lib/predict/models/fisher";
import { isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import type { MinuteBar, PredictDailyBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DATE = (() => { const i = args.indexOf("--date"); return i >= 0 ? args[i + 1] : "2026-07-27"; })();
const YMD = DATE.replace(/-/g, "");
const lab = (v: Verdict) => (v === "leverage" ? "레버" : v === "inverse" ? "인버" : "없음");

type Sym = { code: string; ko: string; sb: number };
const HX: Sym = { code: "000660", ko: "하닉", sb: PREDICT_CONFIG.earlyStrongBreakRatio };
const SS: Sym = { code: "005930", ko: "삼전", sb: PREDICT_CONFIG.ssStrongBreakRatio };

async function load(s: Sym) {
  const daily = await fetchDailyPredict(s.code, 170);
  const complete = daily.filter((b) => b.date < DATE).slice(-120);
  const pre = (await fetchNxtPremarket(s.code, YMD)) ?? [];
  const krx = (await fetchDayMinutes(s.code, YMD, "153000")) ?? [];
  return { complete, pre, krx };
}

// 서비스 ②b 모니터와 동일 규칙으로 컷 시각 t의 F/M/본 상태 계산
function statesAt(s: Sym, complete: PredictDailyBar[], pre: MinuteBar[], krx: MinuteBar[], t: string, opts?: { noPre?: boolean; ssTrail?: boolean }) {
  const cont = [...(opts?.noPre ? [] : pre), ...krx].filter((b) => b.time < t);
  const reg = krx.filter((b) => b.time < t);
  const mk = (bars: MinuteBar[]) => ({ date: DATE, dailyHistory: complete, openPx: bars[0]?.open ?? 0, morning: bars, prevDayMinutes: null });
  const hxTrailOpts = s.code === "000660" && isHighVolDay(complete)
    ? { trailRangeRatio: PREDICT_CONFIG.hxTrail.rangeRatio, trailConfirmMinutes: PREDICT_CONFIG.hxTrail.confirmMinutes }
    : {};
  const ssTrailOpts = opts?.ssTrail ? { trailRangeRatio: PREDICT_CONFIG.hxTrail.rangeRatio, trailConfirmMinutes: PREDICT_CONFIG.hxTrail.confirmMinutes } : {};
  const F = cont.length >= 20
    ? runFisher(mk(cont), { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes, strongBreakRatio: s.code === "000660" ? PREDICT_CONFIG.earlyStrongBreakRatio : s.sb, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes })
    : null;
  const M = cont.length >= 20
    ? runFisher(mk(cont), { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes })
    : null;
  const B = reg.length >= 20
    ? runFisher(mk(reg), { strongBreakRatio: s.code === "000660" ? PREDICT_CONFIG.lateStrongBreakRatio : s.sb, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, ...hxTrailOpts, ...ssTrailOpts })
    : null;
  return { F, M, B, px: reg.length ? reg[reg.length - 1].close : cont.length ? cont[cont.length - 1].close : null };
}

function sweep(s: Sym, complete: PredictDailyBar[], pre: MinuteBar[], krx: MinuteBar[], opts?: { ssTrail?: boolean; dataCapHHMM?: string }) {
  let prev = { F: "none" as Verdict, M: "none" as Verdict, B: "none" as Verdict };
  const out: string[] = [];
  for (let m = 9 * 60 + 5; m <= 15 * 60 + 25; m++) {
    const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const capKrx = opts?.dataCapHHMM ? krx.filter((b) => b.time < opts.dataCapHHMM!) : krx;
    const st = statesAt(s, complete, pre, capKrx, t, opts);
    const cur = { F: st.F?.verdict ?? "none", M: st.M?.verdict ?? "none", B: st.B?.verdict ?? "none" };
    for (const k of ["F", "M", "B"] as const) {
      if (cur[k] !== prev[k]) {
        const o = k === "F" ? st.F : k === "M" ? st.M : st.B;
        out.push(`  ${t} ${k}: ${lab(prev[k])}→${lab(cur[k])} ${st.px?.toLocaleString() ?? "?"}원 — ${(o?.reason ?? "").split(" — ")[0]}`);
      }
    }
    prev = cur;
  }
  return out;
}

async function main() {
  const hx = await load(HX);
  const ss = await load(SS);
  console.log(`═ ${DATE} 재현 — 하닉 분봉 pre ${hx.pre.length}·krx ${hx.krx.length} / 삼전 pre ${ss.pre.length}·krx ${ss.krx.length}`);
  console.log(`  고변동일: 하닉 ${isHighVolDay(hx.complete)} · 삼전 ${isHighVolDay(ss.complete)}`);

  // ① 하닉 10:14 컷 — 라이브(소멸 발송) vs 전체 데이터 vs 프리장 결손
  console.log(`\n① 하닉 10:14 컷 재판정 (라이브 발송: F없음·M없음)`);
  for (const [name, o] of [["전체 데이터", {}], ["프리장(NXT) 결손", { noPre: true }]] as const) {
    const st = statesAt(HX, hx.complete, hx.pre, hx.krx, "10:14", o);
    console.log(`  ${name}: F${lab(st.F?.verdict ?? "none")}·M${lab(st.M?.verdict ?? "none")}·본${lab(st.B?.verdict ?? "none")}  (F: ${(st.F?.reason ?? "").split(" — ")[0]} / M: ${(st.M?.reason ?? "").split(" — ")[0]})`);
  }

  // ② 정상 데이터 기준 전이 타임라인 (수신 문자와 대조)
  console.log(`\n② 하닉 전이 타임라인 (전체 데이터·현행 규칙)`);
  for (const l of sweep(HX, hx.complete, hx.pre, hx.krx)) console.log(l);
  console.log(`\n② 삼전 전이 타임라인 (전체 데이터·현행 규칙 — 트레일 없음)`);
  for (const l of sweep(SS, ss.complete, ss.pre, ss.krx)) console.log(l);
  console.log(`\n②b 삼전 타임라인 — 라이브 조건 재현 (분봉 14:00 캡)`);
  for (const l of sweep(SS, ss.complete, ss.pre, ss.krx, { dataCapHHMM: "14:00" })) console.log(l);

  // ③ 삼전 트레일 적용 시나리오
  console.log(`\n③ 삼전 본피셔 + 트레일(0.5×10일폭·3봉) 타임라인`);
  for (const l of sweep(SS, ss.complete, ss.pre, ss.krx, { ssTrail: true })) console.log(l);

  // ④ 09창 피셔F (반전경보 rev9 판정자 — 0.05·4봉·강돌파·반전3) — 캡 없는 전체 데이터 타임라인
  for (const [s, d] of [[SS, ss], [HX, hx]] as const) {
    let prev: Verdict = "none";
    console.log(`\n④ ${s.ko} 09창 피셔F(반전경보 판정자) 타임라인`);
    for (let m = 9 * 60 + 20; m <= 15 * 60 + 25; m++) {
      const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const reg = d.krx.filter((b) => b.time < t);
      if (reg.length < 20) continue;
      const f9 = runFisher(
        { date: DATE, dailyHistory: d.complete, openPx: reg[0].open, morning: reg, prevDayMinutes: null },
        { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes, strongBreakRatio: s.sb, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes },
      );
      if (f9.verdict !== prev) console.log(`  ${t} F9: ${lab(prev)}→${lab(f9.verdict)} ${reg[reg.length - 1].close.toLocaleString()}원 — ${f9.reason.split(" — ")[0]}`);
      prev = f9.verdict;
    }
  }

  // 오후 흐름 요약 (12:30~종가, 30분 간격 종가)
  const at = (bars: MinuteBar[], t: string) => bars.filter((b) => b.time <= t).slice(-1)[0]?.close;
  console.log(`\n삼전 오후 종가 흐름: 12:30 ${at(ss.krx, "12:30")?.toLocaleString()} · 13:00 ${at(ss.krx, "13:00")?.toLocaleString()} · 13:30 ${at(ss.krx, "13:30")?.toLocaleString()} · 14:00 ${at(ss.krx, "14:00")?.toLocaleString()} · 14:30 ${at(ss.krx, "14:30")?.toLocaleString()} · 15:00 ${at(ss.krx, "15:00")?.toLocaleString()} · 종가 ${ss.krx[ss.krx.length - 1]?.close.toLocaleString()}`);
  console.log(`하닉 오후 종가 흐름: 12:30 ${at(hx.krx, "12:30")?.toLocaleString()} · 13:00 ${at(hx.krx, "13:00")?.toLocaleString()} · 14:00 ${at(hx.krx, "14:00")?.toLocaleString()} · 15:00 ${at(hx.krx, "15:00")?.toLocaleString()} · 종가 ${hx.krx[hx.krx.length - 1]?.close.toLocaleString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
