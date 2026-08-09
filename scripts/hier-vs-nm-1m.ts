// 최근 1개월 신모델 vs 기존 피셔 계층 — 3종목 (사용자 질문 2026-08-08):
//   npx tsx scripts/hier-vs-nm-1m.ts [--days 21]
// 같은 분봉·레그 회계로 나란히 잰다 (스탑·전환 반영 — perf10의 방향 프록시보다 정직한 경제성 비교).
//   하닉: 신모델 = 4단 사다리(눈금1.2, 라이브 산식) vs 계층 = F/M/본 레그 20/30/50 (nm_cmp hier와 동일 미러)
//   삼전: 신모델 = v2(4봉) vs 계층 = F/M/본 20/30/50 (삼전 라이브 상수 — 강돌파 0.075·고변동일 트레일 ⚠근사)
//   SOXX: 신모델 = v2 주기준 vs 계층 = us_predict_days 첫 방향 판정×r_oc (⚠스탑 미반영 프록시 — perf10 관례)
// 분봉: 캐시 우선, 8월 결손일은 KIS로 채우고 캐시에 저장(재사용). 토큰 분당 1회 — 병렬 금지.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { createClient } from "@supabase/supabase-js";
import { unitArr, candleJudgeStream, simLadder } from "../lib/predict/candleWindow";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { isHighVolDay, avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import { runFisher } from "../lib/predict/models/fisher";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const args = process.argv.slice(2);
const N = parseInt(args[args.indexOf("--days") + 1] ?? "21", 10) || 21;

type Tr = { time: string; to: "up" | "down"; px: number };
function leg(bb: MinuteBar[], tl: Tr[], close: number, stopPct: number): number {
  const idx = new Map<string, number>();
  bb.forEach((x, i) => { if (!idx.has(x.time)) idx.set(x.time, i); });
  const s = stopPct / 100;
  let p = 0;
  for (let k = 0; k < tl.length; k++) {
    const t = tl[k];
    const i0 = idx.get(t.time);
    if (i0 === undefined) continue;
    const endI = k + 1 < tl.length ? idx.get(tl[k + 1].time) ?? bb.length : bb.length;
    const dir = t.to === "up" ? 1 : -1;
    let cut = false;
    for (let i = i0 + 1; i < endI; i++) {
      if (dir === 1 ? bb[i].low <= t.px * (1 - s) : bb[i].high >= t.px * (1 + s)) { cut = true; break; }
    }
    p += cut ? -stopPct : (((k + 1 < tl.length ? tl[k + 1].px : close) - t.px) / t.px) * 100 * dir;
  }
  return p;
}

async function loadKrDay(code: string, date: string): Promise<{ pre: MinuteBar[]; krx: MinuteBar[] } | null> {
  const regF = resolve(CACHE, `${code}-${date}.json`);
  const preF = resolve(CACHE, `${code}NX-${date}.json`);
  let krx: MinuteBar[] | null = existsSync(regF) ? JSON.parse(readFileSync(regF, "utf8")) : null;
  let pre: MinuteBar[] | null = existsSync(preF) ? JSON.parse(readFileSync(preF, "utf8")) : null;
  const ymd = date.replace(/-/g, "");
  if (!krx || krx.length < 100) {
    krx = await fetchDayMinutes(code, ymd, "153000");
    if (krx && krx.length >= 100) writeFileSync(regF, JSON.stringify(krx));
  }
  if (!pre) {
    pre = await fetchNxtPremarket(code, ymd);
    if (pre && pre.length) writeFileSync(preF, JSON.stringify(pre));
  }
  if (!krx || krx.length < 100) return null;
  return { pre: pre ?? [], krx };
}

async function runKr(code: string, name: string, isHx: boolean, dates: string[]) {
  const daily = await fetchDailyPredict(code, 160);
  type Row = { date: string; nm: number; nmCut: boolean; hier: number };
  const rows: Row[] = [];
  const cuts: boolean[] = [];
  for (const date of dates) {
    const bars0 = await loadKrDay(code, date);
    if (!bars0) { console.log(`  ${date}: 분봉 없음 — 스킵`); continue; }
    const { pre, krx } = bars0;
    const bars = [...pre, ...krx];
    const hist = daily.filter(b => b.date < date).slice(-120);
    const r10 = avgRange(hist, 10);
    if (hist.length < 30 || r10 === null) continue;
    const close = krx[krx.length - 1].close;
    const hv = isHighVolDay(hist);
    const prevClose = hist[hist.length - 1].close;
    const gapBig = Math.abs(((krx[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const mkIn = (b: MinuteBar[]) => ({ date, dailyHistory: hist, openPx: b[0].open, morning: b, prevDayMinutes: null });

    // ── 신모델
    let nm = 0, nmCut = false;
    if (isHx) {
      const unitS = unitArr(bars, r10).map(u => u * C.newModel.cwUnitScale);
      const trs = candleJudgeStream(bars, unitS);
      const r = simLadder(bars, r10, close, trs, defense, hv);
      nm = r.pnl; nmCut = r.cut;
    } else {
      const fT = bars.length >= 20 ? (runFisher(mkIn(bars), ssv2FisherCfg()).transitions ?? []) : [];
      const fi = fT.length ? bars.findIndex(b => b.time === fT[0].time) : -1;
      const fJ = fT.length && fi >= 0 ? { i: fi, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
      const r = simV2(bars, r10, close, C.newModel.ssV2.tan, fJ, C.newModel.ssV2.win);
      nm = r.pnl; nmCut = r.cut;
    }
    cuts.push(nm <= -2.4);

    // ── 계층 (F/M/본 20/30/50) — 하닉은 nm_cmp 미러(정확), 삼전은 라이브 상수 근사
    const sb = isHx ? C.earlyStrongBreakRatio : C.ssStrongBreakRatio;
    const fT2 = (runFisher(mkIn(bars), { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: sb, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr }).transitions ?? []) as Tr[];
    const mT2 = (runFisher(mkIn(bars), { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr }).transitions ?? []) as Tr[];
    const bCfg = isHx
      ? { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes }
      : { strongBreakRatio: C.ssStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, ...(hv ? { trailRangeRatio: C.ssTrail.rangeRatio, trailConfirmMinutes: C.ssTrail.confirmMinutes } : {}) };
    const bT2 = (krx.length >= 20 ? runFisher(mkIn(krx), bCfg).transitions ?? [] : []) as Tr[];
    const stopPct = isHx ? 2.5 : 1.5;
    const hier = 0.2 * leg(bars, fT2, close, stopPct) + 0.3 * leg(bars, mT2, close, stopPct) + 0.5 * leg(krx, bT2, close, stopPct);
    rows.push({ date, nm, nmCut, hier });
  }
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const win = (f: (r: Row) => number) => rows.filter(r => f(r) > 0).length;
  console.log(`\n════ ${name} — ${rows.length}거래일 (${rows[0]?.date} ~ ${rows[rows.length - 1]?.date}) ════`);
  console.log(`  신모델          : 합 ${s1(sum(r => r.nm)).padStart(7)}%p · 일당 ${s2(sum(r => r.nm) / rows.length)} · 승률 ${Math.round(win(r => r.nm) / rows.length * 100)}% · 최악 ${Math.min(...rows.map(r => r.nm)).toFixed(2)}`);
  console.log(`  기존 계층(20/30/50): 합 ${s1(sum(r => r.hier)).padStart(7)}%p · 일당 ${s2(sum(r => r.hier) / rows.length)} · 승률 ${Math.round(win(r => r.hier) / rows.length * 100)}% · 최악 ${Math.min(...rows.map(r => r.hier)).toFixed(2)}`);
  console.log(`  차이(계층−신모델)  : ${s1(sum(r => r.hier - r.nm))}%p · 계층 우세일 ${rows.filter(r => r.hier > r.nm).length}/${rows.length}`);
  console.log(`  일별: ${rows.map(r => `${r.date.slice(5)} ${s1(r.nm)}/${s1(r.hier)}`).join(" · ")}`);
}

async function runSoxx(nDays: number) {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 2 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map(b => b.date); const dBy = new Map(daily.map(b => [b.date, b]));
  const files = readdirSync(CACHE).filter(f => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-(nDays + 3));
  // 계층 프록시: us_predict_days 첫 방향 판정 × r_oc (perf10 관례 — 스탑 미반영)
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: usRows } = await sb.from("us_predict_days").select("date, revisions, r_oc").order("date", { ascending: false }).limit(nDays + 10);
  const hierBy = new Map<string, number>();
  for (const r of (usRows ?? []) as { date: string; revisions: { verdict?: string }[] | null; r_oc: number | null }[]) {
    const first = (r.revisions ?? []).find(v => v.verdict === "leverage" || v.verdict === "inverse");
    if (!first || r.r_oc === null) continue;
    hierBy.set(r.date, (first.verdict === "leverage" ? 1 : -1) * r.r_oc);
  }
  type Row = { date: string; nm: number; hier: number | null };
  const rows: Row[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter(b => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter(b => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter(x => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const j = judgeSoxxDay(date, raw, hist, r10, C.newModel.rebox);
    if (!j.c1 && !j.fJ) continue;
    const next = dIdx.find(x => x > date);
    const sc = scoreSoxxDay(raw, j.c1, j.fJ, reg[reg.length - 1].close, next ? dBy.get(next)!.open : null, true, true);
    rows.push({ date, nm: sc.p, hier: hierBy.get(date) ?? null });
  }
  const last = rows.slice(-nDays);
  const withH = last.filter(r => r.hier !== null) as { date: string; nm: number; hier: number }[];
  console.log(`\n════ SOXX — 최근 ${last.length}판정일 (${last[0]?.date} ~ ${last[last.length - 1]?.date}) ════`);
  console.log(`  신모델(주기준)       : 합 ${s1(last.reduce((a, r) => a + r.nm, 0)).padStart(7)}%p · 일당 ${s2(last.reduce((a, r) => a + r.nm, 0) / last.length)} · 최악 ${Math.min(...last.map(r => r.nm)).toFixed(2)}`);
  if (withH.length >= 10) {
    console.log(`  기존 계층(⚠방향×r_oc 프록시·스탑 미반영): 매칭 ${withH.length}일 · 합 ${s1(withH.reduce((a, r) => a + r.hier, 0))}%p · 같은 날 신모델 ${s1(withH.reduce((a, r) => a + r.nm, 0))}%p`);
  } else {
    console.log(`  기존 계층: us_predict_days 매칭 ${withH.length}일 — 표본 부족 (프록시 산출 불가)`);
  }
}

async function main() {
  // 국장 최근 N거래일 (야후 SOXX 달력이 아니라 국장 자체 캐시+KIS 기준): 000660 일봉에서 최근 N일
  const kd = (await fetchDailyPredict("000660", 60)).map(b => b.date).filter(d => d <= "2026-08-07").slice(-N);
  console.log(`국장 대상 ${kd.length}거래일: ${kd[0]} ~ ${kd[kd.length - 1]}`);
  await runKr("000660", "SK하이닉스 (신모델=사다리 · 계층=F/M/본 — 정확 미러)", true, kd);
  await runKr("005930", "삼성전자 (신모델=v2 · 계층=F/M/본 — ⚠근사 미러)", false, kd);
  await runSoxx(N);
}
main();
