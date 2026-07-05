// Stage 1 — 규칙 발견 (마스터 스펙 8.2). "추세일이었던 날의 선행 조건"을 조건부 통계표로 분석한다.
//
// 라벨 소스 2계층:
//  1) 백필(과거 ~3개월): 분봉 데이터가 없으므로(네이버 1분봉은 최근 7일뿐) 일봉 프록시 라벨 사용
//     — 일중 이동(종/시) ±2.5% 이상 AND 효율(|종-시|/(고-저)) ≥ 0.55 AND 종가가 극단 근처.
//     주의: 프록시는 "막판 급락일(6/12형)"을 추세일로 오분류할 수 있음 — 참고용.
//  2) 실측(운영 개시 후): signal_daily_features.day_label (10분봉 DC1 60% — dcLabel 기준).
//     같은 날짜에 둘 다 있으면 실측이 우선.
//
// 피처는 전부 "그날 아침에 알 수 있었던 것"만 사용 (전일까지의 데이터 + 당일 갭).

import YahooFinance from "yahoo-finance2";
import { fetchDailyBars } from "./data";
import { SIGNAL_CONFIG } from "./config";
import type { DailyBar } from "./types";

const yf = new YahooFinance();

export type DayRecord = {
  date: string;
  label: "상방추세일" | "하방추세일" | "비추세일";
  labelSource: "실측" | "프록시";
  intradayPct: number | null; // 종/시 %
  features: Record<string, string>; // 버킷화된 피처
};

export type CrossTabRow = {
  feature: string;   // "전일 등락: ≤-3%"
  n: number;
  pUp: number;       // P(상방추세일)
  pDown: number;
  pRange: number;    // P(비추세일)
  liftTrend: number; // (pUp+pDown) / 기저 추세일 비율
};

export type Stage1Report = {
  totalDays: number;
  measured: number;   // 실측 라벨 일수
  proxied: number;
  baseUp: number;     // 기저율
  baseDown: number;
  baseRange: number;
  rows: CrossTabRow[];       // lift 상위 (표본 n ≥ 5)
  records: DayRecord[];      // 최근 20일 원본 (표시용)
  notes: string[];
};

// ── 일봉 프록시 라벨
// 효율 기준 0.7 (2026-07-05 실측 검증: 분봉이 남은 6일 대조에서 0.55는 7/2(왕복 하락)·7/3(V반전)을
// 추세일로 과대 집계 — 0.7이면 실측 라벨과 6/6 일치. 반전일은 추세일이 아니라는 분류 체계와도 정합)
function proxyLabel(b: DailyBar): { label: DayRecord["label"]; intradayPct: number } {
  const intradayPct = ((b.close - b.open) / b.open) * 100;
  const range = b.high - b.low;
  const eff = range > 0 ? Math.abs(b.close - b.open) / range : 0;
  const closePos = range > 0 ? (b.close - b.low) / range : 0.5;
  if (intradayPct >= 2.5 && eff >= 0.7 && closePos >= 0.75) return { label: "상방추세일", intradayPct };
  if (intradayPct <= -2.5 && eff >= 0.7 && closePos <= 0.25) return { label: "하방추세일", intradayPct };
  return { label: "비추세일", intradayPct };
}

// ── 야후 일간 시계열 → date별 전일比 % 맵
async function fetchDailyChangeMap(symbol: string, fromMs: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const r = await yf.chart(symbol, { period1: new Date(fromMs), interval: "1d" });
    const quotes = (r.quotes ?? []).filter((q) => q.close != null);
    for (let i = 1; i < quotes.length; i++) {
      const prev = quotes[i - 1].close as number;
      const cur = quotes[i].close as number;
      const d = new Date(quotes[i].date).toISOString().slice(0, 10);
      if (prev > 0) map.set(d, ((cur - prev) / prev) * 100);
    }
  } catch {
    // 실패 시 빈 맵 — 해당 피처만 미상 처리
  }
  return map;
}

// date보다 앞선(전일 밤까지의) 가장 최근 값
function latestBefore(map: Map<string, number>, date: string): number | null {
  let best: string | null = null;
  for (const k of map.keys()) {
    if (k < date && (best === null || k > best)) best = k;
  }
  return best !== null ? map.get(best)! : null;
}

// ── 피처 버킷화
function bucket(v: number | null, cuts: number[], labels: string[]): string {
  if (v === null || !isFinite(v)) return "미상";
  for (let i = 0; i < cuts.length; i++) if (v <= cuts[i]) return labels[i];
  return labels[labels.length - 1];
}

