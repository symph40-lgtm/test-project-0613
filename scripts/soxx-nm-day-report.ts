// SOXX 신모델(통합 사양·수정안) 일별 판정 리포트 — 과거일 재현 + 오늘 라이브 판정 (사용자 질문 2026-08-03 밤):
//   npx tsx scripts/soxx-nm-day-report.ts 2026-07-29 2026-07-30 2026-07-31 today
// 데이터: SOXXM 캐시 우선, 없으면(오늘 등) 야후 1분(includePrePost). 산식은 soxx-bedtime-cutoff.ts와 동일:
//   창1 = 1분 6봉 누적 순전진(tan 1.0·09:30 ET 게이트) / F = 5분봉(07:00~) 피셔 첫 전환(or3·0.05·확인1·반전1·강돌파0.1)
// 규칙(수정안): 먼저 온 신호 100% 진입 → (F선행일만) 창1 반대 시 청산+역진입 → 스탑 -2% → 동의일만 1박(다음날 시가), 그 외 종가.
//   창1 선행일의 F 반대는 낮 행동 없음 — 1박 금지 문지기만 (a24f012).

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const ET_OPEN = 570, ET_CLOSE = 960, STOP = 2.0;
// --pre=HHMM: F 창 시작 시각 변경 실험용 (기본 07:00 — 확정 사양. 예: --pre=0400 프리마켓 개시부터)
const preArg = process.argv.find((a) => a.startsWith("--pre="));
const ET_PRE = preArg ? parseInt(preArg.slice(6, 8), 10) * 60 + parseInt(preArg.slice(8, 10), 10) : 420;
const CACHE = resolve(process.cwd(), ".predict-cache");
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
type Dir = 1 | -1;
type Raw = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
type J = { i: number; t: number; dir: Dir; px: number };
const bmid = (b: Raw) => (b.open + b.close) / 2;

function unitArrL(bars: Raw[], fallback: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : fallback;
    return Math.max(u * 0.5, 1e-9);
  });
}
function to5m(bars: Raw[]): Raw[] {
  const map = new Map<number, Raw>();
  for (const b of bars) {
    const k = Math.floor(b.etMin / 5) * 5;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...map.values()].sort((a, b) => a.etMin - b.etMin);
}

