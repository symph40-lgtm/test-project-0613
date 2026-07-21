// 장세(레짐) 탐지기 비교 — "장기 추세 + 깊은 산·골"을 빠르고 정확하게 맞추는 레이어 연구.
//   npx tsx scripts/daily-swing-regime.ts
// 기획: docs/predict-daily-spec.md (사용자 지시 2026-07-22: 장세 판단 우선 → 장세별 모델 가동).
// 정답: 지그재그 20% 사후 피벗(깊은 꼭지·바닥). 탐지기는 전부 인과적(당일 종가까지만).

import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";
import { MODELS, sma, ema, isoWeekKey, type Stance } from "./daily-swing-models";

const WARMUP = 272, BUY = 0.00015, SELL = 0.00215;
type Regime = "up" | "down" | "range";

// ── 지그재그 (종가, 임계 20%) — 사후 정답용
function zigzag(bars: PredictDailyBar[], th = 0.2): { idx: number; type: "peak" | "valley" }[] {
  const c = bars.map((b) => b.close);
  const piv: { idx: number; type: "peak" | "valley" }[] = [];
  let dir = 0, hiIdx = 0, loIdx = 0; // 다음 꼭지/바닥 후보 추적
  for (let i = 1; i < c.length; i++) {
    if (c[i] > c[hiIdx]) hiIdx = i;
    if (c[i] < c[loIdx]) loIdx = i;
    if (dir >= 0 && c[i] <= c[hiIdx] * (1 - th)) {
      piv.push({ idx: hiIdx, type: "peak" });
      dir = -1; loIdx = i; // 바닥 후보는 꼭지 확정 시점부터 다시 추적
    } else if (dir <= 0 && c[i] >= c[loIdx] * (1 + th)) {
      piv.push({ idx: loIdx, type: "valley" });
      dir = 1; hiIdx = i;
    }
  }
  return piv;
}

// ── ATR (와일더, 기간 지정)
function atrN(bars: PredictDailyBar[], period: number): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let prev: number | null = null, sum = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (prev === null) { sum += tr; if (i === period) { prev = sum / period; out[i] = prev; } }
    else { prev = (prev * (period - 1) + tr) / period; out[i] = prev; }
  }
  return out;
}

// ── 수퍼트렌드 (10, 3) — ATR 추적선. 급변 장세 반응형 레짐 탐지기
function supertrend(bars: PredictDailyBar[]): Regime[] {
  const n = bars.length;
  const atr = atrN(bars, 10);
  const out: Regime[] = new Array(n).fill("range");
  let fu = NaN, fl = NaN, trendUp = true;
  for (let i = 11; i < n; i++) {
    const mid = (bars[i].high + bars[i].low) / 2;
    const bu = mid + 3 * atr[i]!, bl = mid - 3 * atr[i]!;
    fu = isNaN(fu) || bu < fu || bars[i - 1].close > fu ? bu : fu;
    fl = isNaN(fl) || bl > fl || bars[i - 1].close < fl ? bl : fl;
    if (trendUp && bars[i].close < fl) trendUp = false;
    else if (!trendUp && bars[i].close > fu) trendUp = true;
    out[i] = trendUp ? "up" : "down";
  }
  return out;
}

