// 최근 레짐 조기판정 분석 (2026-07-21 사용자 요청) — 3부:
//   ① 오늘(7/21) 재현: 피셔 파라미터별 레버리지 확인 시각 (실제 10:14 → 얼마나 앞당길 수 있었나)
//   ② 기간별 스윕: 전체 220일 vs 전쟁후(3/2~) vs 레버리지출시후(5/27~) — 조기창(~10:30) 오프셋·확인봉
//   ③ 스탑 폭: 피셔 진입 후 본주 -1.0/-1.5/-2.0/-2.5/무스탑 (ETF -2/-3/-4/-5%) 비교
//   ④ ETF(0193T0 KODEX 하닉레버) 기준 판정 vs 본주 기준 판정 — 5/27 이후 확인 시각·적중 비교
// 실행: npx tsx scripts/predict-recent-sweep.ts   (KIS 토큰 분당 1회 — 다른 백테스트와 병렬 금지)
//
// 라이브 구조 재현: 판정 창은 10:30 이전 컷 = 08:00(NXT)+정규장, 이후 = 09:00 정규장만.
// 오프셋은 10:30 이전(포함) = earlyRatio × 10일 평균폭, 이후 = 0.15 고정 (config 준거).
// 피셔 상태기계를 분 단위 스트리밍으로 돌려 "방향이 처음 등장한 컷 시각"을 찾는다 — 라이브의
// 모니터링(매 분) 감지와 동일. 컷 유효 구간은 09:30(피셔 판정자 시작)~14:00(확정).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { labelDay } from "../lib/predict/label";
import { fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar, PredictDailyBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const CODE = "000660";
const ETF = "0193T0"; // KODEX SK하이닉스단일종목레버리지 (2026-05-27 상장, 신탁 1.37조 최대)
const TODAY = "2026-07-21";
const WAR_FROM = "2026-03-02"; // "전쟁 난 3월 이후"
const LEV_FROM = "2026-05-27"; // 단일종목 레버리지 상장일

const addMin = (hhmm: string, d: number) => {
  const t = parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10) + d;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

function readCache(file: string): MinuteBar[] | null {
  const p = resolve(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[] | null;
    return j && j.length ? j : null;
  } catch { return null; }
}

async function minutesCached(code: string, date: string, kind: "KRX" | "NX"): Promise<MinuteBar[] | null> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = kind === "KRX" ? `${code}-${date}.json` : `${code}NX-${date}.json`;
  const hit = readCache(file);
  if (hit) return hit;
  const marker = resolve(CACHE_DIR, `${file}.none`); // 상장 전/휴장 재조회 방지
  if (existsSync(marker) && date !== TODAY) return null;
  const ymd = date.replace(/-/g, "");
  const bars = kind === "KRX" ? await fetchDayMinutes(code, ymd, "153000") : await fetchNxtPremarket(code, ymd);
  if (bars && bars.length) writeFileSync(resolve(CACHE_DIR, file), JSON.stringify(bars));
  else writeFileSync(marker, "1");
  return bars;
}

// ── 피셔 상태기계 스트리밍 — 상태 전이 타임라인 (전이 시각 = 봉 완성 컷 = 봉시각+1분)
type FState = "none" | "up" | "down";
type Transition = { cut: string; state: FState; px: number };
function fisherStream(bars: MinuteBar[], orMinutes: number, offsetWon: number, confirm: number, reversal: number, strongWon?: number): Transition[] {
  if (bars.length < orMinutes + 1) return [];
  const or = bars.slice(0, orMinutes);
  const aUp = Math.max(...or.map((b) => b.high)) + offsetWon;
  const aDown = Math.min(...or.map((b) => b.low)) - offsetWon;
  const out: Transition[] = [];
  let state: FState = "none", upRun = 0, downRun = 0;
  for (const b of bars.slice(orMinutes)) {
    upRun = b.close > aUp ? upRun + 1 : 0;
    downRun = b.close < aDown ? downRun + 1 : 0;
    // 강돌파 오버라이드: A선을 strongWon 이상 크게 돌파한 종가는 확인봉을 즉시 충족 처리
    if (strongWon !== undefined) {
      if (b.close > aUp + strongWon) upRun = Math.max(upRun, confirm, reversal);
      if (b.close < aDown - strongWon) downRun = Math.max(downRun, confirm, reversal);
    }
    let next: FState = state;
    if (state === "none") {
      if (upRun >= confirm) next = "up";
      else if (downRun >= confirm) next = "down";
    } else if (state === "up" && downRun >= reversal) next = "down";
    else if (state === "down" && upRun >= reversal) next = "up";
    if (next !== state) { state = next; out.push({ cut: addMin(b.time, 1), state, px: b.close }); }
  }
  return out;
}
const stateAt = (tl: Transition[], cut: string): Transition | null => {
  let cur: Transition | null = null;
  for (const t of tl) { if (t.cut <= cut) cur = t; else break; }
  return cur;
};

