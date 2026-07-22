// 미장 예측 스트림 백테스트 — SOXX 프락시 (사용자 지정 2026-07-21 4차: SMH 모델 폐기).
//   npx tsx scripts/us-predict-backtest.ts            # KIS 캐시 재사용
//   npx tsx scripts/us-predict-backtest.ts --refresh  # KIS 5분봉 재수집 (약 4~6분, 레이트리밋 자동 대기)
//
// 데이터 (2026-07-21 실측 — 국장식 220일 분봉 검증은 미국 무료 소스론 불가):
//   ① 야후 5분봉 includePrePost — 최근 60일 캘린더(≈39거래일)가 하드 캡. 분봉 스윕의 주 소스.
//   ② KIS 해외주식 분봉(HHDFS76950200) — 과거 30일 캘린더가 바닥(실측: 페이징이 20260622에서
//      정지). 야후보다 얕아 교차 검증용으로만 사용. .predict-cache/soxx-kis-5m.json 캐시.
//   ③ 야후 일봉 2년 — 220일 검증이 가능한 항목(라벨 분포·|rOC| 스케일·SOXL/SOXS 정합)은 여기서.
//   → 분봉 상수는 39거래일 실측 + 라이브 채점 누적으로 재검증 (국장 220일과 다름을 명시).
// 검증 항목 (국장과 같은 방식, SOXX 변동폭으로 상수 재도출):
//   ⓪ 측정 — RV1 5분봉 |Δ| 분위 · T6 피벗 밀도 · 라벨 임계 분포 · OR 폭 분포
//   ① 프리장 user 모델 (RV1 프리장 적용 여부) ② 정규장 피셔 오프셋 스윕(조기/후기)
//   ③ 스탑 스윕 ④ 확정 컷 분할 검증 + 시각별 사전값 ⑤ OR 버킷별 적중
// 채점: 컷 시점 진입(프리장 컷은 정규장 시가) → 16:00 종가 청산, 스탑 SOXX 기준 %.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import YahooFinance from "yahoo-finance2";
import { runUsFisher, pnlFromCut, ET_OPEN, ET_CLOSE, ET_PRE_START } from "../lib/signal/us/models";
import type { UsBar } from "../lib/signal/us/models";
import { computeSwingStructure } from "../lib/signal/engine/trend";
import type { PredictDailyBar, Verdict } from "../lib/predict/types";