async function main() {
  for (const [code, name] of [["005930", "삼성전자"], ["000660", "SK하이닉스"]] as const) {
    const bars = await fetchDailyPredict(code, 2600);
    const n = bars.length;
    const closes = bars.map((b) => b.close);
    const st = new Map<string, Stance[]>(MODELS.map((m) => [m.id, m.run(bars)]));
    const S = (id: string, i: number) => st.get(id)![i];

    // ── 탐지기들 (일별 Regime)
    const ma50 = sma(closes, 50), ma150 = sma(closes, 150), ma200 = sma(closes, 200);
    const stnd = supertrend(bars);
    const hi252 = (i: number) => { let h = -Infinity; for (let j = Math.max(0, i - 251); j <= i; j++) h = Math.max(h, closes[j]); return h; };
    // 엘더 조류 (완결 주 EMA13 기울기)
    const weekKeys = bars.map((b) => isoWeekKey(b.date));
    const wkKey: string[] = [], wkClose: number[] = [];
    for (let i = 0; i < n; i++) {
      if (wkKey.length && wkKey[wkKey.length - 1] === weekKeys[i]) wkClose[wkClose.length - 1] = closes[i];
      else { wkKey.push(weekKeys[i]); wkClose.push(closes[i]); }
    }
    const wkEma = ema(wkClose, 13);
    const wkIdx = new Map(wkKey.map((k, j) => [k, j]));

    const detectors: { id: string; label: string; at: (i: number) => Regime }[] = [
      { id: "minervini", label: "미너비니 템플릿(현행 판정자)", at: (i) => (S("minervini", i) === "long" ? "up" : S("minervini", i) === "short" ? "down" : "range") },
      { id: "weinstein", label: "와인스타인 MA150(현행 완충)", at: (i) => (S("weinstein", i) === "long" ? "up" : S("weinstein", i) === "short" ? "down" : "range") },
      { id: "cross", label: "골든/데드크로스 50·200", at: (i) => (ma50[i] === null || ma200[i] === null ? "range" : ma50[i]! > ma200[i]! * 1.01 ? "up" : ma50[i]! < ma200[i]! * 0.99 ? "down" : "range") },
      { id: "supertrend", label: "수퍼트렌드(10,3) ATR추적", at: (i) => stnd[i] },
      { id: "dd", label: "52주 낙폭(−12%/−20%)", at: (i) => { const d = closes[i] / hi252(i) - 1; return d >= -0.12 ? "up" : d <= -0.2 ? "down" : "range"; } },
      { id: "tide", label: "엘더 조류(주봉 EMA13)", at: (i) => { const w = wkIdx.get(weekKeys[i])!; if (w < 2 || wkEma[w - 1] === null || wkEma[w - 2] === null) return "range"; return wkEma[w - 1]! > wkEma[w - 2]! ? "up" : "down"; } },
      { id: "combo", label: "조합(와인·수퍼·낙폭 2/3표)", at: (i) => {
          let u = 0, d = 0;
          for (const id of ["weinstein", "supertrend", "dd"]) {
            const r = detectors.find((x) => x.id === id)!.at(i);
            if (r === "up") u++; else if (r === "down") d++;
          }
          return u >= 2 ? "up" : d >= 2 ? "down" : "range";
        } },
    ];

    const piv = zigzag(bars).filter((p) => p.idx >= WARMUP && p.idx < n - 5);
    const peaks = piv.filter((p) => p.type === "peak"), valleys = piv.filter((p) => p.type === "valley");
    console.log(`\n■ ${name} — 지그재그 20% 깊은 꼭지 ${peaks.length}개·바닥 ${valleys.length}개 (채점 ${bars[WARMUP].date}~)`);
    console.log(`   탐지기                         꼭지→이탈 평균(최악)     바닥→진입 평균     전환/년   [상승100/변동25/하락0] 누적  MDD`);

    for (const det of detectors) {
      // 꼭지: "up"에서 벗어나는 첫 신호까지의 손실
      let exitSum = 0, exitWorst = 0, exitN = 0;
      for (const p of peaks) {
        for (let i = p.idx + 1; i < n; i++) {
          if (det.at(i) !== "up") { const loss = closes[i] / closes[p.idx] - 1; exitSum += loss; exitWorst = Math.min(exitWorst, loss); exitN++; break; }
        }
      }
      // 바닥: "up" 복귀 첫 신호까지 놓친 상승
      let entSum = 0, entN = 0;
      for (const v of valleys) {
        for (let i = v.idx + 1; i < n; i++) {
          if (det.at(i) === "up") { entSum += closes[i] / closes[v.idx] - 1; entN++; break; }
        }
      }
      // 전환 빈도
      let flips = 0;
      for (let i = WARMUP + 1; i < n; i++) if (det.at(i) !== det.at(i - 1)) flips++;
      const years = (n - WARMUP) / 248;
      // 경제성: up=1 / range=0.25 / down=0
      let V = 1, peakV = 1, mdd = 0, f = 0;
      for (let i = WARMUP; i < n - 1; i++) {
        const r = det.at(i);
        const t = r === "up" ? 1 : r === "range" ? 0.25 : 0;
        if (t !== f) { const d2 = t - f; V *= 1 - (d2 > 0 ? d2 * BUY : -d2 * SELL); f = t; }
        V *= 1 + f * (closes[i + 1] / closes[i] - 1);
        peakV = Math.max(peakV, V); mdd = Math.max(mdd, 1 - V / peakV);
      }
      const pc = (x: number) => `${(100 * x).toFixed(1)}%`;
      console.log(
        `   ${det.label.padEnd(26)} ${exitN ? `${pc(exitSum / exitN)} (${pc(exitWorst)})` : "—"}`.padEnd(52) +
        ` ${entN ? pc(entSum / entN) : "—"}`.padStart(8) +
        `   ${(flips / years).toFixed(1)}`.padStart(7) +
        `      누적 ${V - 1 >= 0 ? "+" : ""}${((V - 1) * 100).toFixed(0)}%  MDD ${(mdd * 100).toFixed(0)}%`
      );
    }

    // 이번 꼭지(최근 60일 내 최고 종가)에서 각 탐지기의 실제 탈출일
    let pkIdx = n - 1;
    for (let i = n - 60; i < n; i++) if (closes[i] > closes[pkIdx]) pkIdx = i;
    console.log(`   ▸ 이번 꼭지 ${bars[pkIdx].date} (${closes[pkIdx].toLocaleString()}) → 현재 ${closes[n - 1].toLocaleString()} (${pc2(closes[n - 1] / closes[pkIdx] - 1)}):`);
    for (const det of detectors) {
      let out = "아직 상승 유지";
      for (let i = pkIdx + 1; i < n; i++) {
        if (det.at(i) !== "up") { out = `${bars[i].date} 이탈 (그 시점 손실 ${pc2(closes[i] / closes[pkIdx] - 1)})`; break; }
      }
      console.log(`     ${det.label.padEnd(26)} ${out}`);
    }
  }
}

const pc2 = (x: number) => `${(100 * x).toFixed(1)}%`;

main().catch((e) => { console.error(e); process.exit(1); });