// ── 하루 시뮬레이션 — 라이브 이중창 구조. 반환: 첫 방향 확인(컷·방향·가격) + 이후 뒤집힘 수
type DaySim = { confirmCut: string; dir: "up" | "down"; entryPx: number; flips: number } | null;
type SimCfg = { earlyRatio: number; confirm: number; lateRatio?: number; lateConfirm?: number; reversal?: number; noPreWindow?: boolean; strongRatio?: number };
function simulateDay(pre: MinuteBar[] | null, krx: MinuteBar[], range10: number, cfg: SimCfg): DaySim {
  const rev = cfg.reversal ?? 5;
  const lateRatio = cfg.lateRatio ?? 0.15, lateConfirm = cfg.lateConfirm ?? 8;
  const winA = cfg.noPreWindow ? krx : [...(pre ?? []), ...krx]; // 10:30 이전 컷용 (라이브: NXT 08:00 시작)
  const tlA = fisherStream(winA, 15, cfg.earlyRatio * range10, cfg.confirm, rev, cfg.strongRatio !== undefined ? cfg.strongRatio * range10 : undefined);
  const tlB = fisherStream(krx, 15, lateRatio * range10, lateConfirm, rev);
  // 유효 판정 타임라인: 컷 09:30~10:30 → A창, 10:31~14:00 → B창
  const effAt = (cut: string) => (cut <= "10:30" ? stateAt(tlA, cut) : stateAt(tlB, cut));
  let first: Transition | null = null;
  let flips = 0;
  let lastDir: FState = "none";
  for (let m = 9 * 60 + 30; m <= 14 * 60; m++) {
    const cut = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const s = effAt(cut);
    const st = s?.state ?? "none";
    if (!first && s && st !== "none") { first = { ...s, cut }; lastDir = st; }
    else if (first && st !== lastDir) { flips++; lastDir = st; }
  }
  if (!first) return null;
  return { confirmCut: first.cut, dir: first.state as "up" | "down", entryPx: first.px, flips };
}

// 스탑 체크 — 진입 후 분봉으로 본주 기준 s% 역행 시 컷. 반환: 손절 시각(없으면 null)
function stopHit(krx: MinuteBar[], confirmCut: string, dir: "up" | "down", entryPx: number, stopPct: number): string | null {
  const lvl = dir === "up" ? entryPx * (1 - stopPct / 100) : entryPx * (1 + stopPct / 100);
  for (const b of krx) {
    if (b.time < confirmCut) continue;
    if (dir === "up" ? b.low <= lvl : b.high >= lvl) return b.time;
  }
  return null;
}

