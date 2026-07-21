// 일봉 스윙 — 대가 7모델 + 지표. 기획: docs/predict-daily-spec.md 3장.
// 백테스트(scripts/daily-swing-*.ts)와 라이브 서비스가 같은 코드를 사용 — 수정 시 반드시 백테스트 재실행.
// t일 스탠스는 t일 종가까지의 일봉만 사용 (미래 정보 차단).

import type { DailyBar, Stance } from "./types";
export type { DailyBar, Stance } from "./types";

// ── 지표 ─────────────────────────────────────────────────────────────
export function sma(vals: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(vals: number[], period: number): (number | null)[] {
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
export type Dmi = { plusDi: (number | null)[]; minusDi: (number | null)[]; adx: (number | null)[] };
export function dmiAdx(bars: DailyBar[], period = 14): Dmi {
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
export function macdHist(closes: number[]): (number | null)[] {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd: number[] = [];
  const macdIdx: number[] = [];
  for (let i = 0; i < closes.length; i++) if (e12[i] !== null && e26[i] !== null) { macd.push(e12[i]! - e26[i]!); macdIdx.push(i); }
  const sig = ema(macd, 9);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let j = 0; j < macd.length; j++) if (sig[j] !== null) out[macdIdx[j]] = macd[j] - sig[j]!;
  return out;
}

// ATR14 (와일더 평활)
export function atr14(bars: DailyBar[]): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let prev: number | null = null;
  let sum = 0;
  for (let i = 1; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    if (prev === null) {
      sum += tr;
      if (i === 14) { prev = sum / 14; out[i] = prev; }
    } else {
      prev = (prev * 13 + tr) / 14;
      out[i] = prev;
    }
  }
  return out;
}

// ISO 주차 키 (엘더 주봉 리샘플)
export function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - day + 3); // 그 주의 목요일
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-${String(week).padStart(2, "0")}`;
}

// ── 모델 7종: bars 전체를 받아 일별 스탠스 배열 반환 ─────────────────
function runDonchian(bars: DailyBar[]): Stance[] {
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

function runWilder(bars: DailyBar[]): Stance[] {
  const { plusDi, minusDi, adx } = dmiAdx(bars);
  return bars.map((_, i) => {
    if (plusDi[i] === null || adx[i] === null) return "flat";
    if (adx[i]! < 20) return "flat";
    return plusDi[i]! > minusDi[i]! ? "long" : minusDi[i]! > plusDi[i]! ? "short" : "flat";
  });
}

function runWeinstein(bars: DailyBar[]): Stance[] {
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

function runElder(bars: DailyBar[]): Stance[] {
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

function runRaschke(bars: DailyBar[]): Stance[] {
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

function runMinervini(bars: DailyBar[]): Stance[] {
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

// 니슨 캔들 패턴: 망치형·유성형·상승/하락장악형. 신호 후 3일 보유.
function runNison(bars: DailyBar[]): Stance[] {
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

export const MODELS: { id: string; label: string; run: (bars: DailyBar[]) => Stance[] }[] = [
  { id: "donchian", label: "돈치안·터틀 (20/10 채널)", run: runDonchian },
  { id: "wilder", label: "와일더 (DMI/ADX)", run: runWilder },
  { id: "weinstein", label: "와인스타인 (스테이지)", run: runWeinstein },
  { id: "elder", label: "엘더 (삼중창+임펄스)", run: runElder },
  { id: "raschke", label: "라쉬케 (Holy Grail)", run: runRaschke },
  { id: "minervini", label: "미너비니 (추세 템플릿)", run: runMinervini },
  { id: "nison", label: "니슨 (캔들 패턴)", run: runNison },
];
