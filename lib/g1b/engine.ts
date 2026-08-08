// G1B T2 — FairGap 라이브 엔진 + 일간 학습 상태 계층 (G1-OPT §4, A1-3~A1-5)
// 절단 강제: late_arrival=true 관측은 당일 사용 금지 (값을 null 취급) — 라이브판 룩어헤드 방지.

import type { G1BSymbol } from "./config";
import { G1B_CONFIG as C } from "./config";
import type { Obs } from "./data";

export type LearnState = {
  kalman: { b1: number; p1: number; c_soxx: number; pc1: number; c_peer: number; pc2: number; beta_mkt: number; pb: number; clamp_hits: number };
  sigma_ewma: Record<string, number>;   // 레짐별 σ² (% 단위 제곱)
  bias: number;                          // % 단위
  hedge_w: Record<string, number>;
  resid_hist: number[];                  // 최근 잔차 (경험 분위수·PIT용, 최대 120)
  pit_hist: number[];
  cusum: number;
  nights: number;
};

export function initState(symbol: G1BSymbol): LearnState {
  return {
    kalman: {
      b1: C.init.idx.b1_spx, p1: 0.01,
      c_soxx: C.init.idio[symbol].c_soxx, pc1: 0.01,
      c_peer: C.init.idio[symbol].c_peer, pc2: 0.01,
      beta_mkt: C.init.betaMkt[symbol], pb: 0.02, clamp_hits: 0,
    },
    sigma_ewma: { normal: C.sigmaBase[symbol].normal ** 2, event: C.sigmaBase[symbol].event ** 2 },
    bias: 0,
    hedge_w: { ...C.hedgeInit[symbol] },
    resid_hist: [], pit_hist: [], cusum: 0, nights: 0,
  };
}

const use = (o: Obs | undefined): number | null => (o && !o.late_arrival ? o.v : null);

export type Experts = Record<string, number | null>; // 전문가별 갭 예측 (%)

// ── FairGap_R1: 전문가 예측 생성 → Hedge 결합 (+bias 보정) ──
export function expertsR1(symbol: G1BSymbol, night: Record<string, Obs>, st: LearnState): Experts {
  const k = st.kalman;
  const spx = use(night.r_spx), soxx = use(night.r_soxx), mu = use(night.r_mu), nvda = use(night.r_nvda);
  // 회귀부: β_mkt·(b1·r_SPX) + c_soxx·soxx_ex + c_peer·peer  (직교화 근사: soxx_ex = soxx − 1.35·spx)
  let reg: number | null = null;
  if (spx != null && soxx != null) {
    const soxxEx = soxx - 1.35 * spx;
    const peer = symbol === "000660" ? (mu != null ? mu - soxx : null) : (mu != null && nvda != null ? (mu + nvda) / 2 - soxx : null);
    reg = (k.beta_mkt * k.b1 * spx + k.c_soxx * soxxEx + k.c_peer * (peer ?? 0)) * 100;
  }
  const gdr = use(night.r_gdr);
  const gx = use(night.gx);
  const nf = use(night.night_fut);
  const out: Experts = {
    reg,
    gx: gx != null ? k.beta_mkt * gx * 100 : null,
    ...(symbol === "005930" ? { gdr: gdr != null ? gdr * 100 : null, b1: soxx != null ? soxx * 0.49 * 100 : null } : {}),
    // 야간선물: 미검증(unverified) — 확보 시 관측 항으로 기록만, Hedge 편입은 실적 축적 후 (A1-1)
    night_fut_ref: nf != null ? k.beta_mkt * nf * 100 : null,
  };
  return out;
}

export function combine(st: LearnState, ex: Experts): { fair: number | null; wUsed: Record<string, number> } {
  const usable = Object.entries(st.hedge_w).filter(([n]) => ex[n] != null && st.hedge_w[n] > 0);
  const wsum = usable.reduce((a, [, w]) => a + w, 0);
  if (!wsum) return { fair: null, wUsed: {} };
  let fair = 0;
  const wUsed: Record<string, number> = {};
  for (const [n, w] of usable) {
    const wn = w / wsum;                       // 결측 재정규화 (§1)
    wUsed[n] = Math.round(wn * 100) / 100;
    fair += wn * (ex[n] as number);
  }
  return { fair: fair - st.bias, wUsed };
}

