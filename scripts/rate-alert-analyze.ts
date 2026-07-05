// 미국 2년물 금리 급등락 임계값 분석 — docs/rate-alert.md 기획의 근거 산출
//
// 목적: 금리 급등으로 주가지수가 급락한 날(2026-06-05, 06-18, 06-30, 07-01)의
//       30분/1시간 단위 금리 변동폭을 실측해, 알람 트리거 임계값을 정한다.
//
// 방법: 야후에 2년물 '금리' 분봉이 없으므로(US2YT=X 없음, 2YY=F는 유동성 제로),
//       CME 2년물 국채선물 ZT=F 30분봉(가격)을 금리로 환산한다.
//       환산계수 k는 네이버 일봉(US2YT=RR, 실시간 금리)과 ZT=F 일봉의
//       일간 변화 회귀(Δyield ≈ k·Δprice)로 실측 보정한다.
//
// 실행: npx tsx scripts/rate-alert-analyze.ts

import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const EVENT_DAYS = ["2026-06-05", "2026-06-18", "2026-06-30", "2026-07-01"];
const PERIOD1 = "2026-05-25";
const PERIOD2 = "2026-07-06";

// ── 네이버 2년물 일봉 (실시간 금리 소스의 일간 이력)
type NaverDaily = { date: string; close: number; open: number; high: number; low: number };

async function fetchNaverDaily(pages = 5): Promise<NaverDaily[]> {
  const out: NaverDaily[] = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://m.stock.naver.com/front-api/marketIndex/prices?category=bond&reutersCode=US2YT=RR&page=${p}&pageSize=20`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) break;
    const j = (await res.json()) as {
      isSuccess: boolean;
      result?: { localTradedAt: string; closePrice: string; openPrice: string; highPrice: string; lowPrice: string }[];
    };
    const rows = j.result ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        date: r.localTradedAt.slice(0, 10), // 미 동부 기준 날짜
        close: parseFloat(r.closePrice),
        open: parseFloat(r.openPrice),
        high: parseFloat(r.highPrice),
        low: parseFloat(r.lowPrice),
      });
    }
  }
  return out.filter((r) => !isNaN(r.close)).reverse(); // 과거→최근
}

// ── ZT=F (2년물 국채선물)
type Candle = { ts: number; date: Date; close: number };

async function fetchZt(interval: "1d" | "30m"): Promise<Candle[]> {
  const c = await yf.chart("ZT=F", {
    period1: new Date(PERIOD1),
    period2: new Date(PERIOD2),
    interval,
  });
  return (c.quotes ?? [])
    .filter((q): q is typeof q & { close: number } => q.close != null)
    .map((q) => ({ ts: q.date.getTime(), date: q.date, close: q.close }));
}

// 미 동부 시간 표기 (여름=EDT, UTC-4 — 분석 구간이 전부 6~7월이라 고정 오프셋 사용)
function toEt(d: Date): { day: string; hhmm: string } {
  const et = new Date(d.getTime() - 4 * 3600 * 1000);
  return {
    day: et.toISOString().slice(0, 10),
    hhmm: et.toISOString().slice(11, 16),
  };
}

