// 레짐×오프셋 격자 실측 (사용자 지시 2026-07-25 — 설계 기준 4번 "당일 레짐 유형 발견 +
// 레짐별 피셔 파라미터 최적화"의 1단계 검증).
//   npx tsx scripts/regime-sweep.ts [--days 224]   (.predict-cache 재사용 — 무통신에 가까움)
//
// 방법:
//   레짐 특징 — 전부 09:15까지 알 수 있는 것만 (선견 금지):
//     vol10  = 10일 평균 일중폭 / 전일 종가 % (변동성 레짐 고저)
//     orPct  = 시초 레인지(09:00~09:15) 폭 / 시가 %
//     gapAbs = |시가 - 전일 종가| / 전일 종가 %
//     preEff = 프리장(NXT 08:00~08:50) 효율비 |순이동|/Σ|봉간이동| (낮음 = 왕복장 조짐)
//     prevTrend = 전일 라벨이 방향이었나 (추세 지속성)
//   버킷: 종목별 3분위 (prevTrend는 2버킷). ⚠ 분위 경계를 전체 표본으로 계산 — 라이브는
//   추적 분위(과거 60일)로 대체해야 하며, 이 실측은 "레짐별 최적 오프셋이 다른가"의 존재 증명용.
//   격자: 본피셔 구조 고정(09:00창·컷 14:00·확인 8봉·강돌파 없음) × 오프셋 7종.
//   지표: 방향적중(라벨 3분류 대비) + 스탑 경제성(첫확인 진입·본주 -1.5% 스탑·종가 청산 %p).
//   채택 후보 기준: 하닉·삼전 모두 + 전반/후반(112일) 모두 같은 방향 개선 (매크로 게이트 선정 원칙).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { labelDay } from "../lib/predict/label";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const OFFSETS = [0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3];
const STOP_PCT = 1.5; // 본주 % (ETF -3% 대응)

const readCache = (file: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const confirmOf = (reason: string): string | null => reason.match(/^(\d{2}:\d{2}) A[상하] 확인/)?.[1] ?? null;

type DayData = {
  date: string; label: Verdict; half: 0 | 1;
  feats: Record<string, number | null>; prevTrend: boolean;
  hist: PredictDailyBar[]; morning: MinuteBar[]; full: MinuteBar[]; dayClose: number;
};

// 첫확인 진입 + 스탑 + 종가 청산 (본주 %)
function pnlStop(full: MinuteBar[], confirmAt: string, dir: Verdict, dayClose: number): number | null {
  if (dir === "none") return null;
  const i = full.findIndex((b) => b.time === confirmAt);
  if (i < 0) return null;
  const entry = full[i].close;
  for (let j = i + 1; j < full.length; j++) {
    if (dir === "leverage" && full[j].low <= entry * (1 - STOP_PCT / 100)) return -STOP_PCT;
    if (dir === "inverse" && full[j].high >= entry * (1 + STOP_PCT / 100)) return -STOP_PCT;
  }
  return ((dayClose - entry) / entry) * 100 * (dir === "leverage" ? 1 : -1);
}

function tertiles(vals: number[]): [number, number] {
  const s = [...vals].sort((a, b) => a - b);
  return [s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)]];
}

async function loadSymbol(code: string): Promise<DayData[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
  const testDays = daily.slice(-DAYS);
  const out: DayData[] = [];
  for (const bar of testDays) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const krx = readCache(`${code}-${bar.date}.json`);
    if (!krx || krx.length < 240) continue;
    const hist = daily.slice(Math.max(0, idx - 120), idx);
    const prev = daily[idx - 1];
    const range10 = avgRange(hist, 10);
    if (range10 === null || !prev) continue;
    const pre = readCache(`${code}NX-${bar.date}.json`);
    const or = krx.slice(0, 15);
    const orPct = ((Math.max(...or.map((b) => b.high)) - Math.min(...or.map((b) => b.low))) / krx[0].open) * 100;
    let preEff: number | null = null;
    if (pre && pre.length >= 20) {
      let sum = 0;
      for (let i = 1; i < pre.length; i++) sum += Math.abs(pre[i].close - pre[i - 1].close);
      preEff = sum > 0 ? Math.abs(pre[pre.length - 1].close - pre[0].open) / sum : null;
    }
    out.push({
      date: bar.date, label: labelDay(bar).label, half: 0,
      feats: {
        vol10: (range10 / prev.close) * 100,
        orPct,
        gapAbs: Math.abs(((krx[0].open - prev.close) / prev.close) * 100),
        preEff,
      },
      prevTrend: labelDay(prev).label !== "none",
      hist, morning: krx.filter((b) => b.time < "14:00"), full: krx, dayClose: bar.close,
    });
  }
  out.forEach((d, i) => { d.half = i < out.length / 2 ? 0 : 1; });
  return out;
}

type Cell = { n: number; dirT: number; dirC: number; pnl: number; pnlH: [number, number]; dirH: [[number, number], [number, number]] };

