// 미국 2년물 금리 30분 시계열 — 장중 시황(매크로>금리) 그래프·표 표시용 (기획: docs/rate-alert.md)
//
// 소스 2단 구성:
//  1순위 '실측': rate_samples(크론이 10분 간격으로 저장하는 네이버 실시간 금리)의 30분 버킷 마지막 값.
//  보강 '환산': CME 2년물 국채선물 ZT=F 30분봉을 금리로 환산해 실측이 없는 버킷을 채움.
//    환산계수 -0.475 %p/pt는 scripts/rate-alert-analyze.ts의 실측 회귀(R²=0.875) 값이며,
//    시계열 전체를 현재 실측 금리에 앵커링하므로 절대 레벨 오차는 최근일수록 작다.
//    (야후에 2년물 '금리' 분봉이 없어 불가피 — US2YT=X 미존재, 2YY=F 유동성 제로)

import YahooFinance from "yahoo-finance2";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateAlertConfig, fetchUs2yYield, type RateAlertConfig } from "./rateAlert";

export type Us2yPoint = {
  ts: string;          // ISO (버킷 종료 시각 근사 — 버킷 내 마지막 데이터 시각)
  value: number;       // 금리 %
  d30: number | null;  // 30분 전 대비 (%p) — 직전 버킷이 있을 때만
  d60: number | null;  // 1시간 전 대비 (%p)
  source: "실측" | "환산";
};

export type Us2yIntraday = {
  current: number | null;   // 현재 금리 (네이버 실시간)
  change: number | null;    // 전일 대비 (%p)
  tradedAt: string | null;  // 소스의 마지막 체결 시각
  points: Us2yPoint[];      // 30분 단위, 과거→최근
  cfg: RateAlertConfig;     // 알람 임계값 (그래프 기준선·표 강조에 사용)
  sampleCount: number;      // 실측 버킷 수 (0이면 크론 미가동 — 전부 환산)
};

const ZT_TO_YIELD = -0.475;      // %p per point (분석 스크립트 실측)
const BUCKET_MS = 30 * 60000;
// 벽시계 창이 아니라 '최근 60개 봉(거래시간 기준)'을 보여준다 — 주말·휴장 직후에도
// 직전 거래일 흐름이 그대로 보이도록 (조회 창은 최근 5일).
const LOOKBACK_MS = 5 * 24 * 3600e3;
const MAX_POINTS = 60;

type RawSample = { ts: number; y2: number | null };

async function loadSamples(sinceIso: string): Promise<RawSample[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("rate_samples")
      .select("ts, y2")
      .gte("ts", sinceIso)
      .order("ts", { ascending: true });
    return (data ?? []).map((r) => ({ ts: Date.parse(r.ts as string), y2: r.y2 as number | null }));
  } catch {
    return []; // 마이그레이션 미적용 등 — 환산 시계열만으로 표시
  }
}

async function loadZt30m(nowMs: number): Promise<{ ts: number; close: number }[]> {
  try {
    const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
    const c = await yf.chart("ZT=F", {
      period1: new Date(nowMs - LOOKBACK_MS),
      interval: "30m",
    });
    return (c.quotes ?? [])
      .filter((q): q is typeof q & { close: number } => q.close != null)
      .map((q) => ({ ts: q.date.getTime(), close: q.close }));
  } catch {
    return [];
  }
}

export async function fetchUs2yIntraday(): Promise<Us2yIntraday> {
  const cfg = rateAlertConfig();
  const nowMs = Date.now();
  const sinceIso = new Date(nowMs - LOOKBACK_MS).toISOString();

  const [quote, samples, zt] = await Promise.all([
    fetchUs2yYield(),
    loadSamples(sinceIso),
    loadZt30m(nowMs),
  ]);

  // 30분 버킷 병합 — 환산을 먼저 깔고 실측으로 덮는다 (같은 버킷은 실측 우선)
  const buckets = new Map<number, { ts: number; value: number; source: "실측" | "환산" }>();

  const lastSample = [...samples].reverse().find((s) => s.y2 !== null) ?? null;
  const anchor = quote.value ?? lastSample?.y2 ?? null;
  if (anchor !== null && zt.length > 0) {
    const lastPx = zt[zt.length - 1].close;
    for (const c of zt) {
      const b = Math.floor(c.ts / BUCKET_MS);
      buckets.set(b, { ts: c.ts, value: anchor + ZT_TO_YIELD * (c.close - lastPx), source: "환산" });
    }
  }
  for (const s of samples) {
    if (s.y2 === null) continue;
    const b = Math.floor(s.ts / BUCKET_MS);
    buckets.set(b, { ts: s.ts, value: s.y2, source: "실측" }); // 오름차순이라 버킷 내 마지막 샘플이 남음
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b).slice(-MAX_POINTS);
  const points: Us2yPoint[] = keys.map((k) => {
    const cur = buckets.get(k)!;
    // 30분/1시간 변동 — 정확히 1·2버킷 전 값이 있을 때만 (거래 공백이면 null)
    const p1 = buckets.get(k - 1);
    const p2 = buckets.get(k - 2);
    return {
      ts: new Date(cur.ts).toISOString(),
      value: Number(cur.value.toFixed(4)),
      d30: p1 ? Number((cur.value - p1.value).toFixed(4)) : null,
      d60: p2 ? Number((cur.value - p2.value).toFixed(4)) : null,
      source: cur.source,
    };
  });

  return {
    current: quote.value,
    change: quote.change,
    tradedAt: quote.tradedAt,
    points,
    cfg,
    sampleCount: points.filter((p) => p.source === "실측").length,
  };
}
