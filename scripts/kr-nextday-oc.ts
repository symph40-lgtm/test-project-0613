// "갭은 못 잡아도 그 후 장중 흐름은 참고할 수 있지 않나" 검증 (사용자 제안 2026-08-08):
//   npx tsx scripts/kr-nextday-oc.ts
// 예측 대상을 '갭'이 아니라 익일 시가→종가(r_oc)로 바꾼다. 갭은 오늘까지의 실측에서 예측 불가였지만,
// r_oc는 09:00 개장 시점에 이미 아는 정보(간밤 미장 결과·갭 자체·전날 국장 신호)로 맞출 수 있는지는
// 별개 질문이다. M7 축1(간밤 매크로) 계열을 다음날 일봉 예측에 쓰자는 제안의 전제 검증.
// 각 요인은 'r_oc가 시작되기 전에 아는 값'만 쓴다 — 미래 정보 없음.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { candleJudgeStream, unitArr, hxOvnFisherDir } from "../lib/predict/candleWindow";
import { cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };
function collect(code: string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
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

type Row = {
  date: string; rOC: number;          // 익일 시가→종가 % (예측 대상)
  gap: number;                        // 익일 갭 % (09:00에 아는 값)
  sox: number | null;                 // 간밤 미장 등락 % (05:00에 아는 값)
  prevDir: number;                    // 전날 국장 창1 방향
  agree: boolean;                     // 전날 창1·F 동의 여부
  prevRet: number;                    // 전날 국장 등락 %
  prevPos: number;                    // 전날 종가의 당일 레인지 내 위치 0~1
};

function build(days: Day[], isHx: boolean, soxBy: Map<string, number>): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < days.length; i++) {
    const D = days[i], next = days[i + 1];
    if (!next) continue;
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const ssF = D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fDirSs = ssF.length ? (ssF[0].to === "up" ? 1 : -1) : 0;
    const dir = trs.length ? (trs[0].to === "up" ? 1 : -1) : 0;
    const fDir = isHx ? hxOvnFisherDir(D.bars, D.hist, D.date) : fDirSs;
    const prevClose = D.hist[D.hist.length - 1].close;
    const rng = Math.max(1e-9, D.d.high - D.d.low);
    out.push({
      date: D.date,
      rOC: ((next.d.close - next.d.open) / next.d.open) * 100,
      gap: ((next.d.open - D.d.close) / D.d.close) * 100,
      sox: soxBy.get(D.date) ?? null,
      prevDir: dir, agree: dir !== 0 && fDir === dir,
      prevRet: ((D.d.close - prevClose) / prevClose) * 100,
      prevPos: (D.d.close - D.d.low) / rng,
    });
  }
  return out;
}

function report(name: string, rows: Row[]) {
  const up = rows.filter(r => r.rOC > 0).length;
  console.log(`\n════ ${name} — ${rows.length}일 ════`);
  console.log(`  예측 대상: 익일 시가→종가(r_oc) · 기저 상승 비율 ${pctOf(up, rows.length)}% · 평균 ${s2(rows.reduce((a, r) => a + r.rOC, 0) / rows.length)}% · |평균| ${(rows.reduce((a, r) => a + Math.abs(r.rOC), 0) / rows.length).toFixed(2)}%`);
  console.log(`  ── 09:00 개장 시점에 아는 요인들의 r_oc 방향 예측력 ──`);
  const test = (label: string, sig: (r: Row) => number) => {
    const g = rows.filter(r => sig(r) !== 0);
    if (g.length < 15) { console.log(`     ${label.padEnd(30)} 표본 ${g.length}일 — 부족`); return; }
    const hit = g.filter(r => r.rOC * sig(r) > 0).length;
    const longs = g.filter(r => sig(r) === 1).length;
    // 방향 구성에 맞춘 기저 (롱 비율×상승기저 + 숏 비율×하락기저)
    const base = (longs * up + (g.length - longs) * (rows.length - up)) / rows.length;
    const avg = g.reduce((a, r) => a + r.rOC * sig(r), 0) / g.length;
    console.log(`     ${label.padEnd(30)} ${String(g.length).padStart(3)}일 · 적중 ${String(pctOf(hit, g.length)).padStart(3)}% · 평균 ${s2(avg).padStart(6)}% · 리프트 ${String(Math.round(((hit - base) / g.length) * 100)).padStart(3)}%p`);
  };
  test("① 간밤 미장(SOX) 방향", r => (r.sox === null ? 0 : r.sox > 0 ? 1 : -1));
  test("② |SOX|≥2%일 때 SOX 방향", r => (r.sox === null || Math.abs(r.sox) < 2 ? 0 : r.sox > 0 ? 1 : -1));
  test("③ 갭 방향 추종(갭업이면 롱)", r => (Math.abs(r.gap) < 0.3 ? 0 : r.gap > 0 ? 1 : -1));
  test("④ 갭 반대(갭업이면 숏 — 되돌림)", r => (Math.abs(r.gap) < 0.3 ? 0 : r.gap > 0 ? -1 : 1));
  test("⑤ 큰 갭(|갭|≥2%) 반대", r => (Math.abs(r.gap) < 2 ? 0 : r.gap > 0 ? -1 : 1));
  test("⑥ 전날 국장 창1 방향", r => r.prevDir);
  test("⑦ 전날 동의일의 창1 방향", r => (r.agree ? r.prevDir : 0));
  test("⑧ 전날 등락 추종", r => (Math.abs(r.prevRet) < 0.5 ? 0 : r.prevRet > 0 ? 1 : -1));
  test("⑨ 전날 강한 마감(위치≥0.7→롱)", r => (r.prevPos >= 0.7 ? 1 : r.prevPos <= 0.3 ? -1 : 0));
  test("⑩ SOX와 갭이 같은 방향일 때", r => (r.sox === null || r.sox * r.gap <= 0 ? 0 : r.gap > 0 ? 1 : -1));
  test("⑪ SOX와 갭이 반대일 때 SOX 방향", r => (r.sox === null || r.sox * r.gap >= 0 ? 0 : r.sox > 0 ? 1 : -1));
}

async function main() {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 2 * 365 * 86400e3), interval: "1d" });
  const q = (r.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
  const soxBy = new Map<string, number>();
  for (let i = 1; i < q.length; i++) {
    const d = (q[i].date instanceof Date ? q[i].date : new Date(q[i].date)).toISOString().slice(0, 10);
    soxBy.set(d, ((q[i].close - q[i - 1].close) / q[i - 1].close) * 100);
  }
  report("하이닉스", build(collect("000660"), true, soxBy));
  report("삼성전자", build(collect("005930"), false, soxBy));
  console.log(`\n  ※ 리프트 = 그 신호의 롱/숏 구성에 맞춘 무조건부 기저 대비 초과 적중. 0이면 정보 없음.`);
}
main();