async function fetchYahooDay(date: string): Promise<Raw[]> {
  const p1 = new Date(`${date}T00:00:00-04:00`);
  const p2 = new Date(p1.getTime() + 2 * 86400e3);
  const out: Raw[] = [];
  const r = await yf.chart("SOXX", { period1: p1, period2: p2, interval: "1m", includePrePost: true });
  for (const q of r.quotes ?? []) {
    if (q.close == null || q.open == null || q.high == null || q.low == null) continue;
    const d = q.date instanceof Date ? q.date : new Date(q.date);
    const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` !== date) continue;
    const etMin = parseInt(p.hour === "24" ? "0" : p.hour, 10) * 60 + parseInt(p.minute, 10);
    out.push({ etMin, time: fmtT(etMin), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 });
  }
  return out.sort((a, b) => a.etMin - b.etMin);
}

async function main() {
  const nowP = Object.fromEntries(etFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const todayEt = `${nowP.year}-${nowP.month}-${nowP.day}`;
  const nowEtMin = parseInt(nowP.hour === "24" ? "0" : nowP.hour, 10) * 60 + parseInt(nowP.minute, 10);
  const dates = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((a) => (a === "today" ? todayEt : a));
  if (!dates.length) { console.log("사용법: npx tsx scripts/soxx-nm-day-report.ts <YYYY-MM-DD|today> ..."); return; }

  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 200 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));

  for (const date of dates) {
    const cacheF = resolve(CACHE, `SOXXM-${date}.json`);
    const live = date === todayEt && !existsSync(cacheF);
    const rawAll: Raw[] = existsSync(cacheF) ? (JSON.parse(readFileSync(cacheF, "utf8")) as Raw[]) : await fetchYahooDay(date);
    const raw = rawAll.filter((b) => b.etMin >= ET_PRE && b.etMin < ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    console.log(`\n════ ${date} (ET)${live ? ` — 라이브 (현재 ET ${fmtT(nowEtMin)})` : ""} ════`);
    if (!raw.length || hist.length < 11) { console.log("  데이터 부족"); continue; }
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const unit = unitArrL(raw, r10);
    const cond = (t: number, dir: Dir) => t >= 5 && (bmid(raw[t]) - bmid(raw[t - 5])) * dir >= unit[t - 5] * 5;
    let c1: J | null = null;
    for (let t = 5; t < raw.length && !c1; t++) {
      if (raw[t].etMin < ET_OPEN) continue;
      for (const dir of [1, -1] as const) if (cond(t, dir)) { c1 = { i: t, t: raw[t].etMin, dir, px: raw[t].close }; break; }
    }
    const b5 = to5m(raw);
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    let fJ: J | null = null;
    if (b5.length >= 5) {
      const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null }, { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
      const trs = fOut.transitions ?? [];
      if (trs.length) {
        const k5 = b5.findIndex((b) => b.time === trs[0].time);
        if (k5 >= 0) {
          const endMin = b5[k5].etMin + 4;
          let i1 = raw.findIndex((b) => b.etMin >= endMin);
          if (i1 < 0) i1 = raw.length - 1;
          fJ = { i: i1, t: raw[i1].etMin, dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px };
        }
      }
    }
    const dirKo = (d: Dir) => (d === 1 ? "상승(SOXL)" : "하락(SOXS)");
    const day = dBy.get(date);
    const prev = daily.filter((b) => b.date < date).slice(-1)[0];
    if (day && prev) console.log(`  SOXX 일봉: 전일종가 대비 ${s2(((day.close - prev.close) / prev.close) * 100)}% · 시가→종가 ${s2(((day.close - day.open) / day.open) * 100)}%`);
    console.log(`  창1: ${c1 ? `${fmtT(c1.t)} ET ${dirKo(c1.dir)} @${c1.px.toFixed(2)}` : live ? "아직 없음" : "없음"}`);
    console.log(`  F : ${fJ ? `${fmtT(fJ.t)} ET ${dirKo(fJ.dir)}` : live ? "아직 없음" : "없음"}`);
    if (!c1 && !fJ) continue;

    const fFirst = fJ && (!c1 || fJ.t < c1.t);
    const lastPx = raw[raw.length - 1].close;
    const closePx = live ? lastPx : reg.length ? reg[reg.length - 1].close : lastPx;
    let cut = false;
    const tranche = (j: J, forceI?: number, forcePx?: number): number => {
      let i0 = j.i, px = j.px;
      if (raw[j.i].etMin < ET_OPEN) { i0 = raw.findIndex((b) => b.etMin >= ET_OPEN); px = reg[0]?.open ?? j.px; if (i0 < 0) return 0; }
      if (forceI !== undefined && forceI <= i0) return 0;
      const s = STOP / 100;
      const lim = forceI ?? raw.length;
      for (let k = i0 + 1; k < lim; k++) {
        if (raw[k].etMin < ET_OPEN) continue;
        if (j.dir === 1 ? raw[k].low <= px * (1 - s) : raw[k].high >= px * (1 + s)) { cut = true; return -STOP; }
      }
      return (((forceI !== undefined ? (forcePx ?? closePx) : closePx) - px) / px) * 100 * j.dir;
    };
    let pnl = 0;
    let caseKo: string, ovnOk: boolean;
    if (fFirst && fJ) {
      const oppC = c1 && c1.dir !== fJ.dir ? c1 : null;
      caseKo = `F 선행(E1) — F ${dirKo(fJ.dir)} 100% 진입${oppC ? ` → ${fmtT(oppC.t)} 창1 반대: 청산+역진입` : c1 ? " · 창1 동의" : ""}`;
      pnl = tranche(fJ, oppC?.i, oppC?.px) + (oppC ? tranche(oppC) : 0);
      ovnOk = !oppC;
    } else if (c1) {
      const agreed = !!(fJ && fJ.dir === c1.dir && fJ.t >= c1.t);
      const opp = fJ && fJ.dir !== c1.dir;
      caseKo = `창1 선행 — ${dirKo(c1.dir)} 100% 진입 · ${agreed ? "F 동의(1박 자격)" : opp ? "F 이견(보유 유지·1박 금지)" : live ? "F 대기 중" : "F 무판정(1박 없음)"}`;
      pnl = tranche(c1);
      ovnOk = agreed;
    } else { continue; }
    console.log(`  케이스: ${caseKo}`);
    if (live) {
      console.log(`  현재가 ${lastPx.toFixed(2)} 기준 미실현 ${s2(pnl)}%${cut ? " (스탑 컷)" : ""} — SOXL/SOXS 3x 환산 ${s2(pnl * 3)}%`);
      console.log(`  1박 자격: ${ovnOk ? "충족 (동의) — 취침 시 무행동 1박" : "미충족 — 취침 전 MOC 매도 예약 + 스탑 유지"}`);
    } else {
      const next = dIdx.find((x) => x > date);
      const nOpen = next ? dBy.get(next)!.open : null;
      console.log(`  당일 종가 청산: ${s2(pnl)}%${cut ? " (스탑 컷)" : ""}`);
      if (ovnOk && nOpen !== null && !cut) {
        const j = fFirst && fJ ? fJ : c1!;
        const base = raw[j.i].etMin < ET_OPEN ? (reg[0]?.open ?? j.px) : j.px;
        const ovnPnl = ((nOpen - base) / base) * 100 * j.dir;
        console.log(`  1박(채택 규칙): 다음날 시가 청산 ${s2(ovnPnl)}% — SOXL/SOXS 3x 환산 ${s2(ovnPnl * 3)}%`);
      } else console.log(`  1박: ${cut ? "스탑 컷일 — 해당 없음" : ovnOk ? "다음날 시가 미확보" : "자격 없음(당일 종가 청산)"}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
