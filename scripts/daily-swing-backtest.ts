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

// 니슨 캔들 패턴 (7번째, 2026-07 사용자 질문 "일봉 모양도 참고하나"로 편입 검증):
// 망치형(하락 후 긴 아랫꼬리)·유성형(상승 후 긴 윗꼬리)·상승/하락 장악형. 신호 후 3일 보유.
function runNison(bars: PredictDailyBar[]): Stance[] {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const st: Stance[] = new Array(n).fill("flat");
  let pos: Stance = "flat";
  let hold = 0;
  for (let i = 25; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    const range = b.high - b.low;
    if (pos !== "flat") {
      hold++;
      if (hold >= 3) { pos = "flat"; hold = 0; }
    }
    if (range > 0 && e20[i] !== null) {
      const body = Math.abs(b.close - b.open);
      const upW = b.high - Math.max(b.open, b.close);
      const lowW = Math.min(b.open, b.close) - b.low;
      const afterDecline = b.close < e20[i]!; // 하락 국면
      const afterRise = b.close > e20[i]!;
      const hammer = afterDecline && lowW >= 2 * body && upW <= body; // 망치형
      const shootingStar = afterRise && upW >= 2 * body && lowW <= body; // 유성형
      const bullEngulf = afterDecline && p.close < p.open && b.close > b.open && b.open <= p.close && b.close >= p.open; // 상승장악형
      const bearEngulf = afterRise && p.close > p.open && b.close < b.open && b.open >= p.close && b.close <= p.open; // 하락장악형
      if (hammer || bullEngulf) { pos = "long"; hold = 0; }
      else if (shootingStar || bearEngulf) { pos = "short"; hold = 0; }
    }
    st[i] = pos;
  }
  return st;
}

