// PG-1 이익 보호 매도신호 — 판정 엔진 (순수 함수, 리플레이 가능)
// 기획: docs/pg1-profit-guard-spec.md v0.2 (발주자 초안 2026-08-09 + 전제 확인 반영)
// 기준 봉 10분(정규장 1분봉 집계·프리장 제외), MA 일간 연결. 전 함수는 마감 봉만 참조한다 —
// 인덱스 t의 판정은 bars[0..t]만 사용(구조적 lookahead 차단). 미래 봉·당일 고점 참조 금지.
import type { MinuteBar } from "./types";

export type Bar10 = {
  date: string;   // YYYY-MM-DD
  time: string;   // 버킷 시작 HH:MM (마감 = +10분, 15:20 버킷은 15:30 동시호가 프린트 포함)
  open: number; high: number; low: number; close: number; volume: number;
  nMin: number;   // 집계된 1분봉 수 (0 = 결측 버킷 — 판정 보류 사유)
};

// 정규장 10분봉 집계. 버킷 = 시작시각 [09:00,09:10) … [15:10,15:20), 15:30 프린트 → 15:20 버킷.
// 결측 버킷(1분봉 0개)도 자리(nMin=0)를 만들어 반환한다 — §4.2 "결측을 조용히 건너뛰지 않는다".
// 마지막 버킷은 그날 마지막 1분봉이 속한 버킷까지만 생성(장중 리플레이 시 미마감 버킷 미포함은 호출측 책임).
export function agg10m(dayMinutes: MinuteBar[], date: string): Bar10[] {
  const reg = dayMinutes.filter((b) => b.time >= "09:00" && b.time <= "15:30");
  if (!reg.length) return [];
  for (let i = 1; i < reg.length; i++) {
    if (reg[i].time <= reg[i - 1].time) throw new Error(`agg10m: 비단조 시각 ${date} ${reg[i].time}`);
  }
  const bucketOf = (t: string): number => {
    const m = parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
    const b = Math.min(Math.floor((m - 540) / 10), 38); // 15:20~15:30 → 마지막(38) 버킷
    return b;
  };
  const lastB = bucketOf(reg[reg.length - 1].time);
  const out: Bar10[] = [];
  for (let b = 0; b <= lastB; b++) {
    const m0 = 540 + b * 10;
    const time = `${String(Math.floor(m0 / 60)).padStart(2, "0")}:${String(m0 % 60).padStart(2, "0")}`;
    const mins = reg.filter((x) => bucketOf(x.time) === b);
    if (!mins.length) { out.push({ date, time, open: NaN, high: NaN, low: NaN, close: NaN, volume: 0, nMin: 0 }); continue; }
    out.push({
      date, time,
      open: mins[0].open,
      high: Math.max(...mins.map((x) => x.high)),
      low: Math.min(...mins.map((x) => x.low)),
      close: mins[mins.length - 1].close,
      volume: mins.reduce((a, x) => a + x.volume, 0),
      nMin: mins.length,
    });
  }
  return out;
}

