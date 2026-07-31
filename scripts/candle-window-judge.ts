// 사용자 6봉 윈도우 판정 규칙 실측 (사용자 스펙 2026-07-30 밤 — 분봉 형태 기반 추세 판정):
//   npx tsx scripts/candle-window-judge.ts
// 규칙 요약 (상승, 하락은 대칭):
//   ① 6봉 체인: 비교봉 시가 ≥ 기준봉 몸통(시가~종가)의 2/3 지점. 어긋난 봉은 skip(최대 2)하고
//      우측 인접봉(7·8번)으로 보충. 보충 불가·초과 시 그 윈도우 실패 → 1봉 우측 이동.
//   ② 체인 인접봉 중앙(고저 중간) 연결 기울기 ≥40°가 5경우 중 4 이상, |기울기| ≤10°는 0개.
//   ③ 저점이 이전 봉 중앙 아래로 내려간 경우 ≤1 (체인 기준).
//   ④ 개별 봉(skip 포함): 몸통 ≥ 고저폭의 20% 미달 ≤1개, 음봉 ≤1개.
//   ⑤ 판정 후 매 봉: 최근 6봉 1↔6번 중앙 기울기 ≥20° 유지 / |기울기|<20° 방향없음 /
//      반대 ≥20° 전환(#8). 방향없음 후 같은 방향 ≥20° 재개(#6).
// 각도 정규화: 1봉당 (최근 30봉 평균 고저폭 × k) 상승 = 45°. k는 0.5/0.75/1.0/1.5 스윕.
// 하닉/삼전 227일(프리장+정규장 연속창), 스탑 하닉 2.5%/삼전 1.5%. 피셔F·M 기준선과 비교,
// 병행(피셔F 레그를 판정 상태 동의로 분리)까지 측정.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const D = 180 / Math.PI;

type St = "up" | "down";
type Tr = { i: number; to: St | "none"; px: number; kind: "judge" | "slope" | "flip" | "flat" };

// 피셔 기준선 (prog5-all-sweep.ts와 동일)
function fisherStream(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, rev: number, emMult: number, emUntilMin: number): { i: number; to: St; px: number }[] {
  if (bars.length < 16) return [];
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  const out: { i: number; to: St; px: number }[] = [];
  let st: "none" | St = "none", up = 0, dn = 0;
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = emUntilMin > 0 && tMin(b.time) < emUntilMin ? emMult : 1;
    const aUp = orH + off * r10 * em, aDn = orL - off * r10 * em, sbW = sb * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf, rev);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf, rev);
    }
    if (st === "none") {
      if (up >= conf) { st = "up"; out.push({ i, to: "up", px: b.close }); }
      else if (dn >= conf) { st = "down"; out.push({ i, to: "down", px: b.close }); }
      continue;
    }
    if (st === "up") { if (dn >= rev) { st = "down"; out.push({ i, to: "down", px: b.close }); } }
    else if (up >= rev) { st = "up"; out.push({ i, to: "up", px: b.close }); }
  }
  return out;
}

const mid = (b: MinuteBar) => (b.high + b.low) / 2;
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
// 각도 (사용자 정의 2026-07-31): 1봉당 '기준봉 몸통의 절반' 상승 = 45°
// (비교봉의 시가~종가 중간이 기준봉 종가에 닿는 기울기). 도지 가드로 최근30봉 평균폭×5% 하한.
// 비교용 "fixed" 모드: floor 값 자체(최근30봉 평균폭×배율)를 45° 눈금으로 사용.
let ANGLE_MODE: "body" | "fixed" = "body";
// 개별 봉 조건(두께 20%·양봉) 대상 (사용자 질문 2026-07-31): "used" = 체인(추가봉 포함)+skip봉 전부(현행) /
// "win6" = 원래 창 6개 봉(skip 포함·추가봉 제외)
let INDIV_MODE: "used" | "win6" = "used";
const uOf = (base: MinuteBar, floor: number) =>
  ANGLE_MODE === "body" ? Math.max(Math.abs(base.close - base.open) / 2, floor, 1e-9) : Math.max(floor, 1e-9);