// ── .env.local 로드 (KIS 키)
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const REFRESH = process.argv.includes("--refresh");
const SYMB = "SOXX", EXCD = "NAS";
const CACHE = resolve(process.cwd(), ".predict-cache/soxx-kis-5m.json");
const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── KIS 해외 5분봉 수집 (페이지네이션 · 레이트리밋 자동 대기 · 캐시)
type KisCacheRow = { d: string; t: string; o: number; h: number; l: number; c: number; v: number };
async function kisToken(): Promise<string | null> {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    });
    if (r.ok) return ((await r.json()) as { access_token?: string }).access_token ?? null;
    console.log(`  KIS 토큰 재시도(${r.status}) — 65초 대기`);
    await sleep(65_000);
  }
  return null;
}
async function fetchKis5m(maxPages: number): Promise<KisCacheRow[]> {
  if (!REFRESH && existsSync(CACHE)) {
    const rows = JSON.parse(readFileSync(CACHE, "utf8")) as KisCacheRow[];
    console.log(`KIS 캐시 사용: ${rows.length}봉 (${rows[rows.length - 1]?.d} ~ ${rows[0]?.d}) — 재수집은 --refresh`);
    return rows;
  }
  const tk = await kisToken();
  if (!tk) { console.log("KIS 토큰 실패 — KIS 소스 생략"); return []; }
  const out: KisCacheRow[] = [];
  let keyb = "", next = "";
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${KIS_BASE}/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice`);
    for (const [k, v] of Object.entries({ AUTH: "", EXCD, SYMB, NMIN: "5", PINC: "1", NEXT: next, NREC: "120", FILL: "", KEYB: keyb })) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { authorization: `Bearer ${tk}`, appkey: process.env.KIS_APP_KEY!, appsecret: process.env.KIS_APP_SECRET!, tr_id: "HHDFS76950200", custtype: "P" } });
    if (r.status === 500) { const t = await r.text(); if (t.includes("EGW00201")) { await sleep(1200); page--; continue; } console.log("KIS 500:", t.slice(0, 120)); break; }
    if (!r.ok) { console.log("KIS HTTP", r.status); break; }
    const j = (await r.json()) as { rt_cd?: string; output2?: { xymd?: string; xhms?: string; open?: string; high?: string; low?: string; last?: string; evol?: string }[] };
    if (j.rt_cd !== "0" || !j.output2?.length) break;
    for (const q of j.output2) {
      const o = parseFloat(q.open ?? ""), h = parseFloat(q.high ?? ""), l = parseFloat(q.low ?? ""), c = parseFloat(q.last ?? "");
      if (![o, h, l, c].every((v) => isFinite(v) && v > 0) || !q.xymd || !q.xhms) continue;
      out.push({ d: `${q.xymd.slice(0, 4)}-${q.xymd.slice(4, 6)}-${q.xymd.slice(6, 8)}`, t: q.xhms, o, h, l, c, v: parseFloat(q.evol ?? "0") || 0 });
    }
    const last = j.output2[j.output2.length - 1];
    const nextKeyb = `${last.xymd}${last.xhms}`;
    if (nextKeyb === keyb) break; // 과거 바닥 도달 (실측: 같은 키 반복 반환)
    keyb = nextKeyb;
    next = "1";
    if (page % 40 === 0) console.log(`  KIS 수집 page ${page} — ${out[out.length - 1]?.d}`);
    await sleep(400);
  }
  mkdirSync(resolve(process.cwd(), ".predict-cache"), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(out));
  console.log(`KIS 수집 완료: ${out.length}봉 (${out[out.length - 1]?.d} ~ ${out[0]?.d}) — 캐시 저장`);
  return out;
}

// KIS xhms → ET 5분봉. 시각 기준(봉 시작/종료)은 야후 겹침 구간 정합으로 자동 판정
function kisToBars(rows: KisCacheRow[], shiftMin: number): Map<string, UsBar[]> {
  const byDay = new Map<string, Map<number, UsBar>>();
  for (const r of rows) {
    const hm = parseInt(r.t.slice(0, 2), 10) * 60 + parseInt(r.t.slice(2, 4), 10) + shiftMin;
    if (hm < 0 || hm >= 1440) continue;
    const day = byDay.get(r.d) ?? new Map<number, UsBar>();
    // 페이지 중복 시 첫 값 유지 (최신 페이지가 먼저 온다)
    if (!day.has(hm)) day.set(hm, { etMin: hm, time: `${String(Math.floor(hm / 60)).padStart(2, "0")}:${String(hm % 60).padStart(2, "0")}`, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
    byDay.set(r.d, day);
  }
  const out = new Map<string, UsBar[]>();
  for (const [d, m] of byDay) out.set(d, [...m.values()].sort((a, b) => a.etMin - b.etMin));
  return out;
}

async function fetchYahoo5m(days: number): Promise<Map<string, UsBar[]>> {
  const r = await yf.chart(SYMB, { period1: new Date(Date.now() - days * 86400e3), interval: "5m", includePrePost: true });
  const byDay = new Map<string, UsBar[]>();
  for (const q of r.quotes ?? []) {
    if (q.close == null || q.open == null) continue;
    const d = q.date instanceof Date ? q.date : new Date(q.date);
    const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
    const h = p.hour === "24" ? 0 : parseInt(p.hour, 10);
    const etMin = h * 60 + parseInt(p.minute, 10);
    const day = `${p.year}-${p.month}-${p.day}`;
    const arr = byDay.get(day) ?? [];
    arr.push({ etMin, time: `${String(h).padStart(2, "0")}:${p.minute}`, open: q.open, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close, volume: q.volume ?? 0 });
    byDay.set(day, arr);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.etMin - b.etMin);
  return byDay;
}

async function fetchDaily(symbol: string, days: number): Promise<PredictDailyBar[]> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((x): x is typeof x & { open: number; high: number; low: number; close: number } =>
      x.open != null && x.high != null && x.low != null && x.close != null)
    .map((x) => {
      const d = x.date instanceof Date ? x.date : new Date(x.date);
      const p = Object.fromEntries(etFmt.formatToParts(d).map((y) => [y.type, y.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0 };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

type Day = { date: string; pre: UsBar[]; reg: UsBar[]; hist: PredictDailyBar[]; prevClose: number };
type Score = { trades: number; hits: number; cum: number; stopped: number };
const S0 = (): Score => ({ trades: 0, hits: 0, cum: 0, stopped: 0 });
function addScore(s: Score, day: Day, verdict: Verdict, cutEtMin: number, stopPct: number) {
  if (verdict === "none") return;
  const rOC = ((day.reg[day.reg.length - 1].close - day.reg[0].open) / day.reg[0].open) * 100;
  const { pnl, stopped } = pnlFromCut(day.reg, cutEtMin, verdict, stopPct);
  s.trades++;
  if ((verdict === "leverage" && rOC > 0) || (verdict === "inverse" && rOC < 0)) s.hits++;
  s.cum += pnl;
  if (stopped) s.stopped++;
}
function row(label: string, s: Score): string {
  const hit = s.trades ? `${Math.round((s.hits / s.trades) * 100)}%` : "—";
  const per = s.trades ? (s.cum / s.trades).toFixed(2) : "—";
  return `${label.padEnd(42)} 신호 ${String(s.trades).padStart(3)} · 방향적중 ${hit.padStart(4)} · 스탑누적 ${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(1)}%p · 거래당 ${per}%p · 스탑컷 ${s.stopped}회`;
}
function quantile(v: number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function median(v: number[]): number { return quantile(v, 0.5); }

async function main() {
  console.log(`═══ 미장 예측 스트림 백테스트 — SOXX 프락시 (SOXL 3x / SOXS -3x) ═══\n`);
  const [kisRows, yByDay, dailyAll] = await Promise.all([fetchKis5m(45), fetchYahoo5m(59), fetchDaily(SYMB, 730)]);

  // ── KIS-야후 정합: 겹치는 날의 정규장 종가 시계열로 시각 기준(shift) 자동 판정
  let shift = 0;
  if (kisRows.length > 0) {
    const tryShift = (sh: number): number => {
      const kis = kisToBars(kisRows, sh);
      let match = 0, total = 0;
      for (const [d, ybars] of yByDay) {
        const kbars = kis.get(d);
        if (!kbars) continue;
        const ky = new Map(kbars.map((b) => [b.etMin, b.close]));
        for (const yb of ybars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE)) {
          const kc = ky.get(yb.etMin);
          if (kc === undefined) continue;
          total++;
          if (Math.abs(kc - yb.close) / yb.close < 0.0005) match++;
        }
      }
      return total > 200 ? match / total : 0;
    };
    const m0 = tryShift(0), m5 = tryShift(-5);
    shift = m5 > m0 ? -5 : 0;
    console.log(`KIS 시각 정합: shift 0 → 일치 ${(m0 * 100).toFixed(0)}% · shift -5분 → ${(m5 * 100).toFixed(0)}% ⇒ shift ${shift}분 채택\n`);
  }
  const kisByDay = kisToBars(kisRows, shift);

  // 병합: 야후(더 깊음) 우선, KIS에만 있는 날만 보충 (KIS는 교차 검증 역할)
  const merged = new Map<string, UsBar[]>(yByDay);
  for (const [d, bars] of kisByDay) if (!merged.has(d)) merged.set(d, bars);

  const dailySorted = dailyAll;
  const days: Day[] = [];
  for (const [date, bars] of [...merged.entries()].sort()) {
    const pre = bars.filter((b) => b.etMin >= ET_PRE_START && b.etMin < ET_OPEN);
    const reg = bars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
    const hist = dailySorted.filter((b) => b.date < date).slice(-120);
    if (reg.length < 60 || hist.length < 30) continue;
    days.push({ date, pre, reg, hist, prevClose: hist[hist.length - 1].close });
  }
  console.log(`대상 ${days.length}거래일 (${days[0]?.date} ~ ${days[days.length - 1]?.date})`);
  const rocs = days.map((d) => ((d.reg[d.reg.length - 1].close - d.reg[0].open) / d.reg[0].open) * 100);
  console.log(`정규장 시가→종가: 상승 ${rocs.filter((r) => r > 0).length}/${days.length} · |rOC| 중앙 ${median(rocs.map(Math.abs)).toFixed(2)}%\n`);

  // ── ⓪-1 RV1 임계 — 5분봉 |Δ등락률| 분위 (정규장·프리장 분리)
  console.log("── ⓪ SOXX 5분봉 |Δ| 분위 (RV1 임계 도출 — 한국은 95~99% 분위 채택) ──");
  for (const [name, filt] of [["정규장", (b: UsBar) => b.etMin >= ET_OPEN], ["프리장", (b: UsBar) => b.etMin < ET_OPEN]] as const) {
    const d1: number[] = [], d3: number[] = [], d5: number[] = [], d7: number[] = [];
    for (const day of days) {
      const bars = (name === "정규장" ? day.reg : day.pre).filter(filt);
      const chg = bars.map((b) => ((b.close - day.prevClose) / day.prevClose) * 100);
      for (let i = 1; i < chg.length; i++) {
        d1.push(Math.abs(chg[i] - chg[i - 1]));
        if (i >= 3) d3.push(Math.abs(chg[i] - chg[i - 3]));
        if (i >= 5) d5.push(Math.abs(chg[i] - chg[i - 5]));
        if (i >= 7) d7.push(Math.abs(chg[i] - chg[i - 7]));
      }
    }
    const q = (v: number[]) => `95% ${quantile(v, 0.95).toFixed(2)} · 99% ${quantile(v, 0.99).toFixed(2)}`;
    console.log(`  [${name}] 1개 ${q(d1)} │ 3개합 ${q(d3)} │ 5개합 ${q(d5)} │ 7개합 ${q(d7)} (표본 ${d1.length})`);
  }

  // ── ⓪-2 T6 피벗 밀도 (목표: K200 평상시 밀도 ~9개/일 — SMH 0.4와 동일 원칙)
  console.log("\n── ⓪ T6 피벗 밀도 (정규장 5분봉 지그재그, minAmpPct별 일평균) ──");
  for (const amp of [0.2, 0.3, 0.4, 0.5]) {
    let piv = 0;
    for (const day of days) {
      const sw = computeSwingStructure(day.reg.map((b) => ({ min: b.etMin, px: b.close })), { minAmpPct: amp, tolPct: amp * 0.75 });
      piv += sw.highs + sw.lows;
    }
    console.log(`  minAmp ${amp}% → 일평균 피벗 ${(piv / days.length).toFixed(1)}개`);
  }

  // ── ⓪-3 라벨 임계 분포 (220일 대응 — 일봉 2년 중 최근 220일)
  console.log("\n── ⓪ 라벨 trendMinPct 분포 (최근 220거래일 일봉, pos 0.65/0.35) ──");
  const d220 = dailySorted.slice(-220);
  for (const th of [0.6, 0.7, 0.8, 0.9, 1.0, 1.2]) {
    let lev = 0, inv = 0;
    for (const b of d220) {
      const rOC = ((b.close - b.open) / b.open) * 100;
      const pos = b.high > b.low ? (b.close - b.low) / (b.high - b.low) : 0.5;
      if (rOC >= th && pos >= 0.65) lev++;
      else if (rOC <= -th && pos <= 0.35) inv++;
    }
    console.log(`  ${th.toFixed(1)}%  추세일 ${lev + inv}/220 (${Math.round(((lev + inv) / 220) * 100)}%) — 상방 ${lev} · 하방 ${inv}`);
  }
  const abs220 = d220.map((b) => Math.abs(((b.close - b.open) / b.open) * 100));
  console.log(`  |rOC| 중앙 ${median(abs220).toFixed(2)}% (참고: 하닉 라벨 1.2%)`);

  // ── ① 프리장·조기창 피셔F 스윕 (사용자 지시 2026-07-22: 사용자모델 폐기 → 피셔F 판정자)
  //   창 = 07:00 ET 시작(프리장+정규장 연속봉). 프리장 컷 진입 = 정규장 시가, 정규장 컷 = 컷 시점.
  console.log("\n── ① 조기창 피셔F 스윕 (07:00 창 · 스탑 2.0% · 강돌파 sb) ──");
  const F_CUTS = ["08:30", "09:00", "09:25", "10:00", "10:30", "11:00"];
  for (const off of [0.03, 0.05, 0.075, 0.1]) {
    for (const cb of [1, 2]) {
      for (const sb of [0, 0.1]) {
        const parts: string[] = [];
        for (const cut of F_CUTS) {
          const s = S0();
          for (const day of days) {
            const w = [...day.pre, ...day.reg].filter((b) => b.etMin >= ET_PRE_START && b.etMin + 5 <= hhmmToMin(cut));
            if (w.length < 3 + cb + 1) continue;
            const out = runUsFisher(w, day.hist, off, { confirmBars: cb, strongBreakRatio: sb });
            addScore(s, day, out.verdict, Math.max(hhmmToMin(cut), ET_OPEN), 2.0);
          }
          parts.push(`${cut.slice(0, 5)} ${s.trades}회/${s.trades ? Math.round((s.hits / s.trades) * 100) + "%" : "—"}/${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(1)}`);
        }
        console.log(`  F ${off}·확인${cb}봉·sb${sb}  ${parts.join("  ")}`);
      }
    }
  }

  // ── ①b 피셔M 진위 필터 (한국 실측 대응: F 발화일 중 M 동방향 확인 60% vs 미확인 16%)
  //   정규장 창(09:30) 기준 — F(0.05·1봉·sb0.1) 첫 방향 확인일에서 M(0.10·2봉) 확인 여부별 적중.
  console.log("\n── ①b 피셔M(0.10·2봉) 진위 필터 — F 발화일 분해 ──");
  {
    const sYes = S0(), sNo = S0();
    for (const day of days) {
      const wAll = day.reg;
      const f = runUsFisher(wAll, day.hist, 0.05, { confirmBars: 1, strongBreakRatio: 0.1 });
      if (f.verdict === "none") continue;
      const m = runUsFisher(wAll, day.hist, 0.10, { confirmBars: 2 });
      const rOC = ((day.reg[day.reg.length - 1].close - day.reg[0].open) / day.reg[0].open) * 100;
      const hit = (f.verdict === "leverage" && rOC > 0) || (f.verdict === "inverse" && rOC < 0);
      const tgt = m.verdict === f.verdict ? sYes : sNo;
      tgt.trades++;
      if (hit) tgt.hits++;
    }
    console.log(`  M 동방향 확인: ${sYes.trades}일 · F 방향적중 ${sYes.trades ? Math.round((sYes.hits / sYes.trades) * 100) + "%" : "—"}`);
    console.log(`  M 미확인/반대: ${sNo.trades}일 · F 방향적중 ${sNo.trades ? Math.round((sNo.hits / sNo.trades) * 100) + "%" : "—"}`);
  }

  // ── ② 정규장 피셔 오프셋 스윕
  const CUTS = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30"];
  const RATIOS = [0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3];
  console.log("\n── ② 정규장 피셔 오프셋 스윕 — 컷별 (오프셋 = ratio × avgRange10 · 스탑 1.0%) ──");
  const perCut = new Map<string, Map<number, Score>>();
  for (const cut of CUTS) perCut.set(cut, new Map(RATIOS.map((r) => [r, S0()])));
  for (const day of days) {
    for (const cut of CUTS) {
      const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
      if (w.length < 6) continue;
      for (const ratio of RATIOS) {
        const out = runUsFisher(w, day.hist, ratio);
        addScore(perCut.get(cut)!.get(ratio)!, day, out.verdict, hhmmToMin(cut), 1.0);
      }
    }
  }
  for (const cut of CUTS) {
    const line = RATIOS.map((r) => {
      const s = perCut.get(cut)!.get(r)!;
      const hit = s.trades ? `${Math.round((s.hits / s.trades) * 100)}%` : "—";
      return `${r}→${String(s.trades).padStart(3)}회/${hit.padStart(4)}/${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(1)}`;
    }).join("  ");
    console.log(`  ${cut}  ${line}`);
  }

  // ── ②b 조기/후기 조합 (전 컷 합산)
  console.log("\n── ②b 조기/후기 오프셋 조합 (조기 10:00~11:00 / 후기 11:30~14:30 · 스탑 1.0%) ──");
  for (const [early, late] of [[0.075, 0.15], [0.1, 0.15], [0.15, 0.15], [0.1, 0.2], [0.2, 0.2], [0.15, 0.25]] as const) {
    const s = S0();
    for (const day of days) for (const cut of CUTS) {
      const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
      if (w.length < 6) continue;
      const out = runUsFisher(w, day.hist, cut <= "11:00" ? early : late);
      addScore(s, day, out.verdict, hhmmToMin(cut), 1.0);
    }
    console.log(row(`조기 ${early} / 후기 ${late}`, s));
  }

  // ── ③ 스탑 스윕 (채택 오프셋은 ② 결과 확인 후 아래 SCHEME에 반영)
  const SCHEME = { offset: 0.15 };
  console.log(`\n── ③ 스탑 스윕 (오프셋 ${SCHEME.offset} 균일 · 전 컷 합산) — SOXX % (3x ETF는 ×3) ──`);
  for (const stop of [0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 99]) {
    const s = S0();
    for (const day of days) for (const cut of CUTS) {
      const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
      if (w.length < 6) continue;
      const out = runUsFisher(w, day.hist, SCHEME.offset);
      addScore(s, day, out.verdict, hhmmToMin(cut), stop);
    }
    console.log(row(stop >= 99 ? "무스탑 (종가 청산만)" : `스탑 SOXX -${stop}% (ETF 3x -${(stop * 3).toFixed(1)}%)`, s));
  }

  // ── ③b 스탑별 일자 분해 — 확정 진입(첫 방향 컷) 기준 최악 역행(MAE) 분포로 스탑 위치 판단
  console.log(`\n── ③b 방향 신호일의 최대 역행(MAE) 분포 (오프셋 ${SCHEME.offset} · 첫 방향 컷 진입) ──`);
  const maes: number[] = [];
  let hitDays = 0, missDays = 0;
  const maeHit: number[] = [], maeMiss: number[] = [];
  for (const day of days) {
    let entry: number | null = null, dirUp = false;
    for (const cut of CUTS) {
      const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
      if (w.length < 6) continue;
      const out = runUsFisher(w, day.hist, SCHEME.offset);
      if (out.verdict === "none") continue;
      const before = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
      entry = before[before.length - 1].close;
      dirUp = out.verdict === "leverage";
      const after = day.reg.filter((b) => b.etMin + 5 > hhmmToMin(cut));
      let mae = 0;
      for (const b of after) {
        const adverse = dirUp ? ((b.low - entry) / entry) * 100 : ((entry - b.high) / entry) * 100;
        if (adverse < mae) mae = adverse;
      }
      const rOC = ((day.reg[day.reg.length - 1].close - day.reg[0].open) / day.reg[0].open) * 100;
      const hit = (dirUp && rOC > 0) || (!dirUp && rOC < 0);
      maes.push(mae);
      (hit ? maeHit : maeMiss).push(mae);
      if (hit) hitDays++; else missDays++;
      break;
    }
  }
  const q = (v: number[], p: number) => { const s2 = [...v].sort((a, b) => a - b); return s2[Math.min(s2.length - 1, Math.floor(p * s2.length))]; };
  console.log(`  방향 신호일 ${maes.length}일 (적중 ${hitDays}·미적중 ${missDays})`);
  console.log(`  전체 MAE: 중앙 ${q(maes, 0.5).toFixed(2)}% · 25% ${q(maes, 0.25).toFixed(2)}% · 10% ${q(maes, 0.1).toFixed(2)}%`);
  if (maeHit.length) console.log(`  적중일 MAE: 중앙 ${q(maeHit, 0.5).toFixed(2)}% · 25% ${q(maeHit, 0.25).toFixed(2)}% · 10% ${q(maeHit, 0.1).toFixed(2)}% — 스탑이 이보다 얕으면 맞은 날을 컷`);
  if (maeMiss.length) console.log(`  미적중일 MAE: 중앙 ${q(maeMiss, 0.5).toFixed(2)}% · 25% ${q(maeMiss, 0.25).toFixed(2)}%`);

  // ── ④ 확정 컷 + 시각별 사전값 (채택 스킴 · 전/후반 분할)
  console.log(`\n── ④ 시각별 슬롯 성적 (오프셋 ${SCHEME.offset} · 스탑 1.0%) — checkpointPriors 도출 ──`);
  const half = Math.floor(days.length / 2);
  for (const cut of CUTS) {
    const parts: string[] = [];
    for (const [seg, arr] of [["전체", days], ["전반", days.slice(0, half)], ["후반", days.slice(half)]] as const) {
      const s = S0();
      for (const day of arr) {
        const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
        if (w.length < 6) continue;
        const out = runUsFisher(w, day.hist, SCHEME.offset);
        addScore(s, day, out.verdict, hhmmToMin(cut), 1.0);
      }
      parts.push(`${seg} ${s.trades}회/${s.trades ? Math.round((s.hits / s.trades) * 100) + "%" : "—"}/${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(1)}`);
    }
    console.log(`  ${cut}  ${parts.join("  │  ")}`);
  }

  // ── ⑤ OR(09:30~09:45) 폭별 적중 (확정 14:30 컷)
  console.log(`\n── ⑤ OR 폭별 적중 (오프셋 ${SCHEME.offset} · 확정 14:30) ──`);
  const orDays = days
    .map((d) => {
      const or = d.reg.slice(0, 3);
      if (or.length < 3) return null;
      return { d, w: ((Math.max(...or.map((b) => b.high)) - Math.min(...or.map((b) => b.low))) / d.reg[0].open) * 100 };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const widths = orDays.map((x) => x.w);
  console.log(`  OR 폭 분포: 중앙 ${quantile(widths, 0.5).toFixed(2)}% · 75% ${quantile(widths, 0.75).toFixed(2)}% · 90% ${quantile(widths, 0.9).toFixed(2)}%`);
  const p90 = quantile(widths, 0.9), p50 = quantile(widths, 0.5);
  for (const [name, lo, hi] of [["calm(<중앙)", 0, p50], ["mid(중앙~90%)", p50, p90], ["wide(≥90%)", p90, 99]] as const) {
    const s = S0();
    for (const { d, w } of orDays) {
      if (w < lo || w >= hi) continue;
      const bars = d.reg.filter((b) => b.etMin + 5 <= hhmmToMin("14:30"));
      if (bars.length < 6) continue;
      const out = runUsFisher(bars, d.hist, SCHEME.offset);
      addScore(s, d, out.verdict, hhmmToMin("14:30"), 1.0);
    }
    console.log(row(`  OR ${name} (${orDays.filter((x) => x.w >= lo && x.w < hi).length}일)`, s));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