// 단순이평 시리즈 (일간 연결된 평탄 배열 위에서). 결측 봉(nMin=0)이 창에 끼면 null — 판정 보류로 전파.
export function smaSeries(bars: Bar10[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let sum = 0, bad = 0;
  for (let i = 0; i < bars.length; i++) {
    const v = bars[i].close;
    if (bars[i].nMin === 0 || !isFinite(v)) bad++; else sum += v;
    if (i >= n) {
      const old = bars[i - n];
      if (old.nMin === 0 || !isFinite(old.close)) bad--; else sum -= old.close;
    }
    if (i >= n - 1) out[i] = bad > 0 ? null : sum / n;
  }
  return out;
}

// exclusion 모드: "sameDir" = 등록판(§3.2 — 직전 W봉 동방향 아니면 전부 제외) /
// "gapConv" = 탐색판(제외를 §3.3의 갭 수렴 패턴 — 가격·MA5는 유리 방향, MA20은 반대 방향 — 으로만 한정.
//   근거: 둥근 천장에서는 MA5가 먼저 꺾여 MA20과 방향이 갈리므로 sameDir이 진짜 반전 크로스까지 제외한다
//   — 1차 ablation 실측에서 제외 크로스 정당성 53%/51%(동전 수준)로 확인. 사전등록 밖 탐색 변형으로 명기)
export type Pg1aOpts = { k: number; w: number; eps: number; exclusion?: "sameDir" | "gapConv" }; // eps: |slope|/가격 최소 비율 (0 = 필터 없음)
export const PG1A_DEFAULT: Pg1aOpts = { k: 3, w: 3, eps: 0, exclusion: "sameDir" };

export type Pg1aEvent = {
  i: number; date: string; time: string; px: number;      // px = 크로스 확정 봉 종가
  kind: "valid" | "excluded" | "no_dir";                   // excluded = 반대 진행 수렴(§3.3), no_dir = ε 미달
  slope5: number; slope20: number;                          // 크로스 봉 기준 (진단용)
};

// PG-1A 데드크로스 스트림. dir=1(레버 보유): MA5가 MA20 하향 크로스 / dir=-1(인버): 상향 크로스(거울상).
// 유효성: 크로스 직전 W봉(t-1..t-W) 동안 sign(slope(MA5)) == sign(slope(MA20)) 유지, slope = MA(τ)-MA(τ-k).
// 무효 크로스도 kind를 달아 전부 반환한다 — 제외 정당성 사후 검증용(§3.3).
export function pg1aStream(bars: Bar10[], ma5: (number | null)[], ma20: (number | null)[], dir: 1 | -1, opts: Pg1aOpts = PG1A_DEFAULT): Pg1aEvent[] {
  const { k, w, eps, exclusion = "sameDir" } = opts;
  const out: Pg1aEvent[] = [];
  const slope = (ma: (number | null)[], t: number): number | null => {
    const a = ma[t], b = t - k >= 0 ? ma[t - k] : null;
    return a !== null && b !== null ? a - b : null;
  };
  for (let t = 1; t < bars.length; t++) {
    const p5 = ma5[t - 1], p20 = ma20[t - 1], c5 = ma5[t], c20 = ma20[t];
    if (p5 === null || p20 === null || c5 === null || c20 === null) continue;
    const crossed = dir === 1 ? p5 >= p20 && c5 < c20 : p5 <= p20 && c5 > c20;
    if (!crossed) continue;
    const s5 = slope(ma5, t) ?? 0, s20 = slope(ma20, t) ?? 0;
    // 직전 W봉 검사 — sameDir: 동방향 아니면 제외 / gapConv: 갭 수렴 패턴(W봉 전부)일 때만 제외
    let kind: Pg1aEvent["kind"] = "valid";
    let gapConvAll = true;
    for (let j = 1; j <= w; j++) {
      const a = slope(ma5, t - j), b = slope(ma20, t - j);
      if (a === null || b === null) { kind = "no_dir"; break; }
      const px = bars[t - j].close;
      if (eps > 0 && (Math.abs(a) / px < eps || Math.abs(b) / px < eps)) { kind = "no_dir"; break; }
      if (exclusion === "sameDir") {
        if (Math.sign(a) !== Math.sign(b) || a === 0 || b === 0) { kind = "excluded"; break; }
      } else {
        // 갭 수렴: MA5는 보유에 유리한 방향(+dir), MA20은 반대 방향 — 가격이 회복 중인데 이평이 갭을 따라오는 형국
        if (!(Math.sign(a) === dir && Math.sign(b) === -dir)) gapConvAll = false;
      }
    }
    if (exclusion === "gapConv" && kind === "valid" && gapConvAll) kind = "excluded";
    out.push({ i: t, date: bars[t].date, time: bars[t].time, px: bars[t].close, kind, slope5: s5, slope20: s20 });
  }
  return out;
}

export type Pg1bOpts = { win: number; need: number; mult: number; cooldown: number };
export const PG1B_DEFAULT: Pg1bOpts = { win: 7, need: 4, mult: 1.5, cooldown: 6 };

export type Pg1bEvent = {
  i: number; date: string; time: string; px: number;
  kind: "warn" | "hold" | "cooldown";                       // hold = 창 내 결측으로 판정 보류(§4.2)
  c1: number; c2: number; c3: number;                        // 조건별 충족 봉 수 (진단용)
};

// PG-1B 꼬리 클러스터 스트림. dir=1: 윗꼬리(고점 전환 경고) / dir=-1: 아랫꼬리 거울상.
// 매 봉 최근 win개 마감 봉을 검사, 3조건 전부 need개 이상이면 경고. 쿨다운 내 재충족은 kind=cooldown으로 기록만.
export function pg1bStream(bars: Bar10[], dir: 1 | -1, opts: Pg1bOpts = PG1B_DEFAULT): Pg1bEvent[] {
  const { win, need, mult, cooldown } = opts;
  const out: Pg1bEvent[] = [];
  let lastWarn = -Infinity;
  for (let t = win - 1; t < bars.length; t++) {
    const w = bars.slice(t - win + 1, t + 1);
    if (w.some((b) => b.nMin === 0)) {
      // 결측 포함 창 — 판정 보류 (해당 창에서 조건 계산 자체를 하지 않는다)
      out.push({ i: t, date: bars[t].date, time: bars[t].time, px: bars[t].close, kind: "hold", c1: -1, c2: -1, c3: -1 });
      continue;
    }
    let c1 = 0, c2 = 0, c3 = 0;
    for (const b of w) {
      const body = Math.abs(b.close - b.open);
      const upRaw = b.high - Math.max(b.open, b.close);
      const dnRaw = Math.min(b.open, b.close) - b.low;
      const adverse = dir === 1 ? upRaw : dnRaw;   // 보유 방향에 불리한 쪽 꼬리
      const favor = dir === 1 ? dnRaw : upRaw;
      if (adverse > favor) c1++;
      if (adverse > body) c2++;                     // body=0 도지: adverse>0이면 자동 충족
      if (adverse > 0 && adverse >= mult * favor) c3++; // favor=0: adverse>0이면 충족 (부등식 직접 비교)
    }
    if (c1 >= need && c2 >= need && c3 >= need) {
      const kind = t - lastWarn <= cooldown ? "cooldown" : "warn";
      if (kind === "warn") lastWarn = t;
      out.push({ i: t, date: bars[t].date, time: bars[t].time, px: bars[t].close, kind, c1, c2, c3 });
    }
  }
  return out;
}