const MODELS: { id: string; label: string; run: (bars: PredictDailyBar[]) => Stance[] }[] = [
  { id: "donchian", label: "돈치안·터틀 (20/10 채널)", run: runDonchian },
  { id: "wilder", label: "와일더 (DMI/ADX)", run: runWilder },
  { id: "weinstein", label: "와인스타인 (스테이지)", run: runWeinstein },
  { id: "elder", label: "엘더 (삼중창+임펄스)", run: runElder },
  { id: "raschke", label: "라쉬케 (Holy Grail)", run: runRaschke },
  { id: "minervini", label: "미너비니 (추세 템플릿)", run: runMinervini },
  { id: "nison", label: "니슨 (캔들 패턴)", run: runNison },
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

    // ── 큰 변동일 조건부 채점 — "크게 움직인 날을 맞췄는가" (사용자 제안 2026-07)
    // 임계: |r3| 고정 3%·5% + 변동성 상대(판정일 기준 20일 일수익 σ × √3 × 1.5 — 종목·레짐별 변동성 자동 반영)
    const rets: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) rets[i] = bars[i].close / bars[i - 1].close - 1;
    const vol20: (number | null)[] = new Array(n).fill(null);
    for (let i = 21; i < n; i++) {
      const w = rets.slice(i - 19, i + 1);
      const mean = w.reduce((a, b) => a + b, 0) / w.length;
      vol20[i] = Math.sqrt(w.reduce((s, v) => s + (v - mean) * (v - mean), 0) / w.length);
    }
    const mar26 = bars.findIndex((b) => b.date >= "2026-03-01");
    const bigPeriods: { name: string; from: number }[] = [
      { name: "전체", from: first },
      { name: "최근 1년", from: Math.max(first, last - 250) },
      ...(mar26 >= 0 && mar26 <= last - 20 ? [{ name: "2026-03 이후", from: Math.max(first, mar26) }] : []),
    ];
    type Cond = { name: string; test: (i: number, r3: number) => boolean };
    const conds: Cond[] = [
      { name: "|r3|≥3%", test: (_i, r3) => Math.abs(r3) >= 0.03 },
      { name: "|r3|≥5%", test: (_i, r3) => Math.abs(r3) >= 0.05 },
      { name: "상대 1.5σ√3", test: (i, r3) => vol20[i] !== null && Math.abs(r3) >= 1.5 * vol20[i]! * Math.sqrt(3) },
    ];

    for (const period of bigPeriods) {
      const lines: string[] = [];
      const heads: string[] = [];
      for (const cond of conds) {
        let qual = 0, qualUp = 0;
        for (let i = period.from; i <= last; i++) {
          const r3 = bars[i + 3].close / bars[i].close - 1;
          if (r3 !== 0 && cond.test(i, r3)) { qual++; if (r3 > 0) qualUp++; }
        }
        heads.push(`${cond.name}: 해당 ${qual}일(${((100 * qual) / (last - period.from + 1)).toFixed(0)}%), 상승 ${qual > 0 ? ((100 * qualUp) / qual).toFixed(0) : "—"}%`);
      }
      console.log(`\n── 큰 변동일 r3 채점 [${period.name}] — ${heads.join(" · ")}`);
      console.log(`   모델                          ${conds.map((c) => c.name.padEnd(22)).join("")}`);
      for (let m = 0; m < MODELS.length; m++) {
        const cells: string[] = [];
        for (const cond of conds) {
          let hit = 0, tot2 = 0, baseBlend = 0;
          let condUp = 0, condN = 0;
          for (let i = period.from; i <= last; i++) {
            const r3 = bars[i + 3].close / bars[i].close - 1;
            if (r3 === 0 || !cond.test(i, r3)) continue;
            condN++; if (r3 > 0) condUp++;
          }
          for (let i = period.from; i <= last; i++) {
            const stance = stances[m][i];
            if (stance === "flat") continue;
            const r3 = bars[i + 3].close / bars[i].close - 1;
            if (r3 === 0 || !cond.test(i, r3)) continue;
            tot2++;
            const want = stance === "long" ? 1 : -1;
            if (Math.sign(r3) === want) hit++;
            baseBlend += stance === "long" ? condUp / condN : 1 - condUp / condN;
          }
          const acc = tot2 > 0 ? (100 * hit) / tot2 : NaN;
          const lift = tot2 > 0 ? acc - (100 * baseBlend) / tot2 : NaN;
          cells.push(tot2 > 0 ? `${acc.toFixed(0)}% (${lift >= 0 ? "+" : ""}${lift.toFixed(1)}p, ${tot2})`.padEnd(22) : "—".padEnd(22));
        }
        console.log(`   ${MODELS[m].label.padEnd(24)} ${cells.join("")}`);
      }

      // 급변일 전일 스탠스 — 익일 |r1| ≥ 2σ: 급락일에 long이면 피격, flat이면 회피, short면 수익
      let dnN = 0, upN = 0;
      const dist: { dn: Record<Stance, number>; up: Record<Stance, number> }[] = MODELS.map(() => ({ dn: { long: 0, short: 0, flat: 0 }, up: { long: 0, short: 0, flat: 0 } }));
      for (let i = period.from; i <= last; i++) {
        if (vol20[i] === null) continue;
        const r1 = bars[i + 1].close / bars[i].close - 1;
        const big = Math.abs(r1) >= 2 * vol20[i]!;
        if (!big) continue;
        if (r1 < 0) { dnN++; for (let m = 0; m < MODELS.length; m++) dist[m].dn[stances[m][i]]++; }
        else { upN++; for (let m = 0; m < MODELS.length; m++) dist[m].up[stances[m][i]]++; }
      }
      console.log(`   ▸ 급변일(익일 |r1|≥2σ) 전일 스탠스 — 급락 ${dnN}일 · 급등 ${upN}일  [급락: 매도수익/중립회피/매수피격 | 급등: 매수포착/중립/매도역행]`);
      for (let m = 0; m < MODELS.length; m++) {
        const d = dist[m];
        const f = (x: number, tot: number) => (tot > 0 ? `${((100 * x) / tot).toFixed(0)}%` : "—");
        console.log(`     ${MODELS[m].label.padEnd(24)} 급락: ${f(d.dn.short, dnN)}/${f(d.dn.flat, dnN)}/${f(d.dn.long, dnN)}  |  급등: ${f(d.up.long, upN)}/${f(d.up.flat, upN)}/${f(d.up.short, upN)}`);
      }
    }

    // ── 급락 후 대응 — "첫날은 놓쳐도 다음날·다다음날은 맞추는가" (사용자 질문 2026-07)
    // 급락일 t: 당일 수익 ≤ -2σ (σ는 전일 기준 — 급락 자체로 σ가 부풀지 않게). 채점:
    //   당일 종가 판정 stance[t] → r1(t→t+1)·r3(t→t+3), 익일 종가 판정 stance[t+1] → r3(t+1→t+4)
    for (const period of [{ name: "전체", from: first }, { name: "최근 3년", from: Math.max(first, last - 750) }]) {
      const crashes: number[] = [];
      for (let i = Math.max(period.from, 23); i <= last - 1; i++) {
        if (vol20[i - 1] !== null && rets[i] <= -2 * vol20[i - 1]!) crashes.push(i);
      }
      if (crashes.length === 0) continue;
      let reb1 = 0, reb3 = 0, tailN = 0, tailReb = 0, noTailN = 0, noTailReb = 0;
      for (const t of crashes) {
        const r1n = bars[t + 1].close / bars[t].close - 1;
        const r3n = bars[t + 3].close / bars[t].close - 1;
        if (r1n > 0) reb1++;
        if (r3n > 0) reb3++;
        const b = bars[t], range = b.high - b.low;
        const lowW = range > 0 ? (Math.min(b.open, b.close) - b.low) / range : 0;
        if (lowW >= 0.35) { tailN++; if (r3n > 0) tailReb++; } // 아랫꼬리가 레인지 35%+ = 하단 매수 방어 흔적
        else { noTailN++; if (r3n > 0) noTailReb++; }
      }
      const fp = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : "—");
      console.log(`\n── 급락 후 대응 [${period.name}] — 급락일(≤-2σ) ${crashes.length}일 · 익일 반등 ${fp(reb1, crashes.length)} · 3일 후 상승 ${fp(reb3, crashes.length)}`);
      console.log(`   급락일 캔들 아랫꼬리(레인지 35%+) ${tailN}일 → 3일 상승 ${fp(tailReb, tailN)}  |  꼬리 미미 ${noTailN}일 → ${fp(noTailReb, noTailN)}`);
      console.log(`   모델                          당일종가 스탠스(S/F/L)   r1적중   r3적중   | 익일종가 스탠스(S/F/L)   r3적중`);
      for (let m = 0; m < MODELS.length; m++) {
        const c0: Record<Stance, number> = { long: 0, short: 0, flat: 0 };
        const c1: Record<Stance, number> = { long: 0, short: 0, flat: 0 };
        let h1 = 0, t1 = 0, h3 = 0, t3 = 0, h3b = 0, t3b = 0;
        for (const t of crashes) {
          const s0 = stances[m][t];
          c0[s0]++;
          if (s0 !== "flat") {
            const want = s0 === "long" ? 1 : -1;
            const r1n = bars[t + 1].close / bars[t].close - 1;
            const r3n = bars[t + 3].close / bars[t].close - 1;
            if (r1n !== 0) { t1++; if (Math.sign(r1n) === want) h1++; }
            if (r3n !== 0) { t3++; if (Math.sign(r3n) === want) h3++; }
          }
          if (t + 4 <= n - 1) {
            const s1 = stances[m][t + 1];
            c1[s1]++;
            if (s1 !== "flat") {
              const want = s1 === "long" ? 1 : -1;
              const r3n = bars[t + 4].close / bars[t + 1].close - 1;
              if (r3n !== 0) { t3b++; if (Math.sign(r3n) === want) h3b++; }
            }
          }
        }
        const N = crashes.length;
        console.log(
          `   ${MODELS[m].label.padEnd(24)} ${fp(c0.short, N)}/${fp(c0.flat, N)}/${fp(c0.long, N)}`.padEnd(52) +
          ` ${fp(h1, t1).padStart(5)}(${t1})  ${fp(h3, t3).padStart(5)}(${t3})  | ${fp(c1.short, N)}/${fp(c1.flat, N)}/${fp(c1.long, N)}`.padEnd(40) +
          `  ${fp(h3b, t3b).padStart(5)}(${t3b})`
        );
      }
    }

    // 오늘 스탠스
    console.log(`\n   ▸ 현재 스탠스 (${bars[n - 1].date} 종가 기준): ` + MODELS.map((m, j) => `${m.id}=${stances[j][n - 1]}`).join(", "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
