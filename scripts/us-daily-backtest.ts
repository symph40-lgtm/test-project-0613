// 미장 일봉 스윙 백테스트 — SOXX 10.5년 절제(ablation) 검증. `npx tsx scripts/us-daily-backtest.ts`
// (사용자 지시 2026-07-23: "국장 일봉 규칙(삼전 기준)을 미장 SOXX 기준으로 — 상수 변경 필요하면
//  SOXX에 맞게 적용"). 한국 채택 구성요소(미너비니 판정자·사다리 v4·수퍼트렌드 브레이크·
// 10Y/DXY 급등 게이트·NFP 이벤트 감산)를 SOXX에서 하나씩 켜며 개선 여부를 실측한다.
// 채택 기준은 한국과 동일 원칙: 전체(10.5y)·최근(2y) 두 구간 모두 악화 없는 것만.
// 시뮬: D일 종가 판정 비중 → D→D+1 종가 수익률에 적용 (종가-종가, 스탑 경로는 지침 표시 전용).

import YahooFinance from "yahoo-finance2";
import { judgeAt } from "../lib/predict-daily/judge";
import type { DailyBar } from "../lib/predict-daily/types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const YEARS = 10.5;

async function daily(symbol: string): Promise<DailyBar[]> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - YEARS * 365.25 * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((x): x is typeof x & { open: number; high: number; low: number; close: number } =>
      x.open != null && x.high != null && x.low != null && x.close != null)
    .map((x) => {
      const d = x.date instanceof Date ? x.date : new Date(x.date);
      return { date: d.toISOString().slice(0, 10), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0 };
    });
}

function isFirstFriday(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.getUTCDay() === 5 && d.getUTCDate() <= 7;
}

type Cfg = { ladder: boolean; brake: boolean; y10: boolean; dxy: boolean; nfp: boolean };

function simulate(
  bars: DailyBar[], warmup: number,
  y10Chg: Map<string, number>, dxyChg: Map<string, number>,
  cfg: Cfg, fromIdx: number,
): { mult: number; mdd: number; exposedDays: number; judgments: Map<string, { stance: string; exposure: number }> } {
  let equity = 1, peak = 1, mdd = 0, exposedDays = 0;
  const judgments = new Map<string, { stance: string; exposure: number }>();
  for (let i = Math.max(warmup, fromIdx); i < bars.length - 1; i++) {
    const j = judgeAt(bars, i);
    // 사다리: ON이면 v4(미너비니 1.0 / 와인스타인 생존 0.5 / 붕괴 0) — OFF면 미너비니 단독 1/0
    let exp = 0;
    if (j.stance === "long") exp = 1;
    else if (cfg.ladder && j.stance === "flat" && j.modelStances["weinstein"] === "long") exp = 0.5;
    if (cfg.brake && !j.stUp && exp > 0.5) exp = 0.5;
    const d = bars[i].date;
    if (cfg.y10 && exp > 0 && (y10Chg.get(d) ?? 0) >= 0.08) exp *= 0.5;
    if (cfg.dxy && exp > 0 && (dxyChg.get(d) ?? 0) >= 0.8) exp *= 0.5;
    // NFP: 다음 세션(D+1)이 첫 금요일이면 그 세션 감산 (지침이 커버하는 날 기준)
    if (cfg.nfp && exp > 0 && isFirstFriday(bars[i + 1].date)) exp *= 0.5;
    judgments.set(d, { stance: j.stance, exposure: exp });
    const r = bars[i + 1].close / bars[i].close - 1;
    equity *= 1 + exp * r;
    if (exp > 0) exposedDays++;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity / peak - 1);
  }
  return { mult: equity, mdd, exposedDays, judgments };
}

function bhStats(bars: DailyBar[], fromIdx: number): { mult: number; mdd: number } {
  let peak = -Infinity, mdd = 0;
  for (let i = fromIdx; i < bars.length; i++) {
    peak = Math.max(peak, bars[i].close);
    mdd = Math.min(mdd, bars[i].close / peak - 1);
  }
  return { mult: bars[bars.length - 1].close / bars[fromIdx].close, mdd };
}