export async function runStage1(measuredRows?: { date: string; day_label: string | null }[]): Promise<Stage1Report> {
  const notes: string[] = [];
  const fromMs = Date.now() - 130 * 86400000; // 여유 있게 ~4.3개월 (룩백 소모분 포함)

  const [hynix, macro] = await Promise.all([
    fetchDailyBars(SIGNAL_CONFIG.symbols.hynix, 100),
    Promise.all([
      fetchDailyChangeMap("^NDX", fromMs),   // 나스닥100
      fetchDailyChangeMap("^SOX", fromMs),   // 필라반도체
      fetchDailyChangeMap("^TNX", fromMs),   // 미 10년 금리
      fetchDailyChangeMap("KRW=X", fromMs),  // 환율
    ]),
  ]);
  const [ndx, sox, tnx, krw] = macro;
  if (hynix.length < 30) {
    return { totalDays: 0, measured: 0, proxied: 0, baseUp: 0, baseDown: 0, baseRange: 0, rows: [], records: [], notes: ["일봉 데이터 부족"] };
  }

  const measuredMap = new Map<string, string>();
  for (const r of measuredRows ?? []) {
    if (r.day_label) measuredMap.set(r.date, r.day_label);
  }

  const records: DayRecord[] = [];
  const LOOKBACK = 8; // NR7·누적 계산 여유
  for (let i = LOOKBACK; i < hynix.length; i++) {
    const b = hynix[i];
    const prev = hynix[i - 1];
    const prev3 = hynix[i - 4];

    // 라벨 — 실측 우선, 없으면 프록시
    const measured = measuredMap.get(b.date);
    const proxy = proxyLabel(b);
    const label = (measured as DayRecord["label"]) ?? proxy.label;

    // 피처 (아침에 알 수 있는 것)
    const prevChg = ((prev.close - hynix[i - 2].close) / hynix[i - 2].close) * 100;
    const cum3 = ((prev.close - prev3.close) / prev3.close) * 100;
    const gap = ((b.open - prev.close) / prev.close) * 100;
    // 전일 NR7
    const win7 = hynix.slice(i - 7, i);
    const nr7 = prev.high - prev.low === Math.min(...win7.map((x) => x.high - x.low));
    // 연속 방향 일수
    let streak = 0;
    for (let k = i - 1; k > 0; k--) {
      const up = hynix[k].close > hynix[k - 1].close;
      if (streak === 0) streak = up ? 1 : -1;
      else if ((streak > 0) === up) streak += up ? 1 : -1;
      else break;
    }

    const features: Record<string, string> = {
      "전일 등락": bucket(prevChg, [-3, 0, 3], ["≤-3%", "-3~0%", "0~+3%", "≥+3%"]),
      "직전 3일 누적": bucket(cum3, [-8, 0, 8], ["≤-8%", "-8~0%", "0~+8%", "≥+8%"]),
      "당일 갭": bucket(gap, [-2, -0.5, 0.5, 2], ["≤-2%", "-2~-0.5%", "무갭", "+0.5~2%", "≥+2%"]),
      "전일 NR7 수축": nr7 ? "예" : "아니오",
      "연속 흐름": streak >= 2 ? "2일+ 연속상승" : streak <= -2 ? "2일+ 연속하락" : "혼조",
      "전일 나스닥": bucket(latestBefore(ndx, b.date), [-1, 1], ["≤-1%", "-1~+1%", "≥+1%"]),
      "전일 SOX": bucket(latestBefore(sox, b.date), [-1.5, 1.5], ["≤-1.5%", "-1.5~+1.5%", "≥+1.5%"]),
      "전일 미금리": bucket(latestBefore(tnx, b.date), [0], ["하락", "상승"]),
      "전일 환율": bucket(latestBefore(krw, b.date), [0], ["하락", "상승"]),
    };

    records.push({
      date: b.date,
      label,
      labelSource: measured ? "실측" : "프록시",
      intradayPct: proxy.intradayPct,
      features,
    });
  }

  // ── 기저율
  const total = records.length;
  const nUp = records.filter((r) => r.label === "상방추세일").length;
  const nDown = records.filter((r) => r.label === "하방추세일").length;
  const baseTrend = (nUp + nDown) / total;

  // ── 크로스탭 (피처 버킷별 라벨 분포 + 추세일 리프트)
  const rows: CrossTabRow[] = [];
  const featureNames = Object.keys(records[0].features);
  for (const f of featureNames) {
    const buckets = new Map<string, DayRecord[]>();
    for (const r of records) {
      const key = r.features[f];
      if (key === "미상") continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }
    for (const [key, rs] of buckets) {
      if (rs.length < 5) continue; // 표본 부족 버킷 제외 (스펙 8.4 표본 경계)
      const up = rs.filter((r) => r.label === "상방추세일").length / rs.length;
      const down = rs.filter((r) => r.label === "하방추세일").length / rs.length;
      rows.push({
        feature: `${f}: ${key}`,
        n: rs.length,
        pUp: up,
        pDown: down,
        pRange: 1 - up - down,
        liftTrend: baseTrend > 0 ? (up + down) / baseTrend : 0,
      });
    }
  }
  rows.sort((a, b) => Math.abs(b.liftTrend - 1) - Math.abs(a.liftTrend - 1));

  const measured = records.filter((r) => r.labelSource === "실측").length;
  notes.push(`백필 라벨은 일봉 프록시(일중 ±2.5%·효율 0.7·극단 마감) — 분봉이 남은 6일 실측 대조로 검증(6/6 일치). 단 경로를 못 보므로 막판 급락일(6/12형)은 여전히 오분류 가능. 실측(10분봉 DC1) 라벨이 쌓이면 같은 날짜는 실측이 우선.`);
  notes.push(`표본 ${total}일 중 실측 ${measured}일 — 스펙 8.2 기준 Stage 1 신뢰 구간은 실측 60일부터. 그 전까지는 경향 참고용.`);

  return {
    totalDays: total,
    measured,
    proxied: total - measured,
    baseUp: nUp / total,
    baseDown: nDown / total,
    baseRange: 1 - (nUp + nDown) / total,
    rows: rows.slice(0, 14),
    records: records.slice(-20).reverse(),
    notes,
  };
}
