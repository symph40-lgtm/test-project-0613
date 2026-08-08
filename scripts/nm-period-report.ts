// 신모델 기간별 성능 (사용자 요청 2026-08-08 "지난 7일·한달·3달·전체, 승률과 컷도, 삼전·하닉·SOXX"):
//   npx tsx scripts/nm-period-report.ts
// 라이브와 같은 산식으로 캐시 전 구간을 재현해 구간별로 자른다.
//   하닉 = 창판정 4단 사다리(눈금1.2) · 삼전 = v2(4봉·tan1.0) · SOXX = v2 주기준(rebox+인버보호+프리진입)
//   국장은 1박(동의일·조기창&비갭 100%/나머지 50%, 8/8 확정) 포함판과 당일청산판을 나란히.
// ⚠캐시 마감일이 라이브보다 뒤처진다(국장 분봉 7/31·SOXXM 8/03) — 그 이후는 ops_settings 라이브 기록 참조.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { candleJudgeStream, unitArr, simLadder, ovnWeight, hxOvnFisherDir } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

// traded = 그날 진입이 있었나(판정일). 무판정일(손익 0)을 분모에 넣으면 승률이 왜곡되므로 분리한다.
// cut = 스탑(손절선) 도달 — 하닉 본주 -2.5%·삼전 -1.5%·SOXX -2%. '판정이 반대로 뒤집힌 날'과는 다르다.
// flip = 방향 반대 신호 발생(전환) — 하닉 창 전환/F 이견, 삼전 F 반대 확인, SOXX F선행일 창1 반대.
// dirHit = 첫 판정 '방향'이 그날 종가 기준으로 맞았나 (판정가 → 종가). 승률(손익>0)과는 다른 개념 —
// 방향이 맞아도 장중에 스탑을 먼저 맞으면 손익은 마이너스가 된다. 둘의 격차가 스탑 비용이다.
type D = { date: string; pnl: number; ovn: number; cut: boolean; traded: boolean; flip: boolean; dirHit: boolean | null };

// 구간 표: 최근 7거래일 / 21(1개월) / 63(3개월) / 전체
function table(name: string, rows: D[], withOvn: boolean) {
  console.log(`\n════ ${name} — ${rows.length}일 (${rows[0]?.date} ~ ${rows[rows.length - 1]?.date}) ════`);
  console.log(`  구간           전체 진입  기간            ${withOvn ? "합계(1박포함)" : "합계     "}   일당    승률   컷일   전환  방향적중  최악일${withOvn ? " | 당일청산만" : ""}`);
  console.log(`  ${" ".repeat(31)}(승률·컷률·전환률은 '진입일' 기준 — 무판정일 제외)`);
  for (const [label, n] of [["최근 7거래일", 7], ["최근 1개월(21)", 21], ["최근 3개월(63)", 63], ["전체", rows.length]] as [string, number][]) {
    const g = rows.slice(-n);
    if (!g.length) continue;
    const t = g.filter((r) => r.traded);          // 진입일만 — 승률·컷률의 정확한 분모
    const tot = g.reduce((a, r) => a + r.pnl + (withOvn ? r.ovn : 0), 0);
    const base = g.reduce((a, r) => a + r.pnl, 0);
    const wins = t.filter((r) => r.pnl + (withOvn ? r.ovn : 0) > 0).length;
    const cuts = t.filter((r) => r.cut).length;
    const flips = t.filter((r) => r.flip).length;
    const dh = t.filter((r) => r.dirHit !== null);
    const dhW = dh.filter((r) => r.dirHit).length;
    const worst = Math.min(...g.map((r) => r.pnl + (withOvn ? r.ovn : 0)));
    const p = (a: number) => `${Math.round((a / Math.max(1, t.length)) * 100)}%`;
    const line = `  ${label.padEnd(14)} ${String(g.length).padStart(3)} ${String(t.length).padStart(4)}  ${g[0].date}~${g[g.length - 1].date.slice(5)}  ${s1(tot).padStart(7)}%p ${s2(tot / g.length).padStart(6)} ${p(wins).padStart(6)} ${p(cuts).padStart(6)} ${p(flips).padStart(6)} ${(dh.length ? `${Math.round((dhW / dh.length) * 100)}%` : "—").padStart(7)} ${worst.toFixed(2).padStart(7)}`;
    console.log(withOvn ? `${line} | ${s1(base).padStart(7)}%p` : line);
  }
}

