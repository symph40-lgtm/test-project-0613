// predict_nm_cmp 결손 백필 (사용자 지시 2026-08-08): cmpTo 게이트 버그로 8/6·8/7 hier(기존 계층
// 20/30/50 레그)·l93(0930 사다리) 적재가 누락됨 — 10일 평가(perf10, 8/17 보고)의 하닉 원천.
//   npx tsx scripts/nm-cmp-backfill.ts [--dates 2026-08-06,2026-08-07]
// 산식은 candleWindow.ts ⑥비교 블록을 그대로 미러 (F/M/본 cfg·레그 회계·rebox 사다리).
// lad(신사다리)·def(방어일)는 이미 라이브가 기록한 predict_cw_ladder 값을 재사용 — 재계산하지 않는다.
// KIS 분봉은 과거 120일 조회 가능. 토큰 분당 1회 — 다른 백테스트와 병렬 실행 금지.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
import { unitArr, candleJudgeStream, simLadder } from "../lib/predict/candleWindow";
import { isHighVolDay, avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar } from "../lib/predict/types";

const STOP_PCT = 2.5;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const args = process.argv.slice(2);
const di = args.indexOf("--dates");
const DATES = di >= 0 ? args[di + 1].split(",") : ["2026-08-06", "2026-08-07"];

type Tr = { time: string; to: "up" | "down"; px: number };
function leg(bb: MinuteBar[], tl: Tr[], close: number): number {
  const idx = new Map<string, number>();
  bb.forEach((x, i) => { if (!idx.has(x.time)) idx.set(x.time, i); });
  const s = STOP_PCT / 100;
  let p = 0;
  for (let k = 0; k < tl.length; k++) {
    const t = tl[k];
    const i0 = idx.get(t.time);
    if (i0 === undefined) continue;
    const endI = k + 1 < tl.length ? idx.get(tl[k + 1].time) ?? bb.length : bb.length;
    const dir = t.to === "up" ? 1 : -1;
    let cutHit = false;
    for (let i = i0 + 1; i < endI; i++) {
      if (dir === 1 ? bb[i].low <= t.px * (1 - s) : bb[i].high >= t.px * (1 + s)) { cutHit = true; break; }
    }
    p += cutHit ? -STOP_PCT : (((k + 1 < tl.length ? tl[k + 1].px : close) - t.px) / t.px) * 100 * dir;
  }
  return p;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: lRow } = await sb.from("ops_settings").select("value").eq("key", "predict_cw_ladder").maybeSingle();
  const ladder = (Array.isArray(lRow?.value) ? lRow!.value : []) as { date: string; pnl: number; cut: boolean; def?: boolean }[];
  const { data: cRow } = await sb.from("ops_settings").select("value").eq("key", "predict_nm_cmp").maybeSingle();
  type CmpRow = { date: string; lad: number; l93: number; hier: number; backfilled?: boolean };
  let cArr = (Array.isArray(cRow?.value) ? (cRow!.value as CmpRow[]) : []);
  console.log(`기존 nm_cmp: ${cArr.map(r => r.date).join(", ")}`);

  const daily = await fetchDailyPredict(C.symbol, 140);
  for (const date of DATES) {
    if (cArr.some(r => r.date === date)) { console.log(`${date}: 이미 존재 — 스킵`); continue; }
    const ladRow = ladder.find(r => r.date === date);
    if (!ladRow) { console.log(`${date}: predict_cw_ladder에 라이브 기록 없음 — 스킵 (lad 재계산은 하지 않는다)`); continue; }
    const hist = daily.filter(b => b.date < date).slice(-120);
    const r10 = avgRange(hist, 10);
    if (hist.length < 30 || r10 === null) { console.log(`${date}: 일봉 부족`); continue; }
    const ymd = date.replace(/-/g, "");
    const pre = (await fetchNxtPremarket(C.symbol, ymd)) ?? [];
    const krx = (await fetchDayMinutes(C.symbol, ymd, "153000")) ?? [];
    if (krx.length < 200) { console.log(`${date}: KIS 분봉 부족 (${krx.length}봉)`); continue; }
    const bars = [...pre, ...krx];
    const close = krx[krx.length - 1].close;
    const hv = isHighVolDay(hist);

    const mkIn = (b: MinuteBar[]) => ({ date, dailyHistory: hist, openPx: b[0].open, morning: b, prevDayMinutes: null });
    const fCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
    const fT = (runFisher(mkIn(bars), fCfg).transitions ?? []) as Tr[];
    const mT = (runFisher(mkIn(bars), { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr }).transitions ?? []) as Tr[];
    const bT = (krx.length >= 20 ? runFisher(mkIn(krx), { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes }).transitions ?? [] : []) as Tr[];
    const hier = 0.2 * leg(bars, fT, close) + 0.3 * leg(bars, mT, close) + 0.5 * leg(krx, bT, close);

    const unitS = unitArr(bars, r10).map(u => u * C.newModel.cwUnitScale);
    const trs = candleJudgeStream(bars, unitS);
    const f93 = (runFisher(mkIn(bars), { ...fCfg, ...C.newModel.rebox }).transitions ?? []) as Tr[];
    const idx93 = new Map<string, number>();
    bars.forEach((x, i) => { if (!idx93.has(x.time)) idx93.set(x.time, i); });
    const fj93 = f93.length && idx93.has(f93[0].time)
      ? { t: hm(f93[0].time), i: idx93.get(f93[0].time)!, dir: (f93[0].to === "up" ? 1 : -1) as 1 | -1, px: f93[0].px }
      : null;
    const lad93 = simLadder(bars, r10, close, trs, ladRow.def === true, hv, fj93);
    cArr.push({ date, lad: ladRow.pnl, l93: Math.round(lad93.pnl * 100) / 100, hier: Math.round(hier * 100) / 100, backfilled: true });
    console.log(`${date}: lad ${ladRow.pnl}(라이브 기록) · l93 ${lad93.pnl.toFixed(2)} · hier ${hier.toFixed(2)} — 백필`);
  }
  cArr = cArr.sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  const { error } = await sb.from("ops_settings").upsert({ key: "predict_nm_cmp", value: cArr, updated_at: new Date().toISOString() }, { onConflict: "key" });
  console.log(error ? `저장 실패: ${error.message}` : `저장 완료 — ${cArr.map(r => `${r.date.slice(5)}${r.backfilled ? "*" : ""}`).join(", ")} (*=백필)`);
}
main();
