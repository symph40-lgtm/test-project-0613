// 일봉 스윙 — 운영 전략 시뮬 (사용자 지시 2026-07: 강도별 주식화 비율 + 손절/이익실현/트레일링 검증)
//   npx tsx scripts/daily-swing-strategy.ts [--symbol 005930] [--days 2600]
//
// A. 호라이즌(1~5일)별 방향적중 — "며칠 뒤를 맞추는 게 가장 정확한가"
// B. 주식화 비율 정책: B&H / 미너비니 이진 / 강도 티어(합의 투표) / 티어+위험감산(니슨 경고·급락 직후)
// C. 오버레이: 손절(고정·ATR) / 트레일링 / 이익실현 — 정책 위에 얹어 실측
// 비용 반영: 매수 0.015%, 매도 0.215%(수수료+거래세). 복리·MDD 산출. 미래 정보 차단 동일.

import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";
import { MODELS, atr14, type Stance } from "./daily-swing-models";

const args = process.argv.slice(2);
function argOf(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const DAYS = parseInt(argOf("--days") ?? "2600", 10);
const SYMBOLS = argOf("--symbol") ? [argOf("--symbol")!] : ["005930", "000660"];
const WARMUP = 260;
const BUY_COST = 0.00015, SELL_COST = 0.00215, RT = 0.0023; // 왕복 비용 (승패 판정용)

type Ov = { name: string; slPct?: number; slAtr?: number; trPct?: number; trAtr?: number; tpPct?: number };
type SimResult = { cum: number; cagr: number; mdd: number; expo: number; trades: number; winRate: number };

function sim(bars: PredictDailyBar[], from: number, to: number, expo: (i: number) => number, ov: Ov, atr: (number | null)[]): SimResult {
  let V = 1, peakV = 1, mdd = 0, fCur = 0, anchor = 0, peakPx = 0, atrE = 0, cooldown = 0;
  let expoSum = 0, days = 0, trades = 0, wins = 0;
  for (let i = from; i < to; i++) {
    let target = expo(i);
    if (cooldown > 0) { target = 0; cooldown--; }
    if (target !== fCur) {
      const d = target - fCur;
      V *= 1 - (d > 0 ? d * BUY_COST : -d * SELL_COST);
      if (fCur === 0 && target > 0) { anchor = bars[i].close; peakPx = bars[i].close; atrE = atr[i] ?? 0; }
      if (target === 0 && fCur > 0) { trades++; if (bars[i].close > anchor * (1 + RT)) wins++; }
      fCur = target;
    }
    expoSum += fCur; days++;
    const b1 = bars[i + 1];
    if (fCur > 0) {
      let dayRet = b1.close / bars[i].close - 1;
      let exitPx: number | null = null;
      let stopPx = -Infinity;
      if (ov.slPct) stopPx = Math.max(stopPx, anchor * (1 - ov.slPct));
      if (ov.slAtr && atrE > 0) stopPx = Math.max(stopPx, anchor - ov.slAtr * atrE);
      if (ov.trPct) stopPx = Math.max(stopPx, peakPx * (1 - ov.trPct));
      if (ov.trAtr && atrE > 0) stopPx = Math.max(stopPx, peakPx - ov.trAtr * atrE);
      const tpPx = ov.tpPct ? anchor * (1 + ov.tpPct) : Infinity;
      if (stopPx > -Infinity && (b1.open <= stopPx || b1.low <= stopPx)) {
        exitPx = b1.open <= stopPx ? b1.open : stopPx; // 갭이탈은 시가 체결
      } else if (tpPx < Infinity && (b1.open >= tpPx || b1.high >= tpPx)) {
        exitPx = b1.open >= tpPx ? b1.open : tpPx;
      }
      if (exitPx !== null) dayRet = exitPx / bars[i].close - 1;
      V *= 1 + fCur * dayRet;
      if (exitPx !== null) {
        V *= 1 - fCur * SELL_COST;
        trades++; if (exitPx > anchor * (1 + RT)) wins++;
        fCur = 0; cooldown = 3; // 컷 후 3일 재진입 금지 (연쇄 휩쏘 방지)
      } else peakPx = Math.max(peakPx, b1.close);
    }
    peakV = Math.max(peakV, V);
    mdd = Math.max(mdd, 1 - V / peakV);
  }
  const years = days / 248;
  return {
    cum: (V - 1) * 100,
    cagr: years > 0.5 ? (Math.pow(V, 1 / years) - 1) * 100 : (V - 1) * 100,
    mdd: mdd * 100,
    expo: (100 * expoSum) / Math.max(1, days),
    trades,
    winRate: trades > 0 ? (100 * wins) / trades : 0,
  };
}

function fmt(r: SimResult): string {
  return `누적 ${r.cum >= 0 ? "+" : ""}${r.cum.toFixed(0)}% (연 ${r.cagr >= 0 ? "+" : ""}${r.cagr.toFixed(1)}%)  MDD ${r.mdd.toFixed(0)}%  노출 ${r.expo.toFixed(0)}%  거래 ${r.trades}회 승률 ${r.winRate.toFixed(0)}%`;
}

async function main() {
  for (const sym of SYMBOLS) {
    const bars = await fetchDailyPredict(sym, DAYS);
    if (bars.length < WARMUP + 30) { console.log(`${sym}: 일봉 부족`); continue; }
    const n = bars.length;
    const stanceArr = MODELS.map((m) => m.run(bars));
    const idx: Record<string, Stance[]> = Object.fromEntries(MODELS.map((m, j) => [m.id, stanceArr[j]]));
    const first = WARMUP, simEnd = n - 1;
    const atr = atr14(bars);
    const rets: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) rets[i] = bars[i].close / bars[i - 1].close - 1;
    const vol20: (number | null)[] = new Array(n).fill(null);
    for (let i = 21; i < n; i++) {
      const w = rets.slice(i - 19, i + 1);
      const mean = w.reduce((a, b) => a + b, 0) / w.length;
      vol20[i] = Math.sqrt(w.reduce((s, v) => s + (v - mean) * (v - mean), 0) / w.length);
    }

    console.log(`\n${"═".repeat(100)}`);
    console.log(`■ ${sym} — ${bars[first].date} ~ ${bars[n - 1].date}`);

    // ── A. 호라이즌별 방향적중(리프트) — 전체 기간
    console.log(`\n── A. 며칠 뒤를 맞추는 게 가장 정확한가 (전체 기간, 적중률(리프트%p))`);
    const hs = [1, 2, 3, 4, 5];
    // 기준선
    const baseUp: Record<number, number> = {};
    for (const h of hs) {
      let up = 0, tot = 0;
      for (let i = first; i <= n - 1 - h; i++) {
        const r = bars[i + h].close / bars[i].close - 1;
        if (r === 0) continue;
        tot++; if (r > 0) up++;
      }
      baseUp[h] = up / tot;
    }
    console.log(`   기준선(무조건 상승 찍기)          ${hs.map((h) => `${(100 * baseUp[h]).toFixed(1)}%`.padEnd(16)).join("")}`);
    for (let m = 0; m < MODELS.length; m++) {
      const cells: string[] = [];
      for (const h of hs) {
        let hit = 0, tot = 0, blend = 0;
        for (let i = first; i <= n - 1 - h; i++) {
          const s = stanceArr[m][i];
          if (s === "flat") continue;
          const r = bars[i + h].close / bars[i].close - 1;
          if (r === 0) continue;
          tot++;
          if (Math.sign(r) === (s === "long" ? 1 : -1)) hit++;
          blend += s === "long" ? baseUp[h] : 1 - baseUp[h];
        }
        const acc = tot > 0 ? (100 * hit) / tot : NaN;
        const lift = tot > 0 ? acc - (100 * blend) / tot : NaN;
        cells.push(tot > 0 ? `${acc.toFixed(1)}%(${lift >= 0 ? "+" : ""}${lift.toFixed(1)})`.padEnd(16) : "—".padEnd(16));
      }
      console.log(`   ${MODELS[m].label.padEnd(24)} ${cells.join("")}`);
    }

    // ── B. 주식화 비율 정책
    const S = (id: string, i: number) => idx[id][i];
    const votes = (i: number) =>
      (["donchian", "wilder", "weinstein", "elder"] as const).reduce((a, id) => a + (S(id, i) === "long" ? 1 : S(id, i) === "short" ? -1 : 0), 0);
    const crashRecent = (i: number) => {
      for (const t of [i, i - 1]) {
        if (t >= 23 && vol20[t - 1] !== null && rets[t] <= -2 * vol20[t - 1]!) return true;
      }
      return false;
    };
    const expoP1 = (i: number) => (S("minervini", i) === "long" ? 1 : 0);
    const expoP2 = (i: number) => {
      const min = S("minervini", i);
      const v = votes(i);
      if (min === "long") return Math.min(1, 0.5 + 0.125 * Math.max(0, v));
      if (min === "flat") return S("weinstein", i) === "long" && v >= 2 ? 0.25 : 0;
      return 0;
    };
    const expoP3 = (i: number) => {
      let f = expoP2(i);
      if (f > 0) {
        if (S("nison", i) === "short") f *= 0.5; // 캔들 경고
        if (crashRecent(i)) f *= 0.5; // 급락 직후 저신뢰 구간
      }
      return f;
    };
    // P4 5단계 사다리 (사용자 제안 2026-07-22): 추가매수(100)/기본(75)/현금화중(25 — 미너비니 이탈이나
    // 와인스타인 장기추세 생존)/현금화강(0). 현금화약(50)은 라이브에서 매크로 게이트 ×0.5가 담당.
    const expoP4 = (i: number) => {
      const min = S("minervini", i);
      if (min === "long") return votes(i) >= 3 ? 1 : 0.75;
      if (min === "flat") return S("weinstein", i) === "long" ? 0.25 : 0;
      return 0;
    };
    const policies: { name: string; expo: (i: number) => number }[] = [
      { name: "P0 계속 보유 (B&H)", expo: () => 1 },
      { name: "P1 미너비니 이진(100/0)", expo: expoP1 },
      { name: "P2 강도 티어(투표 가감)", expo: expoP2 },
      { name: "P3 티어+위험감산", expo: expoP3 },
      { name: "P4 5단계 사다리(사용자안)", expo: expoP4 },
    ];
    const windows = [
      { name: "전체", from: first },
      { name: "최근 3년", from: Math.max(first, simEnd - 750) },
    ];
    console.log(`\n── B. 주식화 비율 정책 (오버레이 없음, 비용 반영 복리)`);
    for (const w of windows) {
      console.log(`   [${w.name}]`);
      for (const p of policies) {
        const r = sim(bars, w.from, simEnd, p.expo, { name: "none" }, atr);
        console.log(`     ${p.name.padEnd(26)} ${fmt(r)}`);
      }
    }

    // ── C. 오버레이 (손절·트레일링·이익실현) — P1·P3 위에 검증
    const overlays: Ov[] = [
      { name: "없음" },
      { name: "손절 -5%" , slPct: 0.05 },
      { name: "손절 -8%", slPct: 0.08 },
      { name: "손절 2×ATR", slAtr: 2 },
      { name: "손절 2.5×ATR", slAtr: 2.5 },
      { name: "손절 3×ATR", slAtr: 3 },
      { name: "트레일링 -8%", trPct: 0.08 },
      { name: "트레일링 -12%", trPct: 0.12 },
      { name: "트레일링 3×ATR", trAtr: 3 },
      { name: "이익실현 +10%", tpPct: 0.1 },
      { name: "이익실현 +20%", tpPct: 0.2 },
      { name: "손절-8% + 트레일링-12%", slPct: 0.08, trPct: 0.12 },
      { name: "손절-8% + 이익실현+20%", slPct: 0.08, tpPct: 0.2 },
    ];
    for (const base of [{ name: "P1 이진", expo: expoP1 }, { name: "P4 5단계 사다리", expo: expoP4 }]) {
      console.log(`\n── C. 오버레이 검증 — ${base.name} 기반`);
      for (const w of windows) {
        console.log(`   [${w.name}]`);
        for (const ov of overlays) {
          const r = sim(bars, w.from, simEnd, base.expo, ov, atr);
          console.log(`     ${ov.name.padEnd(26)} ${fmt(r)}`);
        }
      }
    }

    // 오늘 강도·비율
    const t = n - 1;
    console.log(`\n   ▸ 오늘(${bars[t].date} 종가): 미너비니=${S("minervini", t)}, 투표합=${votes(t)}, 니슨경고=${S("nison", t) === "short"}, 급락직후=${crashRecent(t)} → P3 주식화 비율 ${(expoP3(t) * 100).toFixed(0)}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