// ① 체인 구성: 시가 조건으로 skip(≤2)·우측 보충
function buildChain(bars: MinuteBar[], i: number, dir: 1 | -1): { chain: number[]; used: number[] } | null {
  let poolLen = 6;
  if (i + poolLen > bars.length) return null;
  const chain = [i];
  const skipped: number[] = [];
  let j = i + 1;
  while (chain.length < 6) {
    if (j >= i + poolLen) return null;
    const base = bars[chain[chain.length - 1]], cand = bars[j];
    const bLo = Math.min(base.open, base.close), bHi = Math.max(base.open, base.close);
    const ok = dir === 1 ? cand.open >= bLo + (2 / 3) * (bHi - bLo) : cand.open <= bLo + (1 / 3) * (bHi - bLo);
    if (ok) chain.push(j);
    else {
      skipped.push(j);
      if (skipped.length > 2) return null;
      if (poolLen < 8 && i + poolLen < bars.length) poolLen++;
    }
    j++;
  }
  return { chain, used: [...chain, ...skipped] };
}

// ②~④ 검증. 성공 시 판정 완성 봉 인덱스(체인 마지막) 반환
function judgeAt(bars: MinuteBar[], i: number, dir: 1 | -1, unit: number[]): number | null {
  const bc = buildChain(bars, i, dir);
  if (!bc) return null;
  const { chain, used } = bc;
  let ge40 = 0, flat = 0, midBreak = 0;
  for (let p = 0; p < 5; p++) {
    const a = chain[p], b = chain[p + 1];
    const ang = Math.atan((dir * (bmid(bars[b]) - bmid(bars[a]))) / uOf(bars[a], unit[a])) * D;
    if (ang >= 40) ge40++;
    if (Math.abs(ang) <= 10) flat++;
    const m = mid(bars[a]);
    if (dir === 1 ? bars[b].low < m : bars[b].high > m) midBreak++;
  }
  if (ge40 < 4 || flat > 0 || midBreak > 1) return null;
  let thin = 0, wrongColor = 0;
  const indiv = INDIV_MODE === "used" ? used : Array.from({ length: 6 }, (_, k) => i + k);
  for (const k of indiv) {
    const rng = bars[k].high - bars[k].low;
    const body = Math.abs(bars[k].close - bars[k].open);
    if (rng <= 0 || body < 0.2 * rng) thin++;
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrongColor++;
  }
  if (thin > 1 || wrongColor > 1) return null;
  return chain[5];
}

// ⑤ 상태 기계 (사용자 교정 2026-07-31): 유지·방향없음은 판정 유지(액션 없음), 전환에서만 청산·역진입.
// 전환 정의는 스펙상 모호해 2안 실측: "slope+judge" = 반대 기울기 ≤-20° 또는 반대 풀판정 / "judge" = 반대 풀판정만.
function candleStream(bars: MinuteBar[], unit: number[], flipMode: "slope+judge" | "judge", gateMin = 0): Tr[] {
  const out: Tr[] = [];
  let st: "none" | St = "none";
  for (let t = 5; t < bars.length; t++) {
    if (gateMin > 0 && tMin(bars[t].time) < gateMin) continue;
    let judgedDir: St | null = null;
    for (const dir of [1, -1] as const) {
      for (const start of [t - 7, t - 6, t - 5]) {
        if (start < 0) continue;
        if (judgeAt(bars, start, dir, unit) === t) { judgedDir = dir === 1 ? "up" : "down"; break; }
      }
      if (judgedDir) break;
    }
    if (st === "none") {
      if (judgedDir) { st = judgedDir; out.push({ i: t, to: st, px: bars[t].close, kind: "judge" }); }
      continue;
    }
    if (judgedDir && judgedDir !== st) { st = judgedDir; out.push({ i: t, to: st, px: bars[t].close, kind: "judge" }); continue; }
    if (flipMode === "slope+judge") {
      const s = Math.atan((bmid(bars[t]) - bmid(bars[t - 5])) / 5 / uOf(bars[t - 5], unit[t - 5])) * D;
      const sd = st === "up" ? s : -s;
      if (sd <= -20) { st = st === "up" ? "down" : "up"; out.push({ i: t, to: st, px: bars[t].close, kind: "flip" }); }
    }
  }
  return out;
}

