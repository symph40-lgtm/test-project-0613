// 미국 2년물 금리 급등락 알람 — 판정 로직 (기획: docs/rate-alert.md)
//
// 조건 (모두 OR, 알림 키별 1일 1회):
//  - 급변: 30분 변동 ≥ ±Δ30 또는 1시간 변동 ≥ ±Δ1h → 급등=매도 검토 / 급락=매수 검토
//  - 레벨: 2년물이 기준(기본 4.125%)을 상향 돌파=매도 검토 / 하향 이탈=매수 검토
//  - 10년물: 기준(기본 4.45%) 상향 돌파 → 고PER 압박 경고
// 임계값 근거: scripts/rate-alert-analyze.ts 실측 (6/5·6/18·6/30·7/1 이벤트 4일 전부 감지).
//
// 변동값은 분봉 API가 아니라 rate_samples에 축적된 샘플 간 차이로 계산 —
// 크론이 10분 간격으로 돌아야 30분 변동을 ±10분 정확도로 잡는다.

export type RateAlertConfig = {
  delta30m: number; // 2년물 30분 변동 임계값 (%p)
  delta1h: number;  // 2년물 1시간 변동 임계값 (%p)
  level2y: number;  // 2년물 절대 레벨 (%)
  level10y: number; // 10년물 절대 레벨 (%)
};

function envNum(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return isNaN(v) ? fallback : v;
}

// 환경변수로 조정 가능 (기본값은 2026-06~07 실측 분석 기준 — docs/rate-alert.md 2장)
export function rateAlertConfig(): RateAlertConfig {
  return {
    delta30m: envNum("RATE_ALERT_2Y_DELTA_30M", 0.03),
    delta1h: envNum("RATE_ALERT_2Y_DELTA_1H", 0.03),
    level2y: envNum("RATE_ALERT_2Y_LEVEL", 4.125),
    level10y: envNum("RATE_ALERT_10Y_LEVEL", 4.45),
  };
}

export type RateSample = {
  ts: number; // epoch ms
  y2: number | null;
  y10: number | null;
};

export type RateAlertHit = {
  key: string;
  severity: "high" | "medium";
  text: string;       // 문자 본문 (90바이트 이내 단문 지향)
  smsSubject?: string;
  emailSubject: string;
  snapshot: Record<string, unknown>;
};

// ts 기준으로 targetMs 이전 [minAgo, maxAgo] 창에서 가장 가까운 샘플
function sampleAgo(samples: RateSample[], nowMs: number, minAgoMin: number, maxAgoMin: number): RateSample | null {
  let best: RateSample | null = null;
  for (const s of samples) {
    const ageMin = (nowMs - s.ts) / 60000;
    if (ageMin < minAgoMin || ageMin > maxAgoMin) continue;
    if (!best || s.ts > best.ts) best = s; // 창 안에서 가장 최근(=30분에 가장 가까움)
  }
  return best;
}

const fmt = (n: number, d = 2) => n.toFixed(d);