// 단순 회귀 (원점 통과): y = k·x
function regressThroughOrigin(xs: number[], ys: number[]): { k: number; r2: number } {
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
  }
  const k = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { k, r2 };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  const [naver, ztDaily, zt30] = await Promise.all([fetchNaverDaily(), fetchZt("1d"), fetchZt("30m")]);
  console.log(`네이버 2Y 일봉 ${naver.length}개, ZT=F 일봉 ${ztDaily.length}개, ZT=F 30분봉 ${zt30.length}개\n`);

  // ── 1) 환산계수 보정: 같은 날짜의 일간 Δyield vs Δprice
  const ztByDay = new Map<string, number>(); // ET 날짜 → 종가
  for (const c of ztDaily) ztByDay.set(toEt(c.date).day, c.close);

  const dxs: number[] = [], dys: number[] = [];
  for (let i = 1; i < naver.length; i++) {
    const d0 = naver[i - 1], d1 = naver[i];
    const p0 = ztByDay.get(d0.date), p1 = ztByDay.get(d1.date);
    if (p0 === undefined || p1 === undefined) continue;
    dxs.push(p1 - p0);
    dys.push(d1.close - d0.close);
  }
  const { k, r2 } = regressThroughOrigin(dxs, dys);
  console.log(`환산계수 k (Δyield ≈ k·Δprice): ${k.toFixed(3)} %p/pt  (표본 ${dxs.length}일, R²=${r2.toFixed(3)})`);
  console.log(`  이론값 비교: 2년물 듀레이션 ~1.9 → 약 -0.53. 실측 k가 크게 다르면 데이터 확인 필요.\n`);

  // ── 2) 30분봉 → 금리 환산 변동 시계열
  // 30분 변동 = 직전 봉 대비, 1시간 변동 = 2개 봉 전 대비 (봉 사이 갭이 40분 초과면 세션 단절로 보고 제외)
  type Move = { day: string; hhmm: string; d30: number | null; d60: number | null };
  const moves: Move[] = [];
  for (let i = 0; i < zt30.length; i++) {
    const cur = zt30[i];
    const prev1 = i >= 1 ? zt30[i - 1] : null;
    const prev2 = i >= 2 ? zt30[i - 2] : null;
    const gap1 = prev1 ? (cur.ts - prev1.ts) / 60000 : Infinity;
    const gap2 = prev2 ? (cur.ts - prev2.ts) / 60000 : Infinity;
    const { day, hhmm } = toEt(cur.date);
    moves.push({
      day,
      hhmm,
      d30: prev1 && gap1 <= 40 ? k * (cur.close - prev1.close) : null,
      d60: prev2 && gap2 <= 70 ? k * (cur.close - prev2.close) : null,
    });
  }

  // ── 3) 이벤트 날짜별 상세 + 그날 최대 변동
  for (const day of EVENT_DAYS) {
    const dayMoves = moves.filter((m) => m.day === day);
    const nv = naver.find((n) => n.date === day);
    console.log(`── ${day} ${nv ? `(일봉: 시 ${nv.open} → 종 ${nv.close}, 고 ${nv.high} / 저 ${nv.low}, 일중폭 ${(nv.high - nv.low).toFixed(3)}%p)` : "(네이버 일봉 없음)"}`);
    if (dayMoves.length === 0) {
      console.log("   ZT=F 30분봉 없음");
      continue;
    }
    const d30s = dayMoves.filter((m) => m.d30 !== null).map((m) => m.d30 as number);
    const d60s = dayMoves.filter((m) => m.d60 !== null).map((m) => m.d60 as number);
    const max30 = Math.max(...d30s.map(Math.abs));
    const max60 = Math.max(...d60s.map(Math.abs));
    console.log(`   |30분 변동| 최대 ${max30.toFixed(3)}%p · |1시간 변동| 최대 ${max60.toFixed(3)}%p`);
    // 상위 변동 구간 나열 (급등 방향 우선 확인용)
    const top = dayMoves
      .filter((m) => m.d30 !== null)
      .sort((a, b) => Math.abs(b.d30 as number) - Math.abs(a.d30 as number))
      .slice(0, 5);
    for (const m of top) {
      console.log(`     ${m.hhmm} ET  30분 ${(m.d30 as number) >= 0 ? "+" : ""}${(m.d30 as number).toFixed(3)}%p${m.d60 !== null ? `  (1시간 ${m.d60 >= 0 ? "+" : ""}${m.d60.toFixed(3)}%p)` : ""}`);
    }
  }

  // ── 4) 평상시(이벤트 제외) 분포 — 임계값이 평시에 얼마나 자주 걸릴지
  const base30 = moves.filter((m) => m.d30 !== null && !EVENT_DAYS.includes(m.day)).map((m) => Math.abs(m.d30 as number)).sort((a, b) => a - b);
  const base60 = moves.filter((m) => m.d60 !== null && !EVENT_DAYS.includes(m.day)).map((m) => Math.abs(m.d60 as number)).sort((a, b) => a - b);
  console.log(`\n── 평상시 분포 (이벤트 4일 제외, |변동| 절대값)`);
  console.log(`   30분: 중앙값 ${pct(base30, 50).toFixed(3)} · 90% ${pct(base30, 90).toFixed(3)} · 95% ${pct(base30, 95).toFixed(3)} · 99% ${pct(base30, 99).toFixed(3)} · 최대 ${base30[base30.length - 1]?.toFixed(3)}%p (표본 ${base30.length})`);
  console.log(`   1시간: 중앙값 ${pct(base60, 50).toFixed(3)} · 90% ${pct(base60, 90).toFixed(3)} · 95% ${pct(base60, 95).toFixed(3)} · 99% ${pct(base60, 99).toFixed(3)} · 최대 ${base60[base60.length - 1]?.toFixed(3)}%p (표본 ${base60.length})`);

  // ── 5) 후보 임계값별 시뮬레이션: 이벤트일 감지 여부 + 평시 오탐 횟수
  console.log(`\n── 임계값 후보 시뮬레이션 (30분 기준)`);
  for (const th of [0.02, 0.025, 0.03, 0.035, 0.04, 0.05]) {
    const hitDays = EVENT_DAYS.filter((d) => moves.some((m) => m.day === d && m.d30 !== null && Math.abs(m.d30) >= th));
    const falseDays = new Set(moves.filter((m) => m.d30 !== null && !EVENT_DAYS.includes(m.day) && Math.abs(m.d30) >= th).map((m) => m.day));
    console.log(`   ±${th.toFixed(3)}%p/30분: 이벤트 감지 ${hitDays.length}/4일 [${hitDays.map((d) => d.slice(5)).join(",")}] · 평시 발동 ${falseDays.size}일 [${[...falseDays].map((d) => d.slice(5)).join(",")}]`);
  }
  console.log(`\n── 임계값 후보 시뮬레이션 (1시간 기준)`);
  for (const th of [0.03, 0.04, 0.05, 0.06, 0.07]) {
    const hitDays = EVENT_DAYS.filter((d) => moves.some((m) => m.day === d && m.d60 !== null && Math.abs(m.d60) >= th));
    const falseDays = new Set(moves.filter((m) => m.d60 !== null && !EVENT_DAYS.includes(m.day) && Math.abs(m.d60) >= th).map((m) => m.day));
    console.log(`   ±${th.toFixed(3)}%p/1시간: 이벤트 감지 ${hitDays.length}/4일 [${hitDays.map((d) => d.slice(5)).join(",")}] · 평시 발동 ${falseDays.size}일 [${[...falseDays].map((d) => d.slice(5)).join(",")}]`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
