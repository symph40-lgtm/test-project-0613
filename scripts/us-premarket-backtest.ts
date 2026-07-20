// 미장 프리장(프리마켓) 추세 판정 백테스트 — `npx tsx scripts/us-premarket-backtest.ts`
// (사용자 요청 2026-07-21) 한국 애프터장 판정(피셔 세션 스케일)의 미국판 사전 검증:
//   ① SMH 프리마켓(04:00~09:30 ET) 5분봉에 피셔(ACD)를 돌려 정규장 방향을 선판정할 수 있는가
//   ② 오프셋(세션 시가 %)·OR 길이·세션 시작·판정 컷 시각의 최적 조합은 무엇인가
//   ③ 나이브 갭 방향(프리마켓 등락 부호) 대비 피셔가 실제로 우위인가 — 부록 B의
//      "프리장 갭 방향 조기판정 금지(45~54%)" 실측이 미국에도 성립하는지 확인
// 데이터: 야후 SMH 5m includePrePost (최대 60일) + 일봉(avgRange10·라벨 보조).
// 채점: 판정 컷 → 정규장 시가 진입 가정 → ①방향적중(시가→종가 부호) ②누적 %p(SMH 기준)
//       ③스탑 적용 손익(SMH -1.5% ≈ 2x ETF -3%, 한국 피셔 확인형과 동일 원칙)

import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar, Verdict } from "../lib/predict/types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

type Bar5 = { etDay: string; etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };

// ── ET 변환 (DST 자동)
const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
function toEt(d: Date): { day: string; min: number; hhmm: string } {
  const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
  const h = p.hour === "24" ? 0 : parseInt(p.hour, 10);
  const min = h * 60 + parseInt(p.minute, 10);
  return { day: `${p.year}-${p.month}-${p.day}`, min, hhmm: `${String(h).padStart(2, "0")}:${p.minute}` };
}

const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

async function fetch5mPrePost(symbol: string, days: number): Promise<Map<string, Bar5[]>> {
  const r = await yf.chart(symbol, {
    period1: new Date(Date.now() - days * 86400e3),
    interval: "5m",
    includePrePost: true,
  });
  const byDay = new Map<string, Bar5[]>();
  for (const q of r.quotes ?? []) {
    if (q.close == null || q.open == null) continue;
    const d = q.date instanceof Date ? q.date : new Date(q.date);
    const { day, min, hhmm } = toEt(d);
    const arr = byDay.get(day) ?? [];
    arr.push({
      etDay: day, etMin: min, time: hhmm,
      open: q.open, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close,
      volume: typeof q.volume === "number" ? q.volume : 0,
    });
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
      return { date: toEt(d).day, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0 };
    });
}

// ── 하루치 분해
type DayData = {
  date: string;
  pre: Bar5[];      // 04:00~09:29 ET
  regOpen: number;  // 09:30 봉 시가
  regClose: number; // 마지막 정규장 봉 종가
  regBars: Bar5[];  // 정규장 5분봉 (스탑 시뮬)
};

function splitDays(byDay: Map<string, Bar5[]>): DayData[] {
  const out: DayData[] = [];
  const OPEN = 9 * 60 + 30, CLOSE = 16 * 60;
  for (const [date, bars] of [...byDay.entries()].sort()) {
    const pre = bars.filter((b) => b.etMin >= 4 * 60 && b.etMin < OPEN);
    const reg = bars.filter((b) => b.etMin >= OPEN && b.etMin < CLOSE);
    if (reg.length < 30) continue; // 반일장·데이터 결손 제외
    out.push({ date, pre, regOpen: reg[0].open, regClose: reg[reg.length - 1].close, regBars: reg });
  }
  return out;
}

// ── 스탑 시뮬 — 정규장 시가 진입, SMH 기준 -stopPct% 역행 시 그 자리 청산 (5분봉 고저 관통)
function pnlWithStop(day: DayData, verdict: Verdict, stopPct: number): number {
  if (verdict === "none") return 0;
  const dirUp = verdict === "leverage";
  const entry = day.regOpen;
  for (const b of day.regBars) {
    const adverse = dirUp ? ((b.low - entry) / entry) * 100 : ((entry - b.high) / entry) * 100;
    if (adverse <= -stopPct) return -stopPct;
  }
  const rOC = ((day.regClose - entry) / entry) * 100;
  return dirUp ? rOC : -rOC;
}