type DayData = {
  date: string; label: Verdict; rOC: number; close: number; open: number;
  pre: MinuteBar[] | null; krx: MinuteBar[]; range10: number;
};

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const avgOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const medianCut = (cuts: string[]) => {
  if (!cuts.length) return "—";
  const mins = cuts.map((c) => parseInt(c.slice(0, 2), 10) * 60 + parseInt(c.slice(3, 5), 10)).sort((a, b) => a - b);
  const m = mins[Math.floor(mins.length / 2)];
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

async function main() {
  // ── 데이터 적재 (본주)
  const daily = await fetchDailyPredict(CODE, 400);
  const byDate = new Map(daily.map((b) => [b.date, b]));
  const upToToday = daily.filter((b) => b.date <= TODAY);
  const days: DayData[] = [];
  for (let i = 0; i < upToToday.length; i++) {
    const bar = upToToday[i];
    if (bar.date < "2025-08-20") continue;
    const hist = upToToday.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (r10 === null) continue;
    const krx = await minutesCached(CODE, bar.date, "KRX");
    if (!krx || krx.length < 200) continue;
    const pre = await minutesCached(CODE, bar.date, "NX");
    const { label, rOC } = labelDay(bar);
    days.push({ date: bar.date, label, rOC, close: bar.close, open: bar.open, pre, krx, range10: r10 });
  }
  console.log(`적재: ${days.length}일 (${days[0].date} ~ ${days[days.length - 1].date})\n`);

  // ══ ① 오늘(7/21) 재현 ══
  const today = days.find((d) => d.date === TODAY);
  if (today) {
    console.log("══ ① 오늘(2026-07-21) 재현 ══");
    const o9 = today.krx[0];
    const low9 = Math.min(...today.krx.filter((b) => b.time < "09:30").map((b) => b.low));
    const preOpen = today.pre?.[0]?.open;
    console.log(`프리장 시가 ${preOpen ?? "—"} · 정규장 시가 ${o9.open} · 09시대 저가 ${low9} · 종가 ${today.close} (r_oc ${fmtPct(today.rOC)}) · 10일평균폭 ${Math.round(today.range10)}원`);
    console.log(`\n조기창(≤10:30) 파라미터별 첫 방향 확인 시각 (현행 = 오프셋 0.10·확인 8봉):`);
    console.log(`오프셋 | 확인4봉         | 확인6봉         | 확인8봉`);
    for (const ratio of [0.05, 0.075, 0.1, 0.125, 0.15]) {
      const cells = [4, 6, 8].map((cf) => {
        const s = simulateDay(today.pre, today.krx, today.range10, { earlyRatio: ratio, confirm: cf });
        if (!s) return "미확인          ";
        const d = s.dir === "up" ? "레버" : "인버";
        return `${s.confirmCut} ${d} ${s.entryPx}원`.padEnd(16);
      });
      console.log(`${ratio.toFixed(3)}  | ${cells.join(" | ")}`);
    }
    // 현행 재현 상세 타임라인
    const cur = simulateDay(today.pre, today.krx, today.range10, { earlyRatio: 0.1, confirm: 8 });
    if (cur) {
      console.log(`\n현행 재현: 첫 확인 ${cur.confirmCut} ${cur.dir === "up" ? "레버리지" : "인버스"} @${cur.entryPx}원 (실제 라이브 10:14 판정과 대조), 이후 뒤집힘 ${cur.flips}회`);
      const vsLow = ((cur.entryPx - low9) / low9) * 100;
      const vsOpen = ((cur.entryPx - o9.open) / o9.open) * 100;
      console.log(`확인가 기준: 09시대 저가 대비 ${fmtPct(vsLow)} · 정규장 시가 대비 ${fmtPct(vsOpen)} · 종가까지 ${fmtPct(((today.close - cur.entryPx) / cur.entryPx) * 100)}`);
      for (const s of [1.0, 1.5, 2.0, 2.5]) {
        const hitAt = stopHit(today.krx, cur.confirmCut, cur.dir, cur.entryPx, s);
        console.log(`  스탑 본주 -${s.toFixed(1)}% (ETF -${(s * 2).toFixed(0)}%): ${hitAt ? `${hitAt} 손절 → 이후 종가까지 놓친 이익 ${fmtPct(((today.close - cur.entryPx * (1 - s / 100)) / (cur.entryPx * (1 - s / 100))) * 100)}` : "미발동 — 종가 보유"}`);
      }
    }
    console.log("");
  }

  // ══ ② 기간별 파라미터 스윕 ══
  const periods: { name: string; from: string }[] = [
    { name: "전체(~220일)", from: "2025-08-20" },
    { name: "전쟁후(3/2~)", from: WAR_FROM },
    { name: "레버출시후(5/27~)", from: LEV_FROM },
  ];
  console.log("══ ② 기간별 조기창 파라미터 스윕 (첫 확인 진입 → 종가, 스탑 본주 -1.5% 적용) ══");
  console.log("econ = 방향부호 반영 본주 수익률(ETF는 ×2), 노이즈컷 = 스탑 맞았지만 라벨은 판정 방향이 맞았던 날");
  for (const p of periods) {
    const set = days.filter((d) => d.date >= p.from && d.date <= TODAY);
    console.log(`\n── ${p.name}: ${set.length}일 ──`);
    console.log("오프셋·확인 | 신호  | 방향적중 | 중앙확인  | ≤10:00  | 누적(무스탑) | 누적(-1.5%) | 컷수(노이즈)");
    for (const ratio of [0.05, 0.075, 0.1, 0.125, 0.15]) {
      for (const cf of [4, 6, 8]) {
        let n = 0, hit = 0, cuts: string[] = [], early = 0, cumRaw = 0, cumStop = 0, stops = 0, noise = 0;
        for (const d of set) {
          const s = simulateDay(d.pre, d.krx, d.range10, { earlyRatio: ratio, confirm: cf });
          if (!s) continue;
          n++;
          const verdict: Verdict = s.dir === "up" ? "leverage" : "inverse";
          if (verdict === d.label) hit++;
          cuts.push(s.confirmCut);
          if (s.confirmCut <= "10:00") early++;
          const sign = s.dir === "up" ? 1 : -1;
          const raw = ((d.close - s.entryPx) / s.entryPx) * 100 * sign;
          cumRaw += raw;
          const st = stopHit(d.krx, s.confirmCut, s.dir, s.entryPx, 1.5);
          if (st) { cumStop += -1.5; stops++; if (verdict === d.label) noise++; }
          else cumStop += raw;
        }
        const mark = ratio === 0.1 && cf === 8 ? " ←현행" : "";
        console.log(
          `${ratio.toFixed(3)}·${cf}봉 | ${String(n).padStart(3)}회 | ${n ? ((hit / n) * 100).toFixed(1).padStart(5) : "  —"}% | ${medianCut(cuts)}   | ${String(early).padStart(3)}회 | ${cumRaw >= 0 ? "+" : ""}${cumRaw.toFixed(1).padStart(6)}%p | ${cumStop >= 0 ? "+" : ""}${cumStop.toFixed(1).padStart(6)}%p | ${stops}(${noise})${mark}`,
        );
      }
    }
  }

  // ══ ③ 스탑 폭 스윕 (현행 판정 파라미터 고정) ══
  console.log("\n══ ③ 스탑 폭 스윕 — 현행 판정(0.10·8봉) 첫 확인 진입 기준 ══");
  for (const p of periods) {
    const set = days.filter((d) => d.date >= p.from && d.date <= TODAY);
    const sims = set
      .map((d) => ({ d, s: simulateDay(d.pre, d.krx, d.range10, { earlyRatio: 0.1, confirm: 8 }) }))
      .filter((x): x is { d: DayData; s: NonNullable<DaySim> } => x.s !== null);
    console.log(`\n── ${p.name}: 신호 ${sims.length}회 ──`);
    console.log("스탑(본주/ETF)   | 누적      | 거래당    | 컷수 | 노이즈컷(라벨적중인데 컷) | 컷후 종가회복(놓친이익>1%)");
    for (const s of [1.0, 1.5, 2.0, 2.5, Infinity]) {
      let cum = 0, stops = 0, noise = 0, recov = 0;
      for (const { d, s: sim } of sims) {
        const sign = sim.dir === "up" ? 1 : -1;
        const raw = ((d.close - sim.entryPx) / sim.entryPx) * 100 * sign;
        if (s === Infinity) { cum += raw; continue; }
        const st = stopHit(d.krx, sim.confirmCut, sim.dir, sim.entryPx, s);
        if (st) {
          cum += -s; stops++;
          const verdict: Verdict = sim.dir === "up" ? "leverage" : "inverse";
          if (verdict === d.label) noise++;
          if (raw - -s > 1) recov++; // 컷 없었으면 1%p 이상 더 벌었을 날
        } else cum += raw;
      }
      const lbl = s === Infinity ? "무스탑        " : `-${s.toFixed(1)}%/-${(s * 2).toFixed(0)}%     `;
      console.log(`${lbl} | ${cum >= 0 ? "+" : ""}${cum.toFixed(1).padStart(6)}%p | ${fmtPct(cum / sims.length).padStart(7)} | ${String(stops).padStart(3)} | ${noise} | ${recov}`);
    }
  }

  // ══ ④ ETF(0193T0) 기준 판정 vs 본주 기준 ══
  console.log("\n══ ④ KODEX 하닉레버리지(0193T0) 기준 판정 — 5/27 이후 ══");
  const etfDates = days.filter((d) => d.date >= LEV_FROM && d.date <= TODAY).map((d) => d.date);
  const etfMin = new Map<string, MinuteBar[]>();
  for (const dt of etfDates) {
    const bars = await minutesCached(ETF, dt, "KRX");
    if (bars && bars.length >= 200) etfMin.set(dt, bars);
  }
  console.log(`ETF 분봉 확보: ${etfMin.size}/${etfDates.length}일`);
  const preToday = await minutesCached(ETF, TODAY, "NX");
  console.log(`ETF NXT 프리마켓(오늘): ${preToday ? `${preToday.length}봉 있음` : "없음 — ETF는 08시 창 불가"}`);
  // ETF 일봉 근사 (분봉 집계) — avgRange10용
  const etfDaily = new Map<string, PredictDailyBar>();
  for (const [dt, bars] of etfMin) {
    etfDaily.set(dt, {
      date: dt, open: bars[0].open, close: bars[bars.length - 1].close,
      high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)),
      volume: bars.reduce((a, b) => a + b.volume, 0),
    });
  }
  const etfDatesSorted = [...etfDaily.keys()].sort();
  console.log(`\n날짜별 첫 확인 비교 (본주 = 현행 0.10·8봉·08시창 / ETF = 0.10·8봉·09시창 — ETF는 프리장 없음):`);
  console.log("날짜        | 본주 확인       | ETF 확인        | 라벨      | 본주econ  | ETFecon(ETF%)");
  let bN = 0, bHit = 0, bCum = 0, eN = 0, eHit = 0, eCum = 0;
  const bCuts: string[] = [], eCuts: string[] = [];
  for (const dt of etfDatesSorted) {
    const d = days.find((x) => x.date === dt);
    if (!d) continue;
    const idx = etfDatesSorted.indexOf(dt);
    const histBars = etfDatesSorted.slice(Math.max(0, idx - 10), idx).map((x) => etfDaily.get(x)!);
    const eR10 = avgRange(histBars, Math.min(10, histBars.length >= 5 ? histBars.length : 10));
    const bars = etfMin.get(dt)!;
    const bSim = simulateDay(d.pre, d.krx, d.range10, { earlyRatio: 0.1, confirm: 8 });
    const eSim = eR10 !== null ? simulateDay(null, bars, eR10, { earlyRatio: 0.1, confirm: 8, noPreWindow: true }) : null;
    const eClose = etfDaily.get(dt)!.close;
    let bTxt = "미확인          ", eTxt = "미확인          ", bEcon = "    —  ", eEcon = "    —  ";
    if (bSim) {
      bN++; bCuts.push(bSim.confirmCut);
      const v: Verdict = bSim.dir === "up" ? "leverage" : "inverse";
      if (v === d.label) bHit++;
      const r = ((d.close - bSim.entryPx) / bSim.entryPx) * 100 * (bSim.dir === "up" ? 1 : -1);
      bCum += r; bEcon = fmtPct(r).padStart(7);
      bTxt = `${bSim.confirmCut} ${bSim.dir === "up" ? "레버" : "인버"}`.padEnd(16);
    }
    if (eSim) {
      eN++; eCuts.push(eSim.confirmCut);
      const v: Verdict = eSim.dir === "up" ? "leverage" : "inverse";
      if (v === d.label) eHit++;
      const r = ((eClose - eSim.entryPx) / eSim.entryPx) * 100 * (eSim.dir === "up" ? 1 : -1);
      eCum += r; eEcon = fmtPct(r).padStart(7);
      eTxt = `${eSim.confirmCut} ${eSim.dir === "up" ? "레버" : "인버"}`.padEnd(16);
    }
    const lbl = d.label === "leverage" ? "레버리지" : d.label === "inverse" ? "인버스 " : "없음   ";
    console.log(`${dt} | ${bTxt} | ${eTxt} | ${lbl} | ${bEcon} | ${eEcon}`);
  }
  console.log(`\n요약: 본주 신호 ${bN}회·방향적중 ${bN ? ((bHit / bN) * 100).toFixed(0) : "—"}%·중앙확인 ${medianCut(bCuts)}·누적 ${fmtPct(bCum)}(본주)`);
  console.log(`      ETF  신호 ${eN}회·방향적중 ${eN ? ((eHit / eN) * 100).toFixed(0) : "—"}%·중앙확인 ${medianCut(eCuts)}·누적 ${fmtPct(eCum)}(ETF, 본주환산 ≈ ÷2)`);
  // 본주를 ETF와 동일 조건(09시창)으로 돌린 대조 — 창 차이 효과 분리
  let cN = 0, cHit = 0; const cCuts: string[] = [];
  for (const dt of etfDatesSorted) {
    const d = days.find((x) => x.date === dt);
    if (!d) continue;
    const s = simulateDay(null, d.krx, d.range10, { earlyRatio: 0.1, confirm: 8, noPreWindow: true });
    if (s) { cN++; cCuts.push(s.confirmCut); if ((s.dir === "up" ? "leverage" : "inverse") === d.label) cHit++; }
  }
  console.log(`      (대조) 본주 09시창: 신호 ${cN}회·방향적중 ${cN ? ((cHit / cN) * 100).toFixed(0) : "—"}%·중앙확인 ${medianCut(cCuts)} — ETF와의 차이 중 '창 차이' 성분 분리용`);

  // ══ ⑤ 강돌파 즉시확인 스윕 (2026-07-22 사용자 제안) — A선을 margin×10일평균폭 이상 크게
  // 돌파한 종가는 확인봉(4봉) 즉시 충족. 조기창(0.05·4봉) 위에 얹어 임계값별 성능 비교.
  console.log("\n══ ⑤ 강돌파 즉시확인 스윕 (조기창 0.05·4봉 + 강돌파 margin×range10) ══");
  const margins: (number | undefined)[] = [undefined, 0.05, 0.1, 0.15, 0.2, 0.3];
  for (const p of periods) {
    const set = days.filter((d) => d.date >= p.from && d.date <= TODAY);
    console.log(`\n── ${p.name}: ${set.length}일 ──`);
    console.log("강돌파margin | 신호  | 방향적중 | 중앙확인  | ≤09:35 | 누적(-1.5%) | 컷수(노이즈)");
    for (const m of margins) {
      let n = 0, hit = 0, cuts: string[] = [], early = 0, cumStop = 0, stops = 0, noise = 0;
      for (const d of set) {
        const s = simulateDay(d.pre, d.krx, d.range10, { earlyRatio: 0.05, confirm: 4, strongRatio: m });
        if (!s) continue;
        n++;
        const verdict: Verdict = s.dir === "up" ? "leverage" : "inverse";
        if (verdict === d.label) hit++;
        cuts.push(s.confirmCut);
        if (s.confirmCut <= "09:35") early++;
        const sign = s.dir === "up" ? 1 : -1;
        const raw = ((d.close - s.entryPx) / s.entryPx) * 100 * sign;
        const st = stopHit(d.krx, s.confirmCut, s.dir, s.entryPx, 1.5);
        if (st) { cumStop += -1.5; stops++; if (verdict === d.label) noise++; }
        else cumStop += raw;
      }
      const lbl = m === undefined ? "없음(현행)  " : `${m.toFixed(2)}×r10   `;
      console.log(`${lbl} | ${String(n).padStart(3)}회 | ${n ? ((hit / n) * 100).toFixed(1).padStart(5) : "  —"}% | ${medianCut(cuts)}   | ${String(early).padStart(3)}회 | ${cumStop >= 0 ? "+" : ""}${cumStop.toFixed(1).padStart(6)}%p | ${stops}(${noise})`);
    }
  }
  // 어제(7/21) 개별 확인 — 강돌파 임계별 확인 시각
  const t2 = days.find((d) => d.date === TODAY);
  if (t2) {
    console.log(`\n7/21 강돌파 임계별 첫 확인:`);
    for (const m of margins) {
      const s = simulateDay(t2.pre, t2.krx, t2.range10, { earlyRatio: 0.05, confirm: 4, strongRatio: m });
      console.log(`  margin ${m === undefined ? "없음" : m.toFixed(2)}: ${s ? `${s.confirmCut} ${s.dir === "up" ? "레버" : "인버"} @${s.entryPx}` : "미확인"}`);
    }
  }
}

main().catch((e) => { console.error("분석 실패:", e); process.exit(1); });