type DayB = { bars: MinuteBar[]; r10: number; close: number };
type Leg = { pnl: number; cut: boolean; i: number; to: St; day: number; kind: string; hold: number };
function legsOf(d: DayB, trs: Tr[], stopPct: number, day: number): Leg[] {
  const out: Leg[] = [];
  const s = stopPct / 100;
  for (let k = 0; k < trs.length; k++) {
    const e = trs[k];
    if (e.to === "none") continue;
    const endI = k + 1 < trs.length ? trs[k + 1].i : d.bars.length;
    let pnl: number | null = null, cut = false;
    for (let i = e.i + 1; i < endI; i++) {
      const b = d.bars[i];
      if (e.to === "up" && b.low <= e.px * (1 - s)) { pnl = -stopPct; cut = true; break; }
      if (e.to === "down" && b.high >= e.px * (1 + s)) { pnl = -stopPct; cut = true; break; }
    }
    if (pnl === null) {
      const px2 = k + 1 < trs.length ? trs[k + 1].px : d.close;
      pnl = ((px2 - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
    }
    out.push({ pnl, cut, i: e.i, to: e.to, day, kind: e.kind, hold: endI - e.i });
  }
  return out;
}
const medHold = (legs: Leg[]): number => {
  if (!legs.length) return 0;
  const s = [...legs.map((l) => l.hold)].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
function stat(legs: Leg[], firstMins: number[]): string {
  if (!legs.length) return "  0건";
  const cum = legs.reduce((a, l) => a + l.pnl, 0);
  const win = Math.round((100 * legs.filter((l) => l.pnl > 0).length) / legs.length);
  const cut = Math.round((100 * legs.filter((l) => l.cut).length) / legs.length);
  let med = "--:--";
  if (firstMins.length) {
    const srt = [...firstMins].sort((a, b) => a - b);
    const m = srt[Math.floor(srt.length / 2)];
    med = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  return `${String(legs.length).padStart(4)}건 평균 ${(cum / legs.length).toFixed(2).padStart(6)}%·승률 ${String(win).padStart(3)}%·컷률 ${String(cut).padStart(3)}%·합 ${cum.toFixed(1).padStart(7)}%p·판정중앙 ${med}`;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (const cfg of [
    { code: "000660", nm: "하닉", sb: 0.1, stop: 2.5 },
    { code: "005930", nm: "삼전", sb: 0.075, stop: 1.5 },
  ]) {
    const daily = (await fetchDailyPredict(cfg.code, 500)).filter((b) => b.date < today);
    const days: DayB[] = [];
    for (let i = 130; i < daily.length; i++) {
      const reg = rc(`${cfg.code}-${daily[i].date}.json`);
      const pre = rc(`${cfg.code}NX-${daily[i].date}.json`);
      const hist = daily.slice(Math.max(0, i - 120), i);
      const r10 = avgRange(hist, 10);
      if (!reg || reg.length < 240 || r10 === null) continue;
      days.push({ bars: [...(pre ?? []), ...reg], r10, close: daily[i].close });
    }
    console.log(`\n=== ${cfg.nm} (${days.length}일) ===`);

    const fF: Leg[] = [], fFirst: number[] = [];
    const fM: Leg[] = [], mFirst: number[] = [];
    days.forEach((d, di) => {
      const tF = fisherStream(d.bars, d.r10, 0.05, 4, cfg.sb, 3, 3, tMin("10:30"));
      const tM = fisherStream(d.bars, d.r10, 0.10, 8, 0, 3, 1.25, tMin("10:30"));
      fF.push(...legsOf(d, tF.map((t) => ({ ...t, kind: "judge" as const })), cfg.stop, di));
      fM.push(...legsOf(d, tM.map((t) => ({ ...t, kind: "judge" as const })), cfg.stop, di));
      if (tF.length) fFirst.push(tMin(d.bars[tF[0].i].time));
      if (tM.length) mFirst.push(tMin(d.bars[tM[0].i].time));
    });
    console.log(`피셔F 기준선     ${stat(fF, fFirst)}`);
    console.log(`피셔M 기준선     ${stat(fM, mFirst)}`);

    // 각도 눈금 비교: 사용자 몸통 기준 vs 고정 눈금(최근30봉 평균폭×배율=45°)
    const mkFloor = (d: DayB, scale: number): number[] => {
      const rng: number[] = d.bars.map((b) => b.high - b.low);
      return d.bars.map((_, t) => {
        const lo = Math.max(0, t - 30);
        const w = rng.slice(lo, Math.max(lo + 1, t));
        const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : d.r10 / 100;
        return u * scale;
      });
    };
    for (const ac of [
      { label: "몸통기준(사용자)", mode: "body" as const, scale: 0.05, indiv: "used" as const },
      { label: "몸통기준·원창6  ", mode: "body" as const, scale: 0.05, indiv: "win6" as const },
      { label: "고정눈금 0.5폭  ", mode: "fixed" as const, scale: 0.5, indiv: "used" as const },
      { label: "고정0.5·원창6   ", mode: "fixed" as const, scale: 0.5, indiv: "win6" as const },
      { label: "고정눈금 1.0폭  ", mode: "fixed" as const, scale: 1.0, indiv: "used" as const },
    ]) {
      ANGLE_MODE = ac.mode;
      INDIV_MODE = ac.indiv;
      const run = (mode: "slope+judge" | "judge") => {
        const legs: Leg[] = []; const firsts: number[] = [];
        let judged = 0, days0 = 0;
        const trsByDay: Tr[][] = [];
        days.forEach((d, di) => {
          const trs = candleStream(d.bars, mkFloor(d, ac.scale), mode);
          trsByDay.push(trs);
          legs.push(...legsOf(d, trs, cfg.stop, di));
          judged += trs.filter((t) => t.kind === "judge").length;
          const f = trs.find((t) => t.to !== "none");
          if (f) firsts.push(tMin(d.bars[f.i].time)); else days0++;
        });
        return { legs, firsts, judged, days0, trsByDay };
      };
      const d2 = run("judge");
      console.log(`${ac.label} 전환=풀판정 ${stat(d2.legs, d2.firsts)}·보유중앙 ${medHold(d2.legs)}분 (무판정 ${d2.days0}일)`);
      const trsByDay = d2.trsByDay;
      {
        // 변형 C: 풀판정 → 종가까지 보유(스탑만) — 당일 방향 적중력 측정 (일 최초 풀판정 1건)
        const legsC: Leg[] = []; const firstsC: number[] = [];
        days.forEach((d, di) => {
          const trs = trsByDay[di].filter((t) => t.kind === "judge");
          if (!trs.length) return;
          const e = trs[0];
          const s = cfg.stop / 100;
          let pnl: number | null = null, cut = false;
          for (let i = e.i + 1; i < d.bars.length; i++) {
            const b = d.bars[i];
            if (e.to === "up" && b.low <= e.px * (1 - s)) { pnl = -cfg.stop; cut = true; break; }
            if (e.to === "down" && b.high >= e.px * (1 + s)) { pnl = -cfg.stop; cut = true; break; }
          }
          if (pnl === null) pnl = ((d.close - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
          legsC.push({ pnl, cut, i: e.i, to: e.to as St, day: di, kind: "judge", hold: d.bars.length - e.i });
          firstsC.push(tMin(d.bars[e.i].time));
        });
        console.log(`  ├ C(종가보유)     ${stat(legsC, firstsC)}·보유중앙 ${medHold(legsC)}분`);
        // C': 동일 진입(일 최초 풀판정), 반대 풀판정이 나오면 그 시점 청산·재진입 없음, 없으면 종가
        const legsC2: Leg[] = [];
        days.forEach((d, di) => {
          const trs = trsByDay[di].filter((t) => t.kind === "judge");
          if (!trs.length) return;
          const e = trs[0];
          const opp = trs.find((t) => t.i > e.i && t.to !== e.to);
          const endI = opp ? opp.i : d.bars.length;
          const s = cfg.stop / 100;
          let pnl: number | null = null, cut = false;
          for (let i = e.i + 1; i < endI; i++) {
            const b = d.bars[i];
            if (e.to === "up" && b.low <= e.px * (1 - s)) { pnl = -cfg.stop; cut = true; break; }
            if (e.to === "down" && b.high >= e.px * (1 + s)) { pnl = -cfg.stop; cut = true; break; }
          }
          if (pnl === null) pnl = (((opp ? opp.px : d.close) - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
          legsC2.push({ pnl, cut, i: e.i, to: e.to as St, day: di, kind: "judge", hold: endI - e.i });
        });
        console.log(`  ├ C'(전환청산)    ${stat(legsC2, [])}·보유중앙 ${medHold(legsC2)}분`);
        // 10시 게이트 (사용자 요청 7/31): 판정 완성이 10:00 이후인 것만 인정 (창이 10시 이전 봉 포함은 허용)
        if (ac.mode === "fixed" && ac.scale === 0.5 && ac.indiv === "used") {
          const firstLegOf = (d: DayB, trs: Tr[], di: number, exit: "close" | "flip"): Leg | null => {
            const js = trs.filter((t) => t.kind === "judge");
            if (!js.length) return null;
            const e = js[0];
            const opp = exit === "flip" ? js.find((t) => t.i > e.i && t.to !== e.to) : undefined;
            const endI = opp ? opp.i : d.bars.length;
            const s = cfg.stop / 100;
            let pnl: number | null = null, cut = false;
            for (let i = e.i + 1; i < endI; i++) {
              const b = d.bars[i];
              if (e.to === "up" && b.low <= e.px * (1 - s)) { pnl = -cfg.stop; cut = true; break; }
              if (e.to === "down" && b.high >= e.px * (1 + s)) { pnl = -cfg.stop; cut = true; break; }
            }
            if (pnl === null) pnl = (((opp ? opp.px : d.close) - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
            return { pnl, cut, i: e.i, to: e.to as St, day: di, kind: "judge", hold: endI - e.i };
          };
          const g10: Leg[] = []; const g10f: number[] = [];
          const g10x: Leg[] = [];
          days.forEach((d, di) => {
            const trs = candleStream(d.bars, mkFloor(d, ac.scale), "judge", tMin("10:00"));
            const lc = firstLegOf(d, trs, di, "close");
            if (lc) { g10.push(lc); g10f.push(tMin(d.bars[lc.i].time)); }
            const lx = firstLegOf(d, trs, di, "flip");
            if (lx) g10x.push(lx);
          });
          console.log(`  ├ C(종가보유)10시↑ ${stat(g10, g10f)}·보유중앙 ${medHold(g10)}분`);
          console.log(`  ├ C'(전환청산)10시↑${stat(g10x, [])}·보유중앙 ${medHold(g10x)}분`);
        }
      }
      {
        // 병행: 피셔F 레그 시작 시점의 창판정 상태로 분리 (전환=풀판정만 스트림 기준)
        const stateAt = (di: number, i: number): "none" | St => {
          let st: "none" | St = "none";
          for (const t of trsByDay[di]) { if (t.i <= i) st = t.to; else break; }
          return st;
        };
        const agree: Leg[] = [], disagree: Leg[] = [], noSt: Leg[] = [];
        for (const l of fF) {
          const st = stateAt(l.day, l.i);
          (st === l.to ? agree : st === "none" ? noSt : disagree).push(l);
        }
        console.log(`  └ 피셔F∩동의   ${stat(agree, [])}`);
        console.log(`  └ 피셔F 반대   ${stat(disagree, [])}`);
        console.log(`  └ 피셔F 무판정 ${stat(noSt, [])}`);
      }
    }
  }
  console.log("\n주: 각도는 사용자 정의(1봉당 기준봉 몸통 절반 상승=45°, 몸통 중간 연결). 유지·방향없음은 판정 유지(액션 없음) — 청산은 전환·스탑·종가만. 매수가격 위치 조건(*)은 집행 조건이라 미적용.");
}
main().catch((e) => { console.error(e); process.exit(1); });