type Cfg = {
  startEt: string;   // 세션 시작 (OR 기점)
  orBars: number;    // OR = 5분봉 n개
  offsetPct: number; // 세션 시가 대비 %
  confirmBars: number;
  cut: string;       // 판정 컷 (ET) — 이 시각 전 완성봉까지만
};

type Score = {
  trades: number; hits: number; cum: number; cumStop: number;
  gapTrades: number; gapHits: number; gapCum: number; // 같은 컷의 나이브 갭 방향 대조군
};

function fmtRow(label: string, s: Score): string {
  const hit = s.trades > 0 ? ((s.hits / s.trades) * 100).toFixed(0) + "%" : "—";
  const per = s.trades > 0 ? (s.cum / s.trades).toFixed(2) : "—";
  const gap = s.gapTrades > 0 ? ((s.gapHits / s.gapTrades) * 100).toFixed(0) + "%" : "—";
  return `${label.padEnd(46)} 신호 ${String(s.trades).padStart(3)}회 · 적중 ${hit.padStart(4)} · 누적 ${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(1)}%p · 거래당 ${per}%p · 스탑누적 ${s.cumStop >= 0 ? "+" : ""}${s.cumStop.toFixed(1)}%p │ 갭대조 ${gap.padStart(4)} ${s.gapCum >= 0 ? "+" : ""}${s.gapCum.toFixed(1)}%p`;
}