function sweep(days: DayData[], code: string, name: string): void {
  console.log(`\n════ ${name} (${code}) — ${days.length}일 ════`);
  // 오프셋별 판정 사전 계산 (일×오프셋)
  const judged = new Map<string, { verdict: Verdict; at: string | null }>();
  for (const d of days) {
    for (const off of OFFSETS) {
      const o = runFisher(
        { date: d.date, dailyHistory: d.hist, openPx: d.morning[0].open, morning: d.morning, prevDayMinutes: null },
        { offsetRangeRatio: off },
      );
      judged.set(`${d.date}|${off}`, { verdict: o.verdict, at: confirmOf(o.reason) });
    }
  }
  const cellOf = (sel: DayData[], off: number): Cell => {
    const c: Cell = { n: sel.length, dirT: 0, dirC: 0, pnl: 0, pnlH: [0, 0], dirH: [[0, 0], [0, 0]] };
    for (const d of sel) {
      const j = judged.get(`${d.date}|${off}`)!;
      if (j.verdict === "none") continue;
      c.dirT++; c.dirH[d.half][1]++;
      if (j.verdict === d.label) { c.dirC++; c.dirH[d.half][0]++; }
      const p = j.at ? pnlStop(d.full, j.at, j.verdict, d.dayClose) : null;
      if (p !== null) { c.pnl += p; c.pnlH[d.half] += p; }
    }
    return c;
  };
  const fmtCell = (c: Cell) =>
    `${String(c.dirT).padStart(3)}회 ${c.dirT ? String(Math.round((100 * c.dirC) / c.dirT)).padStart(3) : "  —"}% ${(c.pnl >= 0 ? "+" : "") + c.pnl.toFixed(1).padStart(5)}`;

  const buckets: { feat: string; bname: string; sel: DayData[] }[] = [];
  for (const feat of ["vol10", "orPct", "gapAbs", "preEff"]) {
    const withVal = days.filter((d) => d.feats[feat] !== null);
    const [t1, t2] = tertiles(withVal.map((d) => d.feats[feat]!));
    buckets.push({ feat, bname: `하위⅓(<${t1.toFixed(2)})`, sel: withVal.filter((d) => d.feats[feat]! < t1) });
    buckets.push({ feat, bname: `중위⅓`, sel: withVal.filter((d) => d.feats[feat]! >= t1 && d.feats[feat]! < t2) });
    buckets.push({ feat, bname: `상위⅓(≥${t2.toFixed(2)})`, sel: withVal.filter((d) => d.feats[feat]! >= t2) });
  }
  buckets.push({ feat: "prevTrend", bname: "전일 추세일", sel: days.filter((d) => d.prevTrend) });
  buckets.push({ feat: "prevTrend", bname: "전일 무추세", sel: days.filter((d) => !d.prevTrend) });
  buckets.push({ feat: "(전체)", bname: "전체", sel: days });

  console.log(`오프셋 →        ${OFFSETS.map((o) => String(o).padEnd(15)).join("")}`);
  let lastFeat = "";
  for (const b of buckets) {
    if (b.feat !== lastFeat) { console.log(`── ${b.feat} ──`); lastFeat = b.feat; }
    const cells = OFFSETS.map((o) => cellOf(b.sel, o));
    console.log(`${b.bname.padEnd(14)} ${cells.map(fmtCell).join("  ")}   (n=${b.sel.length})`);
    // 최적 오프셋 (누적 기준, 방향 10회↑) — 전반/후반 일치 여부
    const best = (h: 0 | 1 | null) => {
      let bo: number | null = null, bp = -Infinity;
      OFFSETS.forEach((o, i) => {
        const c = cells[i];
        const t = h === null ? c.dirT : c.dirH[h][1];
        const p = h === null ? c.pnl : c.pnlH[h];
        if (t >= (h === null ? 10 : 5) && p > bp) { bp = p; bo = o; }
      });
      return bo;
    };
    const bAll = best(null), b0 = best(0), b1 = best(1);
    // 현행 상수(0.15)의 전·후반 분할 — 게이트(약세 레짐) 후보의 일관성 판정용
    const c15 = cells[OFFSETS.indexOf(0.15)];
    const hf = (h: 0 | 1) => {
      const [c, t] = c15.dirH[h];
      return `${(c15.pnlH[h] >= 0 ? "+" : "") + c15.pnlH[h].toFixed(1)}(${t ? Math.round((100 * c) / t) : "—"}%/${t})`;
    };
    if (bAll !== null) console.log(`  └ 최적(누적): ${bAll} · 전반 ${b0 ?? "—"} / 후반 ${b1 ?? "—"}${b0 !== null && b0 === b1 ? " ✓일치" : ""} | 0.15 반쪽: 전반 ${hf(0)} / 후반 ${hf(1)}`);
  }
}

(async () => {
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    const days = await loadSymbol(code);
    sweep(days, code, name);
  }
  console.log(`\n⚠ 분위 경계는 전체 표본 기준 — 라이브 적용 시 추적 분위(과거 60일)로 재검증 필요.`);
})();