export function sigmaNight(symbol: G1BSymbol, st: LearnState, regime: string): { sigma: number; q80: number | null } {
  const varr = st.sigma_ewma[regime === "bigmove" ? "event" : regime] ?? st.sigma_ewma.normal;
  let s = Math.sqrt(varr);
  if (regime === "bigmove") s *= 1.5;          // J3 provisional
  // 꼬리 이중 체계 (A1-4): 경험 80분위 |잔차|
  const h = st.resid_hist.slice(-C.learn.quantileWindow).map(Math.abs).sort((a, b) => a - b);
  const q80 = h.length >= 20 ? h[Math.floor(h.length * 0.8)] : null;
  return { sigma: Math.round(s * 1000) / 1000, q80: q80 != null ? Math.round(q80 * 1000) / 1000 : null };
}

// ── 라벨 확정 후 일간 학습 (G1-OPT §4.7) ──
export function dailyUpdate(symbol: G1BSymbol, st: LearnState, ex: Experts, fair: number | null,
                            actualGapPct: number, regime: string,
                            night: Record<string, Obs>): LearnState {
  const s = structuredClone(st);
  const L = C.learn;
  const regKey = regime === "bigmove" ? "event" : regime;
  const sig = Math.sqrt(s.sigma_ewma[regKey] ?? s.sigma_ewma.normal);
  if (fair != null) {
    const resid = actualGapPct - fair;
    // EWMA σ (λ 하한 0.90 헌법)
    s.sigma_ewma[regKey] = L.ewmaLambda * (s.sigma_ewma[regKey] ?? sig ** 2) + (1 - L.ewmaLambda) * resid ** 2;
    // bias (클램프 0.3σ — 도달 시 경보 소관)
    const nb = L.biasLambda * s.bias + (1 - L.biasLambda) * resid;
    s.bias = Math.max(-L.biasClampSigma * sig, Math.min(L.biasClampSigma * sig, nb));
    // Hedge 지수가중 (loss = |예측−실측|/σ, 단일 상한 0.7 헌법)
    for (const n of Object.keys(s.hedge_w)) {
      const p = ex[n];
      if (p == null) continue;
      const loss = Math.abs(actualGapPct - p) / Math.max(sig, 0.3);
      s.hedge_w[n] *= Math.exp(-L.hedgeEta * loss);
    }
    const tot = Object.values(s.hedge_w).reduce((a, b) => a + b, 0);
    for (const n of Object.keys(s.hedge_w)) {
      s.hedge_w[n] = Math.min(L.hedgeMaxW, s.hedge_w[n] / tot);
      s.hedge_w[n] = Math.round(s.hedge_w[n] * 1000) / 1000;
    }
    // 칼만 β 갱신 (관측: 종목갭 ~ b1·spx 사슬 — 간이 1차원씩, 클램프 0.5×se 헌법)
    const spx = use(night.r_spx);
    if (spx != null && Math.abs(spx) > 1e-6) {
      const x = s.kalman.beta_mkt * spx * 100;
      const p = s.kalman.p1 + L.kalmanQ;
      const kGain = (p * x) / (p * x * x + sig ** 2);
      let delta = kGain * (actualGapPct - s.kalman.b1 * x);
      const clamp = L.kalmanClampSe * Math.sqrt(p);
      if (Math.abs(delta) > clamp) { delta = Math.sign(delta) * clamp; s.kalman.clamp_hits++; }
      s.kalman.b1 = Math.round((s.kalman.b1 + delta) * 10000) / 10000;
      s.kalman.p1 = (1 - kGain * x) * p;
    }
    // PIT·CUSUM (§4.6)
    const z = resid / Math.max(sig, 1e-6);
    const pit = 0.5 * (1 + erf(z / Math.SQRT2));
    s.pit_hist = [...s.pit_hist.slice(-119), Math.round(pit * 1000) / 1000];
    s.cusum = Math.max(-8, Math.min(8, s.cusum + z));
    s.resid_hist = [...s.resid_hist.slice(-119), Math.round(resid * 1000) / 1000];
  }
  s.nights += 1;
  return s;
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
