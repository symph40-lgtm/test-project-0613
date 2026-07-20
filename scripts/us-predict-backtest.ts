// 미장 예측 스트림 백테스트 — `npx tsx scripts/us-predict-backtest.ts`
// (사용자 지정 2026-07-21: "국장과 동일 구조 — 프리장 user 모델·정규장 피셔, SMH 변동폭 상수")
//   ① 프리장 체크포인트(08:30·09:00·09:25 ET)의 user 모델(RV1+T6) — RV1 프리장 적용 여부 2변형
//   ② 정규장 체크포인트(10:00~14:30)의 피셔 — offsetRangeRatio(×avgRange10) 스윕 + 조기/후기 분리
//   ③ 라벨 임계(trendMinPct) 후보별 분포 — SMH 스케일 결정 근거
// 채점: 컷 시점 진입(프리장 컷은 정규장 시가 진입) → 16:00 종가 청산, 스탑 SMH -1.5%(2x ETF -3%).
// 데이터: 야후 SMH 5분봉 includePrePost 59일 + 일봉 200일. 라이브와 동일 모델 코드(lib/signal/us/models.ts).

import YahooFinance from "yahoo-finance2";
import { runUsUserModel, runUsFisher, labelUsDay, pnlFromCut, ET_OPEN, ET_CLOSE, ET_PRE_START } from "../lib/signal/us/models";
import type { UsBar } from "../lib/signal/us/models";
import type { PredictDailyBar, Verdict } from "../lib/predict/types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const STOP = 1.5;

const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