function collectKr(code: string): { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar }[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: ReturnType<typeof collectKr> = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d });
    daily.push(d);
  }
  return out;
}

function runKr(name: string, code: string, isHx: boolean) {
  const days = collectKr(code);
  const cuts: boolean[] = []; const rows: D[] = [];
  for (let i = 0; i < days.length; i++) {
    const D0 = days[i], next = days[i + 1];
    const unitS = unitArr(D0.bars, D0.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D0.bars, unitS) : cumStream(D0.bars, unitArr(D0.bars, D0.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const prevClose = D0.hist[D0.hist.length - 1].close;
    const gapBig = Math.abs(((D0.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const ssF = D0.bars.length >= 20 ? (runFisher({ date: D0.date, dailyHistory: D0.hist, openPx: D0.bars[0].open, morning: D0.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const ssIdx = ssF.length ? D0.bars.findIndex(b => b.time === ssF[0].time) : -1;
    const ssJ = ssF.length && ssIdx >= 0 ? { i: ssIdx, t: hm(ssF[0].time), dir: (ssF[0].to === "up" ? 1 : -1) as 1 | -1, px: ssF[0].px } : null;
    const r = isHx
      ? simLadder(D0.bars, D0.r10, D0.d.close, trs, defense, isHighVolDay(D0.hist))
      : simV2(D0.bars, D0.r10, D0.d.close, C.newModel.ssV2.tan, ssJ, C.newModel.ssV2.win);
    cuts.push(r.pnl <= -2.4);
    // 1박 레그 (확정 사양)
    let ovn = 0;
    const first = trs.length ? trs[0] : null;
    if (first && next && r.pnl > -2.4) {
      const dir = first.to === "up" ? 1 : -1;
      const t1 = hm(D0.bars[first.i].time);
      const fDir = isHx ? hxOvnFisherDir(D0.bars, D0.hist, D0.date) : (ssJ ? ssJ.dir : 0);
      const fLeadSkip = !isHx && ssJ !== null && ssJ.t < t1;
      if (fDir === dir && !fLeadSkip) ovn = ((next.d.open - D0.d.close) / D0.d.close) * 100 * dir * ovnWeight(t1, gapBig);
    }
    // 진입 여부·전환 여부 (라이브 규칙 미러)
    const cwJ = first ? { i: first.i, t: hm(D0.bars[first.i].time), dir: (first.to === "up" ? 1 : -1) as 1 | -1 } : null;
    const fLead = isHx ? null : ssJ; // 삼전은 F 선행일 관망
    const traded = isHx
      ? !!(cwJ || hxOvnFisherDir(D0.bars, D0.hist, D0.date) !== 0)
      : !!cwJ && !(fLead && cwJ && fLead.t < cwJ.t);
    const cwFlip = trs.find((x) => cwJ && x.i > cwJ.i && x.to !== first!.to) ?? null;
    const fOpp = ssJ && cwJ && ssJ.dir !== cwJ.dir && ssJ.t > cwJ.t;
    const flip = isHx
      ? !!(fOpp || (isHighVolDay(D0.hist) && cwFlip))   // F 이견 청산·역진입 또는 고변동일 창 전환청산
      : !!fOpp;                                          // 삼전 = F 반대 확인 시 전량 전환
    const entryPx = cwJ ? trs[0].px : (ssJ ? ssJ.px : null);
    const entryDir = cwJ ? cwJ.dir : (ssJ ? ssJ.dir : null);
    const dirHit = entryPx !== null && entryDir !== null ? (D0.d.close - entryPx) * entryDir > 0 : null;
    rows.push({ date: D0.date, pnl: r.pnl, ovn, cut: r.cut, traded, flip, dirHit });
  }
  table(name, rows, true);
}

async function runSoxx() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date); const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const rows: D[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const j = judgeSoxxDay(date, raw, hist, r10, C.newModel.rebox);
    if (!j.c1 && !j.fJ) continue;
    const next = dIdx.find((x) => x > date);
    const sc = scoreSoxxDay(raw, j.c1, j.fJ, reg[reg.length - 1].close, next ? dBy.get(next)!.open : null, true, true);
    // SOXX 전환 = F 선행일에 창1이 반대로 와 전량 전환한 날(E1). 창1 선행일은 설계상 낮 행동 없음.
    const flip = sc.kind === "f" && !!j.c1 && !!j.fJ && j.c1.dir !== j.fJ.dir;
    const dh = sc.base !== null && sc.dir !== null ? (reg[reg.length - 1].close - sc.base) * sc.dir > 0 : null;
    rows.push({ date, pnl: sc.p, ovn: 0, cut: sc.cut, traded: sc.kind !== "none", flip, dirHit: dh });
  }
  table("SOXX v2 (주기준: rebox+인버보호+프리장 확인가 진입 · SOXX 기준 %, 3x ETF는 ×3)", rows, false);
}

// 캐시 이후 구간 = 라이브 실기록 (ops_settings에 매일 저장된 채점)
async function runLive() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data } = await sb.from("ops_settings").select("key,value").in("key", ["predict_cw_ladder", "predict_ssv2_scores", "uspredict_v2_scores"]);
  const by = new Map((data ?? []).map((r) => [r.key as string, r.value as Record<string, unknown>[]]));
  console.log(`\n════ 라이브 실기록 (ops_settings — 캐시 이후 구간·당일청산 기준, 1박은 8/8 배포라 미포함) ════`);
  for (const [key, nm] of [["predict_cw_ladder", "하이닉스(사다리)"], ["predict_ssv2_scores", "삼성전자 v2"], ["uspredict_v2_scores", "SOXX v2"]] as [string, string][]) {
    const arr = (by.get(key) ?? []) as { date: string; pnl?: number; p?: number; cut?: boolean }[];
    if (!arr.length) { console.log(`  ${nm}: 기록 없음`); continue; }
    const v = arr.map((r) => ({ date: r.date, p: r.pnl ?? r.p ?? 0, cut: !!r.cut }));
    const tot = v.reduce((a, r) => a + r.p, 0);
    const wins = v.filter((r) => r.p > 0).length, cuts = v.filter((r) => r.cut).length;
    console.log(`  ${nm.padEnd(16)} ${v.length}일 (${v[0].date}~${v[v.length - 1].date}) 합계 ${s1(tot)}%p · 일당 ${s2(tot / v.length)} · 승률 ${Math.round((wins / v.length) * 100)}% · 컷 ${cuts}일 · 최악 ${Math.min(...v.map((r) => r.p)).toFixed(2)}`);
    console.log(`    ${v.map((r) => `${r.date.slice(5)} ${s2(r.p)}${r.cut ? "컷" : ""}`).join(" · ")}`);
  }
}

async function main() {
  runKr("하이닉스 신모델 (창판정+4단 사다리, 눈금1.2 · 본주 %)", "000660", true);
  runKr("삼성전자 신모델 v2 (4봉·tan1.0 · 본주 %)", "005930", false);
  await runSoxx();
  await runLive();
  console.log(`\n⚠ 캐시 마감: 국장 분봉 7/31 · SOXXM 8/03 — 그 이후 실거래일은 ops_settings 라이브 기록(predict_cw_ladder·predict_ssv2_scores·uspredict_v2_scores)으로 별도 확인.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