async function main() {
  console.log("═══ 미장 일봉 스윙 — SOXX 10.5년 절제 검증 ═══\n");
  const [soxx, tnx, dxy] = await Promise.all([daily("SOXX"), daily("^TNX"), daily("DX-Y.NYB")]);
  console.log(`SOXX ${soxx.length}봉 (${soxx[0]?.date} ~ ${soxx[soxx.length - 1]?.date}) · ^TNX ${tnx.length} · DXY ${dxy.length}`);
  const warmup = 272;

  // 게이트 시계열: 그날(D)의 전일 대비 변화 — D 종가 판정에 사용 (D+1 세션 감산)
  const chgMap = (bars: DailyBar[], pp: boolean): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 1; i < bars.length; i++) {
      m.set(bars[i].date, pp ? bars[i].close - bars[i - 1].close : (bars[i].close / bars[i - 1].close - 1) * 100);
    }
    return m;
  };
  const y10 = chgMap(tnx, true), dx = chgMap(dxy, false);

  const recentFrom = soxx.findIndex((b) => b.date >= soxx[soxx.length - 1].date.slice(0, 4).replace(/\d{4}/, (y) => String(+y - 2)) + soxx[soxx.length - 1].date.slice(4));
  const segs: [string, number][] = [["전체", warmup], ["최근2년", Math.max(warmup, recentFrom)]];

  for (const [segName, fromIdx] of segs) {
    const bh = bhStats(soxx, fromIdx);
    console.log(`\n── [${segName}] (${soxx[fromIdx].date}~) 바이앤홀드 ×${bh.mult.toFixed(2)} · MDD ${(bh.mdd * 100).toFixed(0)}% ──`);
    const steps: [string, Cfg][] = [
      ["미너비니 단독",            { ladder: false, brake: false, y10: false, dxy: false, nfp: false }],
      ["사다리(와인 50%)",         { ladder: true, brake: false, y10: false, dxy: false, nfp: false }],
      ["사다리+브레이크",          { ladder: true, brake: true, y10: false, dxy: false, nfp: false }],
      ["사다리+10Y게이트",         { ladder: true, brake: false, y10: true, dxy: false, nfp: false }],
      ["사다리+DXY게이트",         { ladder: true, brake: false, y10: false, dxy: true, nfp: false }],
      ["사다리+NFP감산",           { ladder: true, brake: false, y10: false, dxy: false, nfp: true }],
      ["사다리+10Y+DXY+NFP",       { ladder: true, brake: false, y10: true, dxy: true, nfp: true }],
    ];
    for (const [name, cfg] of steps) {
      const s = simulate(soxx, warmup, y10, dx, cfg, fromIdx);
      console.log(`  ${name.padEnd(24)} ×${s.mult.toFixed(2)} · MDD ${(s.mdd * 100).toFixed(0)}% · 노출 ${s.exposedDays}일`);
    }
  }

  // 손절폭 참고 — SOXX ATR14% 분포 (지침 표시용 2.5×ATR 클램프 확인)
  const atrPcts: number[] = [];
  for (let i = 15; i < soxx.length; i++) {
    let s = 0;
    for (let k = i - 13; k <= i; k++) {
      const tr = Math.max(soxx[k].high - soxx[k].low, Math.abs(soxx[k].high - soxx[k - 1].close), Math.abs(soxx[k].low - soxx[k - 1].close));
      s += tr;
    }
    atrPcts.push(((s / 14) / soxx[i].close) * 100);
  }
  const q = (p: number) => [...atrPcts].sort((a, b) => a - b)[Math.floor(p * atrPcts.length)];
  console.log(`\nSOXX ATR14%: 중앙 ${q(0.5).toFixed(2)}% · 90% ${q(0.9).toFixed(2)}% → 2.5×ATR = 중앙 ${(2.5 * q(0.5)).toFixed(1)}%·90% ${(2.5 * q(0.9)).toFixed(1)}% (클램프 6~12% 검토)`);

  // 최근 판정 스냅샷 (오늘 기준 — 라이브 정합 확인용)
  const jNow = judgeAt(soxx, soxx.length - 1);
  console.log(`\n오늘 판정: ${jNow.stance} · 기본노출 ${jNow.baseExposure} · 미너비니 ${jNow.modelStances["minervini"]} · 와인 ${jNow.modelStances["weinstein"]} · 수퍼${jNow.stUp ? "↑" : "↓"} · 52주比 ${(jNow.dd * 100).toFixed(0)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
