// 일봉 스윙 예측 — 대가 6모델 백테스트. 기획: docs/predict-daily-spec.md 3~4장.
//   npx tsx scripts/daily-swing-backtest.ts                  # 005930 + 000660, 2600봉
//   npx tsx scripts/daily-swing-backtest.ts --symbol 000660  # 단일 종목
//   npx tsx scripts/daily-swing-backtest.ts --days 1300      # 봉 수 지정
//
// 미래 정보 차단: t일 스탠스는 t일 종가까지의 일봉만 입력. 채점은 t→t+1/3/5 종가와 t+1 시가 갭.
// lib/predict-daily 본체 착수 전의 모델 선정용 — lib에 의존하지 않는 자체 지표 구현(데이터 조회만 공용).

import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";

type Stance = "long" | "short" | "flat";

const args = process.argv.slice(2);
function argOf(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const DAYS = parseInt(argOf("--days") ?? "2600", 10);
const SYMBOLS = argOf("--symbol") ? [argOf("--symbol")!] : ["005930", "000660"];
const WARMUP = 260; // 52주 지표 웜업

// ── 지표 ─────────────────────────────────────────────────────────────
function sma(vals: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(vals: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < vals.length; i++) {
    if (prev === null) {
      if (i === period - 1) {
        let s = 0;
        for (let j = 0; j < period; j++) s += vals[j];
        prev = s / period;
        out[i] = prev;
      }
    } else {
      prev = vals[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// 와일더 DMI/ADX (14)
type Dmi = { plusDi: (number | null)[]; minusDi: (number | null)[]; adx: (number | null)[] };
function dmiAdx(bars: PredictDailyBar[], period = 14): Dmi {
  const n = bars.length;
  const plusDi: (number | null)[] = new Array(n).fill(null);
  const minusDi: (number | null)[] = new Array(n).fill(null);
  const adx: (number | null)[] = new Array(n).fill(null);
  let smTr = 0, smPdm = 0, smMdm = 0, smInit = false;
  let adxVal: number | null = null;
  const dxs: number[] = [];
  let trSum = 0, pdmSum = 0, mdmSum = 0;
  for (let i = 1; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const up = b.high - p.high, dn = p.low - b.low;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    if (!smInit) {
      trSum += tr; pdmSum += pdm; mdmSum += mdm;
      if (i === period) { smTr = trSum; smPdm = pdmSum; smMdm = mdmSum; smInit = true; }
      else continue;
    } else {
      smTr = smTr - smTr / period + tr;
      smPdm = smPdm - smPdm / period + pdm;
      smMdm = smMdm - smMdm / period + mdm;
    }
    if (smTr <= 0) continue;
    const pdi = (100 * smPdm) / smTr, mdi = (100 * smMdm) / smTr;
    plusDi[i] = pdi; minusDi[i] = mdi;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (adxVal === null) {
      dxs.push(dx);
      if (dxs.length === period) adxVal = dxs.reduce((a, b) => a + b, 0) / period;
    } else adxVal = (adxVal * (period - 1) + dx) / period;
    adx[i] = adxVal;
  }
  return { plusDi, minusDi, adx };
}

// MACD 히스토그램 (12·26·9)
function macdHist(closes: number[]): (number | null)[] {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd: number[] = [];
  const macdIdx: number[] = [];
  for (let i = 0; i < closes.length; i++) if (e12[i] !== null && e26[i] !== null) { macd.push(e12[i]! - e26[i]!); macdIdx.push(i); }
  const sig = ema(macd, 9);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let j = 0; j < macd.length; j++) if (sig[j] !== null) out[macdIdx[j]] = macd[j] - sig[j]!;
  return out;
}

// ISO 주차 키 (엘더 주봉 리샘플)
function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - day + 3); // 그 주의 목요일
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-${String(week).padStart(2, "0")}`;
}

// ── 모델 6종: bars 전체를 받아 일별 스탠스 배열 반환 (t일 값은 t일 종가까지만 사용) ──
function runDonchian(bars: PredictDailyBar[]): Stance[] {
  const n = bars.length;
  const st: Stance[] = new Array(n).fill("flat");
  let pos: Stance = "flat";
  for (let i = 21; i < n; i++) {
    let hh20 = -Infinity, ll20 = Infinity, hh10 = -Infinity, ll10 = Infinity;
    for (let j = i - 20; j < i; j++) { hh20 = Math.max(hh20, bars[j].high); ll20 = Math.min(ll20, bars[j].low); }
    for (let j = i - 10; j < i; j++) { hh10 = Math.max(hh10, bars[j].high); ll10 = Math.min(ll10, bars[j].low); }
    const c = bars[i].close;
    if (pos === "long" && c <= ll10) pos = "flat";
    else if (pos === "short" && c >= hh10) pos = "flat";
    if (pos === "flat") {
      if (c >= hh20) pos = "long";
      else if (c <= ll20) pos = "short";
    }
    st[i] = pos;
  }
  return st;
}

function runWilder(bars: PredictDailyBar[]): Stance[] {
  const { plusDi, minusDi, adx } = dmiAdx(bars);
  return bars.map((_, i) => {
    if (plusDi[i] === null || adx[i] === null) return "flat";
    if (adx[i]! < 20) return "flat";
    return plusDi[i]! > minusDi[i]! ? "long" : minusDi[i]! > plusDi[i]! ? "short" : "flat";
  });
}

function runWeinstein(bars: PredictDailyBar[]): Stance[] {
  const closes = bars.map((b) => b.close);
  const ma150 = sma(closes, 150);
  return bars.map((b, i) => {
    if (i < 170 || ma150[i] === null || ma150[i - 20] === null) return "flat";
    const slopeUp = ma150[i]! > ma150[i - 20]!;
    if (b.close > ma150[i]! && slopeUp) return "long";
    if (b.close < ma150[i]! && !slopeUp) return "short";
    return "flat";
  });
}

function runElder(bars: PredictDailyBar[]): Stance[] {
  const closes = bars.map((b) => b.close);
  const e13 = ema(closes, 13);
  const hist = macdHist(closes);
  // 주봉 종가 시계열 (완결 주만 — 당일이 속한 주는 제외해 미래 정보 차단)
  const weekKeys = bars.map((b) => isoWeekKey(b.date));
  const weekCloseByKey: string[] = [];
  const weekCloses: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const k = weekKeys[i];
    if (weekCloseByKey.length > 0 && weekCloseByKey[weekCloseByKey.length - 1] === k) weekCloses[weekCloses.length - 1] = closes[i];
    else { weekCloseByKey.push(k); weekCloses.push(closes[i]); }
  }
  const weekEma = ema(weekCloses, 13);
  const weekIdxOfKey = new Map(weekCloseByKey.map((k, j) => [k, j]));
  return bars.map((_, i) => {
    if (i < 40 || e13[i] === null || e13[i - 1] === null || hist[i] === null || hist[i - 1] === null) return "flat";
    const wj = weekIdxOfKey.get(weekKeys[i])!;
    if (wj < 2 || weekEma[wj - 1] === null || weekEma[wj - 2] === null) return "flat";
    const tideUp = weekEma[wj - 1]! > weekEma[wj - 2]!; // 직전 완결 주 기준 조류
    const emaUp = e13[i]! > e13[i - 1]!, histUp = hist[i]! > hist[i - 1]!;
    if (tideUp && emaUp && histUp) return "long"; // 임펄스 green + 조류 상승
    if (!tideUp && !emaUp && !histUp) return "short"; // 임펄스 red + 조류 하락
    return "flat";
  });
}

function runRaschke(bars: PredictDailyBar[]): Stance[] {
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const { plusDi, minusDi, adx } = dmiAdx(bars);
  const n = bars.length;
  const st: Stance[] = new Array(n).fill("flat");
  let pos: Stance = "flat";
  let hold = 0;
  for (let i = 40; i < n; i++) {
    if (e20[i] === null || adx[i] === null || plusDi[i] === null) { st[i] = pos; continue; }
    const c = bars[i].close;
    if (pos === "long") {
      hold++;
      if (c < e20[i]! || hold >= 5) { pos = "flat"; hold = 0; }
    } else if (pos === "short") {
      hold++;
      if (c > e20[i]! || hold >= 5) { pos = "flat"; hold = 0; }
    }
    if (pos === "flat") {
      const upTrend = adx[i]! > 30 && plusDi[i]! > minusDi[i]!;
      const dnTrend = adx[i]! > 30 && minusDi[i]! > plusDi[i]!;
      if (upTrend && bars[i].low <= e20[i]! && c > e20[i]!) { pos = "long"; hold = 0; } // EMA20 터치 후 회복
      else if (dnTrend && bars[i].high >= e20[i]! && c < e20[i]!) { pos = "short"; hold = 0; }
    }
    st[i] = pos;
  }
  return st;
}

function runMinervini(bars: PredictDailyBar[]): Stance[] {
  const closes = bars.map((b) => b.close);
  const ma50 = sma(closes, 50), ma150 = sma(closes, 150), ma200 = sma(closes, 200);
  return bars.map((b, i) => {
    if (i < 252 || ma200[i] === null || ma200[i - 20] === null) return "flat";
    let lo52 = Infinity, hi52 = -Infinity;
    for (let j = i - 251; j <= i; j++) { lo52 = Math.min(lo52, bars[j].low); hi52 = Math.max(hi52, bars[j].high); }
    const c = b.close;
    const longOk = c > ma50[i]! && ma50[i]! > ma150[i]! && ma150[i]! > ma200[i]! && ma200[i]! > ma200[i - 20]! && c >= lo52 * 1.3 && c >= hi52 * 0.75;
    const shortOk = c < ma50[i]! && ma50[i]! < ma150[i]! && ma150[i]! < ma200[i]! && ma200[i]! < ma200[i - 20]! && c <= hi52 * 0.7 && c <= lo52 * 1.25;
    return longOk ? "long" : shortOk ? "short" : "flat";
  });
}

const MODELS: { id: string; label: string; run: (bars: PredictDailyBar[]) => Stance[] }[] = [
  { id: "donchian", label: "돈치안·터틀 (20/10 채널)", run: runDonchian },
  { id: "wilder", label: "와일더 (DMI/ADX)", run: runWilder },
  { id: "weinstein", label: "와인스타인 (스테이지)", run: runWeinstein },
  { id: "elder", label: "엘더 (삼중창+임펄스)", run: runElder },
  { id: "raschke", label: "라쉬케 (Holy Grail)", run: runRaschke },
  { id: "minervini", label: "미너비니 (추세 템플릿)", run: runMinervini },
];

// ── 채점 ─────────────────────────────────────────────────────────────
type Score = {
  days: number; long: number; short: number;
  acc1: [number, number]; acc3: [number, number]; acc5: [number, number]; // [적중, 표본]
  gapAcc: [number, number];
  signedCum: number; longOnlyCum: number; // 스탠스 추종 r1 합 (%p)
};

function emptyScore(): Score {
  return { days: 0, long: 0, short: 0, acc1: [0, 0], acc3: [0, 0], acc5: [0, 0], gapAcc: [0, 0], signedCum: 0, longOnlyCum: 0 };
}

function pct(a: [number, number]): string {
  return a[1] > 0 ? `${((100 * a[0]) / a[1]).toFixed(1)}%` : "—";
}

async function main() {
  for (const sym of SYMBOLS) {
    const bars = await fetchDailyPredict(sym, DAYS);
    if (bars.length < WARMUP + 30) { console.log(`${sym}: 일봉 부족 (${bars.length})`); continue; }
    const n = bars.length;
    const stances = MODELS.map((m) => m.run(bars));
    const first = WARMUP, last = n - 6; // t+5까지 채점 가능 범위

    // 구간: 전체 / 최근 3년(750봉) / 최근 1년(250봉)
    const periods: { name: string; from: number }[] = [
      { name: `전체 (${bars[first].date}~)`, from: first },
      { name: "최근 3년", from: Math.max(first, last - 750) },
      { name: "최근 1년", from: Math.max(first, last - 250) },
    ];

    console.log(`\n${"═".repeat(100)}`);
    console.log(`■ ${sym} — 일봉 ${n}개 (${bars[0].date} ~ ${bars[n - 1].date}), 채점 ${bars[first].date} ~ ${bars[last].date}`);

    for (const period of periods) {
      // 기준선
      let up1 = 0, up3 = 0, up5 = 0, tot = 0, bh = 0;
      for (let i = period.from; i <= last; i++) {
        const r1 = bars[i + 1].close / bars[i].close - 1;
        const r3 = bars[i + 3].close / bars[i].close - 1;
        const r5 = bars[i + 5].close / bars[i].close - 1;
        if (r1 > 0) up1++; if (r3 > 0) up3++; if (r5 > 0) up5++;
        tot++; bh += r1 * 100;
      }
      console.log(`\n── ${period.name}: ${tot}일, 상승일 비율 r1 ${((100 * up1) / tot).toFixed(1)}% · r3 ${((100 * up3) / tot).toFixed(1)}% · r5 ${((100 * up5) / tot).toFixed(1)}%, Buy&Hold(r1합) ${bh >= 0 ? "+" : ""}${bh.toFixed(1)}%p`);
      console.log(`   모델                          판정일(L/S)      r1적중    r3적중(리프트)   r5적중    갭적중    롱온리누적  롱숏누적`);

      for (let m = 0; m < MODELS.length; m++) {
        const s = emptyScore();
        let base3Blend = 0; // 판정 방향 기준 우연 적중 기대 (long→P(r3>0), short→P(r3<0))
        for (let i = period.from; i <= last; i++) {
          const stance = stances[m][i];
          const r1 = bars[i + 1].close / bars[i].close - 1;
          if (stance === "long") s.longOnlyCum += r1 * 100;
          if (stance === "flat") continue;
          const r3 = bars[i + 3].close / bars[i].close - 1;
          const r5 = bars[i + 5].close / bars[i].close - 1;
          const gap = bars[i + 1].open / bars[i].close - 1;
          s.days++;
          if (stance === "long") s.long++; else s.short++;
          s.signedCum += (stance === "long" ? r1 : -r1) * 100;
          const want = stance === "long" ? 1 : -1;
          if (r1 !== 0) { s.acc1[1]++; if (Math.sign(r1) === want) s.acc1[0]++; }
          if (r3 !== 0) { s.acc3[1]++; if (Math.sign(r3) === want) s.acc3[0]++; }
          if (r5 !== 0) { s.acc5[1]++; if (Math.sign(r5) === want) s.acc5[0]++; }
          if (Math.abs(gap) >= 0.001) { s.gapAcc[1]++; if (Math.sign(gap) === want) s.gapAcc[0]++; }
          base3Blend += stance === "long" ? up3 / tot : 1 - up3 / tot;
        }
        const lift3 = s.acc3[1] > 0 ? (100 * s.acc3[0]) / s.acc3[1] - (100 * base3Blend) / s.days : 0;
        const name = MODELS[m].label.padEnd(24, " ");
        console.log(
          `   ${name} ${String(s.days).padStart(4)} (${s.long}/${s.short})`.padEnd(48) +
          ` ${pct(s.acc1).padStart(6)}   ${pct(s.acc3).padStart(6)} (${lift3 >= 0 ? "+" : ""}${lift3.toFixed(1)}%p)`.padEnd(22) +
          `  ${pct(s.acc5).padStart(6)}   ${pct(s.gapAcc).padStart(6)}   ${(s.longOnlyCum >= 0 ? "+" : "") + s.longOnlyCum.toFixed(1)}%p`.padEnd(12) +
          `  ${(s.signedCum >= 0 ? "+" : "") + s.signedCum.toFixed(1)}%p`
        );
      }
    }

    // 오늘 스탠스
    console.log(`\n   ▸ 현재 스탠스 (${bars[n - 1].date} 종가 기준): ` + MODELS.map((m, j) => `${m.id}=${stances[j][n - 1]}`).join(", "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