async function fetch5m(days: number): Promise<Map<string, UsBar[]>> {
  const r = await yf.chart("SMH", { period1: new Date(Date.now() - days * 86400e3), interval: "5m", includePrePost: true });
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

async function fetchDaily(days: number): Promise<PredictDailyBar[]> {
  const r = await yf.chart("SMH", { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
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
function addScore(s: Score, day: Day, verdict: Verdict, cutEtMin: number) {
  if (verdict === "none") return;
  const rOC = ((day.reg[day.reg.length - 1].close - day.reg[0].open) / day.reg[0].open) * 100;
  const { pnl, stopped } = pnlFromCut(day.reg, cutEtMin, verdict, STOP);
  s.trades++;
  if ((verdict === "leverage" && rOC > 0) || (verdict === "inverse" && rOC < 0)) s.hits++;
  s.cum += pnl;
  if (stopped) s.stopped++;
}
function row(label: string, s: Score): string {
  const hit = s.trades ? `${Math.round((s.hits / s.trades) * 100)}%` : "—";
  const per = s.trades ? (s.cum / s.trades).toFixed(2) : "—";
  return `${label.padEnd(40)} 신호 ${String(s.trades).padStart(3)} · 방향적중 ${hit.padStart(4)} · 스탑누적 ${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(1)}%p · 거래당 ${per}%p · 스탑컷 ${s.stopped}회`;
}

async function main() {
  console.log("═══ 미장 예측 스트림 백테스트 — 프리장 user · 정규장 피셔 (SMH 5분봉) ═══\n");
  const [byDay, dailyAll] = await Promise.all([fetch5m(59), fetchDaily(200)]);
  const days: Day[] = [];
  for (const [date, bars] of [...byDay.entries()].sort()) {
    const pre = bars.filter((b) => b.etMin >= ET_PRE_START && b.etMin < ET_OPEN);
    const reg = bars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
    const hist = dailyAll.filter((b) => b.date < date).slice(-120);
    if (reg.length < 60 || hist.length < 30) continue;
    days.push({ date, pre, reg, hist, prevClose: hist[hist.length - 1].close });
  }
  console.log(`대상 ${days.length}거래일 (${days[0]?.date} ~ ${days[days.length - 1]?.date})`);
  const rocs = days.map((d) => ((d.reg[d.reg.length - 1].close - d.reg[0].open) / d.reg[0].open) * 100);
  console.log(`정규장 시가→종가: 상승 ${rocs.filter((r) => r > 0).length}/${days.length} · |rOC| 중앙 ${median(rocs.map(Math.abs)).toFixed(2)}%\n`);

  // ── ③ 라벨 임계 후보 분포 (하닉 1.2%의 SMH 환산 결정 근거)
  console.log("── 라벨 trendMinPct 후보별 분포 (posUp 0.65/posDown 0.35 고정) ──");
  for (const th of [0.7, 0.8, 0.9, 1.0, 1.2]) {
    const labels = days.map((d) => labelUsDay(d.reg, th).label);
    const lev = labels.filter((l) => l === "leverage").length, inv = labels.filter((l) => l === "inverse").length;
    console.log(`  ${th.toFixed(1)}%  추세일 ${lev + inv}/${days.length} (${Math.round(((lev + inv) / days.length) * 100)}%) — 상방 ${lev} · 하방 ${inv}`);
  }

  // ── ① 프리장 user 모델 — RV1 프리장 적용 vs T6 단독(한국 코드 동작)
  console.log("\n── 프리장 user 모델 (컷별 진입 = 정규장 시가) ──");
  for (const rv1Pre of [true, false]) {
    for (const cut of ["08:30", "09:00", "09:25"]) {
      const s = S0();
      for (const day of days) {
        const w = day.pre.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
        if (w.length < 4) continue;
        const out = runUsUserModel(w, day.prevClose, { rv1Premarket: rv1Pre });
        addScore(s, day, out.verdict, ET_OPEN);
      }
      console.log(row(`[RV1 프리장 ${rv1Pre ? "적용" : "미적용(T6단독)"}] 컷 ${cut}`, s));
    }
  }

  // ── ② 정규장 피셔 — offsetRangeRatio 스윕 (모든 컷 통합 → 컷별)
  const CUTS = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30"];
  const RATIOS = [0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3];
  console.log("\n── 정규장 피셔 오프셋 스윕 — 컷별 성적 (오프셋 = ratio × avgRange10) ──");
  const perCut = new Map<string, Map<number, Score>>();
  for (const cut of CUTS) perCut.set(cut, new Map(RATIOS.map((r) => [r, S0()])));
  for (const day of days) {
    for (const cut of CUTS) {
      const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
      if (w.length < 6) continue;
      for (const ratio of RATIOS) {
        const out = runUsFisher(w, day.hist, ratio);
        addScore(perCut.get(cut)!.get(ratio)!, day, out.verdict, hhmmToMin(cut));
      }
    }
  }
  for (const cut of CUTS) {
    const line = RATIOS.map((r) => {
      const s = perCut.get(cut)!.get(r)!;
      const hit = s.trades ? `${Math.round((s.hits / s.trades) * 100)}%` : "—";
      return `${r}→${String(s.trades).padStart(2)}회/${hit.padStart(4)}/${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(1)}`;
    }).join("  ");
    console.log(`  ${cut}  ${line}`);
  }

  // ── 슬롯 상세 (선택 안 — 조기 낮은 오프셋 / 후기 높은 오프셋, 한국 구조 검증)
  console.log("\n── 조기/후기 오프셋 조합 상세 (조기: 10:00~11:00 / 후기: 11:30~14:30) ──");
  for (const [early, late] of [[0.075, 0.15], [0.1, 0.15], [0.1, 0.2], [0.15, 0.15], [0.15, 0.25], [0.05, 0.1]] as const) {
    const s = S0();
    for (const day of days) {
      for (const cut of CUTS) {
        const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
        if (w.length < 6) continue;
        const ratio = cut <= "11:00" ? early : late;
        const out = runUsFisher(w, day.hist, ratio);
        addScore(s, day, out.verdict, hhmmToMin(cut));
      }
    }
    console.log(row(`조기 ${early} / 후기 ${late} (전 컷 합산)`, s));
  }

  // ── 확정 컷 후보 — 컷 하나만 거래한다고 가정 (한국 judgeHour 14:00 대응 검증)
  console.log("\n── 확정 컷 후보 (조기 0.1/후기 0.15 고정, 그 컷 단독 거래) — 전·후반 분할 ──");
  const half = Math.floor(days.length / 2);
  for (const cut of ["10:00", "10:30", "11:00", "12:00", "13:30", "14:30"]) {
    for (const [seg, arr] of [["전체", days], ["전반", days.slice(0, half)], ["후반", days.slice(half)]] as const) {
      const s = S0();
      for (const day of arr) {
        const w = day.reg.filter((b) => b.etMin + 5 <= hhmmToMin(cut));
        if (w.length < 6) continue;
        const out = runUsFisher(w, day.hist, cut <= "11:00" ? 0.1 : 0.15);
        addScore(s, day, out.verdict, hhmmToMin(cut));
      }
      console.log(row(`컷 ${cut} [${seg}]`, s));
    }
  }
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