// 판정 (순수 함수) — samples는 ts 오름차순, 마지막이 현재 샘플.
// 현재 샘플은 이미 저장된 상태로 넘어와도 되고(마지막 원소), 판정은 값만 본다.
export function evaluateRateAlerts(samples: RateSample[], cfg: RateAlertConfig): RateAlertHit[] {
  if (samples.length === 0) return [];
  const cur = samples[samples.length - 1];
  const prevAll = samples.slice(0, -1);
  const hits: RateAlertHit[] = [];

  // 직전 샘플 (레벨 돌파 판정용) — 24시간 이내 것만 인정, 없으면 첫 가동으로 본다
  const prev = prevAll.length > 0 ? prevAll[prevAll.length - 1] : null;
  const prevFresh = prev && cur.ts - prev.ts <= 24 * 3600 * 1000 ? prev : null;

  // ── 2년물 급변 (30분 / 1시간)
  if (cur.y2 !== null) {
    const s30 = sampleAgo(prevAll, cur.ts, 20, 40);
    const s60 = sampleAgo(prevAll, cur.ts, 45, 75);
    const d30 = s30?.y2 != null ? cur.y2 - s30.y2 : null;
    const d60 = s60?.y2 != null ? cur.y2 - s60.y2 : null;

    // 방향별로 '임계값을 넘긴 창' 중 더 크게 움직인 쪽을 문구에 표기
    const upCands = [
      ...(d30 !== null && d30 >= cfg.delta30m ? [{ v: d30, win: "30분" }] : []),
      ...(d60 !== null && d60 >= cfg.delta1h ? [{ v: d60, win: "1시간" }] : []),
    ].sort((a, b) => b.v - a.v);
    const downCands = [
      ...(d30 !== null && d30 <= -cfg.delta30m ? [{ v: d30, win: "30분" }] : []),
      ...(d60 !== null && d60 <= -cfg.delta1h ? [{ v: d60, win: "1시간" }] : []),
    ].sort((a, b) => a.v - b.v);

    if (upCands.length > 0) {
      const { v, win } = upCands[0];
      hits.push({
        key: "rate2y_spike_up",
        severity: "high",
        smsSubject: "금리급등 매도검토",
        text: `[스탁가드] 미2년 금리급등 +${fmt(v, 3)}%p/${win} 현재 ${fmt(cur.y2)}% 매도 검토`,
        emailSubject: `미국 2년물 금리 급등 — ${win} +${fmt(v, 3)}%p (매도 검토)`,
        snapshot: { y2: cur.y2, d30, d60, cfg },
      });
    }
    if (downCands.length > 0) {
      const { v, win } = downCands[0];
      hits.push({
        key: "rate2y_spike_down",
        severity: "high",
        smsSubject: "금리급락 매수검토",
        text: `[스탁가드] 미2년 금리급락 ${fmt(v, 3)}%p/${win} 현재 ${fmt(cur.y2)}% 매수 검토`,
        emailSubject: `미국 2년물 금리 급락 — ${win} ${fmt(v, 3)}%p (매수 검토)`,
        snapshot: { y2: cur.y2, d30, d60, cfg },
      });
    }

    // ── 2년물 레벨 돌파 (완만하지만 지속적인 상승/하락 커버)
    // 돌파 '순간'만 발동. 직전 샘플이 없으면(첫 가동·24h+ 공백) 현재 상태를 1회 알림.
    const prevY2 = prevFresh?.y2 ?? null;
    const crossedUp = cur.y2 >= cfg.level2y && (prevY2 === null || prevY2 < cfg.level2y);
    const crossedDown = cur.y2 < cfg.level2y && (prevY2 === null ? false : prevY2 >= cfg.level2y);
    if (crossedUp) {
      hits.push({
        key: "rate2y_level_up",
        severity: "medium",
        smsSubject: "금리 기준선 돌파",
        text: `[스탁가드] 미2년 ${fmt(cur.y2, 3)}% 기준 ${cfg.level2y} 상향돌파 매도 검토`,
        emailSubject: `미국 2년물 ${fmt(cur.y2, 3)}% — 기준선 ${cfg.level2y}% 상향 돌파 (매도 검토)`,
        snapshot: { y2: cur.y2, prevY2, level: cfg.level2y },
      });
    }
    if (crossedDown) {
      hits.push({
        key: "rate2y_level_down",
        severity: "medium",
        smsSubject: "금리 기준선 이탈",
        text: `[스탁가드] 미2년 ${fmt(cur.y2, 3)}% 기준 ${cfg.level2y} 하향이탈 매수 검토`,
        emailSubject: `미국 2년물 ${fmt(cur.y2, 3)}% — 기준선 ${cfg.level2y}% 하향 이탈 (매수 검토)`,
        snapshot: { y2: cur.y2, prevY2, level: cfg.level2y },
      });
    }
  }

  // ── 10년물 레벨 돌파 (고PER 압박 경고)
  if (cur.y10 !== null) {
    const prevY10 = prevFresh?.y10 ?? null;
    const crossedUp = cur.y10 >= cfg.level10y && (prevY10 === null || prevY10 < cfg.level10y);
    if (crossedUp) {
      hits.push({
        key: "rate10y_level_up",
        severity: "medium",
        smsSubject: "미10년 기준선 돌파",
        text: `[스탁가드] 미10년 ${fmt(cur.y10, 3)}% 기준 ${cfg.level10y} 상향돌파 고PER 압박`,
        emailSubject: `미국 10년물 ${fmt(cur.y10, 3)}% — 기준선 ${cfg.level10y}% 상향 돌파 (고PER 압박)`,
        snapshot: { y10: cur.y10, prevY10, level: cfg.level10y },
      });
    }
  }

  return hits;
}

// ── 시세 조회 — 네이버 채권 API (실시간·무지연). FRED는 1~2영업일 지연이라 부적합.
export type BondYieldQuote = { value: number | null; tradedAt: string | null };

async function fetchNaverBond(reutersCode: string): Promise<BondYieldQuote> {
  try {
    const res = await fetch(`https://api.stock.naver.com/marketindex/bond/${reutersCode}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
    });
    if (!res.ok) return { value: null, tradedAt: null };
    const j = (await res.json()) as { closePrice?: string; localTradedAt?: string };
    const v = parseFloat(j.closePrice ?? "");
    return {
      value: isNaN(v) || v <= 0 || v >= 20 ? null : v,
      tradedAt: j.localTradedAt ?? null,
    };
  } catch {
    return { value: null, tradedAt: null };
  }
}

export async function fetchUs2yYield(): Promise<BondYieldQuote> {
  return fetchNaverBond("US2YT=RR");
}

// 10년물 — 네이버 우선, 실패 시 야후 ^TNX 폴백 (bondSignal.ts와 동일 발상)
export async function fetchUs10yYield(): Promise<BondYieldQuote> {
  const naver = await fetchNaverBond("US10YT=RR");
  if (naver.value !== null) return naver;
  try {
    const { default: YahooFinance } = await import("yahoo-finance2");
    const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
    const q = await yf.quote("^TNX");
    const p = q.regularMarketPrice;
    return { value: typeof p === "number" && p > 0 && p < 20 ? p : null, tradedAt: null };
  } catch {
    return { value: null, tradedAt: null };
  }
}