async function main() {
  console.log("═══ 미장 프리장 추세 판정 백테스트 (SMH 5분봉 프리마켓, 야후 60일) ═══\n");
  const [byDay, dailyAll] = await Promise.all([fetch5mPrePost("SMH", 59), fetchDaily("SMH", 200)]);
  const days = splitDays(byDay);
  console.log(`대상 ${days.length}거래일 (${days[0]?.date} ~ ${days[days.length - 1]?.date})`);
  const preCount = days.filter((d) => d.pre.length >= 20).length;
  console.log(`프리마켓 5분봉 20개 이상인 날: ${preCount}일\n`);

  // 프리마켓 유동성 프로필 (세션 시작 후보 판단 근거)
  const bucketN: Record<string, number[]> = { "04~06": [], "06~07": [], "07~08": [], "08~09": [], "09~09:30": [] };
  for (const d of days) {
    bucketN["04~06"].push(d.pre.filter((b) => b.etMin < 360).length);
    bucketN["06~07"].push(d.pre.filter((b) => b.etMin >= 360 && b.etMin < 420).length);
    bucketN["07~08"].push(d.pre.filter((b) => b.etMin >= 420 && b.etMin < 480).length);
    bucketN["08~09"].push(d.pre.filter((b) => b.etMin >= 480 && b.etMin < 540).length);
    bucketN["09~09:30"].push(d.pre.filter((b) => b.etMin >= 540).length);
  }
  console.log("프리마켓 5분봉 밀도 (구간별 평균 봉 수 / 이론 최대):");
  const maxN: Record<string, number> = { "04~06": 24, "06~07": 12, "07~08": 12, "08~09": 12, "09~09:30": 6 };
  for (const [k, v] of Object.entries(bucketN)) {
    const avg = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
    console.log(`  ${k.padEnd(9)} ${avg.toFixed(1)} / ${maxN[k]}`);
  }

  // 정규장 방향 분포 (기저율)
  const rocs = days.map((d) => ((d.regClose - d.regOpen) / d.regOpen) * 100);
  const upDays = rocs.filter((r) => r > 0).length;
  console.log(`\n정규장 시가→종가: 상승 ${upDays}일 / 하락 ${days.length - upDays}일 (기저율 ${((upDays / days.length) * 100).toFixed(0)}%) · |rOC| 중앙 ${median(rocs.map(Math.abs)).toFixed(2)}%\n`);

  const dailySorted = dailyAll.sort((a, b) => a.date.localeCompare(b.date));

  // ── 스윕
  const startEts = ["04:00", "06:00", "07:00", "08:00"];
  const orBarsList = [3, 6];        // 15분 / 30분
  const offsets = [0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8];
  const confirmList = [2, 3];       // 10분 / 15분 연속 유지
  const cuts = ["08:00", "08:30", "09:00", "09:25"];
  const STOP = 1.5; // SMH % ≈ 2x ETF 3%

  const results: { cfg: Cfg; s: Score }[] = [];

  for (const startEt of startEts) for (const orBars of orBarsList) for (const offsetPct of offsets) for (const confirmBars of confirmList) for (const cut of cuts) {
    if (hhmmToMin(cut) <= hhmmToMin(startEt) + orBars * 5 + confirmBars * 5) continue; // 판정 불가능 조합
    const cfg: Cfg = { startEt, orBars, offsetPct, confirmBars, cut };
    const s: Score = { trades: 0, hits: 0, cum: 0, cumStop: 0, gapTrades: 0, gapHits: 0, gapCum: 0 };

    for (const day of days) {
      const w = day.pre.filter((b) => b.etMin >= hhmmToMin(startEt) && b.time < cut);
      if (w.length < orBars + confirmBars + 2) continue;
      const hist = dailySorted.filter((b) => b.date < day.date).slice(-120);
      if (hist.length < 30) continue;
      const rOC = ((day.regClose - day.regOpen) / day.regOpen) * 100;

      // 나이브 갭 대조군: 컷 시점 프리마켓 등락 부호 (전일 종가 대비)
      const prevClose = hist[hist.length - 1].close;
      const preLast = w[w.length - 1].close;
      const gapSign = Math.sign(preLast - prevClose);
      if (gapSign !== 0) {
        s.gapTrades++;
        if (Math.sign(rOC) === gapSign) s.gapHits++;
        s.gapCum += gapSign > 0 ? rOC : -rOC;
      }

      // 피셔: 오프셋 = 세션 시가 × offsetPct% → runFisher의 ratio(×avgRange10)로 환산
      const range10 = avgRangeOf(hist, 10);
      if (range10 === null) continue;
      const offsetRatio = ((offsetPct / 100) * w[0].open) / range10;
      const minute: MinuteBar[] = w.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      const out = runFisher(
        { date: day.date, dailyHistory: hist, openPx: w[0].open, morning: minute, prevDayMinutes: null },
        { orMinutes: orBars, offsetRangeRatio: offsetRatio, confirmMinutes: confirmBars, reversalMinutes: 1, earlyConfirmBy: "07:00" },
      );
      if (out.verdict === "none") continue;
      s.trades++;
      const dirUp = out.verdict === "leverage";
      if ((dirUp && rOC > 0) || (!dirUp && rOC < 0)) s.hits++;
      s.cum += dirUp ? rOC : -rOC;
      s.cumStop += pnlWithStop(day, out.verdict, STOP);
    }
    results.push({ cfg, s });
  }

  // ── 결과: 컷별 상위 6개 (스탑누적 기준) + 최하위 1개
  for (const cut of cuts) {
    console.log(`\n── 판정 컷 ${cut} ET (KST ${etToKst(cut)}) — 스탑누적 상위 ──`);
    const rs = results.filter((r) => r.cfg.cut === cut && r.s.trades >= 8).sort((a, b) => b.s.cumStop - a.s.cumStop);
    for (const r of rs.slice(0, 6)) {
      const c = r.cfg;
      console.log(fmtRow(`시작${c.startEt}·OR${c.orBars * 5}분·오프셋${c.offsetPct}%·확인${c.confirmBars * 5}분`, r.s));
    }
    if (rs.length > 6) {
      console.log("  …");
      console.log(fmtRow(`(최하위) 시작${rs[rs.length - 1].cfg.startEt}·OR${rs[rs.length - 1].cfg.orBars * 5}분·오프셋${rs[rs.length - 1].cfg.offsetPct}%·확인${rs[rs.length - 1].cfg.confirmBars * 5}분`, rs[rs.length - 1].s));
    }
  }

  // ── 오프셋 축 단독 민감도 (최다 신호 세션 08:00 컷 09:25 기준)
  console.log(`\n── 오프셋 민감도 (시작 07:00 · OR 30분 · 확인 10분 · 컷 09:25 고정) ──`);
  for (const r of results.filter((r) => r.cfg.startEt === "07:00" && r.cfg.orBars === 6 && r.cfg.confirmBars === 2 && r.cfg.cut === "09:25").sort((a, b) => a.cfg.offsetPct - b.cfg.offsetPct)) {
    console.log(fmtRow(`오프셋 ${r.cfg.offsetPct}%`, r.s));
  }

  // ── 채택 스킴 검증 — 시작 07:00 · OR 30분 · 확인 10분 · 오프셋 조기 0.15 / 후기 0.4
  //    (한국 "이른 시각 낮은 문턱·늦은 시각 높은 문턱" 구조의 미국판) — 전·후반 분할 재현 확인
  console.log(`\n── 채택 스킴 검증 (시작 07:00 · OR30분 · 확인10분 · 오프셋 08:00~08:30→0.15% / 09:00~09:25→0.4%) ──`);
  const SCHEME_OFFSET: Record<string, number> = { "08:00": 0.15, "08:30": 0.15, "09:00": 0.4, "09:25": 0.4 };
  const half = Math.floor(days.length / 2);
  for (const [segLabel, seg] of [["전체", days], ["전반", days.slice(0, half)], ["후반", days.slice(half)]] as const) {
    for (const cut of cuts) {
      const s: Score = { trades: 0, hits: 0, cum: 0, cumStop: 0, gapTrades: 0, gapHits: 0, gapCum: 0 };
      for (const day of seg) {
        const w = day.pre.filter((b) => b.etMin >= hhmmToMin("07:00") && b.time < cut);
        if (w.length < 6 + 2 + 2) continue;
        const hist = dailySorted.filter((b) => b.date < day.date).slice(-120);
        if (hist.length < 30) continue;
        const range10 = avgRangeOf(hist, 10);
        if (range10 === null) continue;
        const rOC = ((day.regClose - day.regOpen) / day.regOpen) * 100;
        const prevClose = hist[hist.length - 1].close;
        const gapSign = Math.sign(w[w.length - 1].close - prevClose);
        if (gapSign !== 0) { s.gapTrades++; if (Math.sign(rOC) === gapSign) s.gapHits++; s.gapCum += gapSign > 0 ? rOC : -rOC; }
        const offsetRatio = ((SCHEME_OFFSET[cut] / 100) * w[0].open) / range10;
        const minute: MinuteBar[] = w.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
        const out = runFisher(
          { date: day.date, dailyHistory: hist, openPx: w[0].open, morning: minute, prevDayMinutes: null },
          { orMinutes: 6, offsetRangeRatio: offsetRatio, confirmMinutes: 2, reversalMinutes: 1, earlyConfirmBy: "07:00" },
        );
        if (out.verdict === "none") continue;
        s.trades++;
        const dirUp = out.verdict === "leverage";
        if ((dirUp && rOC > 0) || (!dirUp && rOC < 0)) s.hits++;
        s.cum += dirUp ? rOC : -rOC;
        s.cumStop += pnlWithStop(day, out.verdict, STOP);
      }
      console.log(fmtRow(`[${segLabel} ${seg.length}일] 컷 ${cut}`, s));
    }
  }
}

function avgRangeOf(bars: PredictDailyBar[], n: number): number | null {
  const tail = bars.slice(-n);
  if (tail.length < n) return null;
  return tail.reduce((s, b) => s + (b.high - b.low), 0) / n;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function etToKst(hhmm: string): string {
  // EDT(UTC-4) 기준: ET+13h. 겨울(EST)엔 +14h — 표기는 서머타임 기준
  const m = (hhmmToMin(hhmm) + 13 * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
