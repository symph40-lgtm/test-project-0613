// 미국 2년물 금리 급등락 알람 — 판정 로직 (기획: docs/rate-alert.md)
//
// 조건 (모두 OR, 알림 키별 1일 1회):
//  - 급변: 30분 변동 ≥ ±Δ30 또는 1시간 변동 ≥ ±Δ1h → 급등=매도 검토 / 급락=매수 검토
//  - 단계 레벨: 2년물이 4.14(경고)/4.15(위험)/4.16(최고위험) 돌파 시 알림, 내려오면 해제 알림.
//    (원래 4.125 단일 기준이었으나 금리가 그 주변에서 진동해 노이즈만 발생 — 사용자 요청으로
//     2026-07-07 제거하고 단계형으로 교체)
//  - 10년물: 기준(기본 4.45%) 상향 돌파 → 고PER 압박 경고
// 임계값 근거: scripts/rate-alert-analyze.ts 실측 (6/5·6/18·6/30·7/1 이벤트 4일 전부 감지).
//
// 변동값은 분봉 API가 아니라 rate_samples에 축적된 샘플 간 차이로 계산 —
// 크론이 10분 간격으로 돌아야 30분 변동을 ±10분 정확도로 잡는다.

export type RateAlertConfig = {
  delta30m: number;   // 2년물 30분 변동 임계값 (%p)
  delta1h: number;    // 2년물 1시간 변동 임계값 (%p)
  levels2y: number[]; // 2년물 단계 레벨 (%, 오름차순 — 경고→위험→최고위험)
  level10y: number;   // 10년물 절대 레벨 (%)
};

// 단계 이름·행동 지침 — levels2y 인덱스 순 (마지막 초과분은 전부 최고위험)
// 행동 사다리는 사용자 지정(2026-07-07): 경고=주식 1/3 감축, 위험=2/3 매도, 최고위험=전량 매도
export const LEVEL2Y_GRADES = ["경고", "위험", "최고위험"] as const;
export const LEVEL2Y_ACTIONS = ["주식 1/3 감축", "주식 2/3 매도", "전량 매도"] as const;
export function grade2yName(idx: number): string {
  return LEVEL2Y_GRADES[Math.min(idx, LEVEL2Y_GRADES.length - 1)];
}
export function grade2yAction(idx: number): string {
  return LEVEL2Y_ACTIONS[Math.min(idx, LEVEL2Y_ACTIONS.length - 1)];
}

function envNum(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return isNaN(v) ? fallback : v;
}

function envLevels(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const arr = raw
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((v) => !isNaN(v) && v > 0 && v < 20)
    .sort((a, b) => a - b);
  return arr.length > 0 ? arr : fallback;
}

// 환경변수로 조정 가능 (기본값은 2026-06~07 실측 분석 기준 — docs/rate-alert.md 2장)
export function rateAlertConfig(): RateAlertConfig {
  return {
    delta30m: envNum("RATE_ALERT_2Y_DELTA_30M", 0.03),
    delta1h: envNum("RATE_ALERT_2Y_DELTA_1H", 0.03),
    levels2y: envLevels("RATE_ALERT_2Y_LEVELS", [4.135, 4.15, 4.16]),
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

    // ── 2년물 단계 레벨 (완만하지만 지속적인 상승 커버 — 4.14 경고 / 4.15 위험 / 4.16 최고위험)
    // 상태 기계: 현재가 몇 번째 단계 위인지(state = 넘어선 레벨 수)를 직전 샘플과 비교해
    // 올라가면 해당 단계 돌파 알림, 내려오면 해제 알림. 한 번에 여러 단계를 건너뛰면
    // 최종 단계 1건만 발송 (문자 폭주 방지). 직전 샘플이 없으면(첫 가동) 0단계에서 출발 —
    // 현재 이미 단계 위면 그 단계 돌파 알림 1회.
    const levels = cfg.levels2y;
    const stateOf = (v: number) => levels.filter((L) => v >= L).length;
    const sCur = stateOf(cur.y2);
    const sPrev = prevFresh?.y2 != null ? stateOf(prevFresh.y2) : 0;

    if (sCur > sPrev) {
      const level = levels[sCur - 1];
      const grade = grade2yName(sCur - 1);
      const action = grade2yAction(sCur - 1);
      hits.push({
        key: `rate2y_lvl_u${level}`,
        severity: sCur - 1 === 0 ? "medium" : "high",
        smsSubject: `금리 ${grade}단계`,
        text: `[스탁가드] 미2년 ${fmt(cur.y2, 3)}% 기준 ${level} 돌파 — ${grade}단계·${action} 검토`,
        emailSubject: `미국 2년물 ${fmt(cur.y2, 3)}% — ${level}% 돌파 (${grade}단계 · ${action} 검토)`,
        snapshot: { y2: cur.y2, prevY2: prevFresh?.y2 ?? null, level, grade, action, levels },
      });
    }
    if (sCur < sPrev) {
      const level = levels[sCur]; // 이제 이 레벨 아래로 내려옴
      const grade = grade2yName(sCur);
      hits.push({
        key: `rate2y_lvl_d${level}`,
        severity: "medium",
        smsSubject: "금리단계 해제",
        text: `[스탁가드] 미2년 ${fmt(cur.y2, 3)}% 기준 ${level} 하향이탈 — ${grade}단계 해제`,
        emailSubject: `미국 2년물 ${fmt(cur.y2, 3)}% — ${level}% 하향 이탈 (${grade}단계 해제)`,
        snapshot: { y2: cur.y2, prevY2: prevFresh?.y2 ?? null, level, grade, levels },
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
export type BondYieldQuote = {
  value: number | null;
  tradedAt: string | null;
  change: number | null; // 전일 대비 (%p)
};

async function fetchNaverBond(reutersCode: string): Promise<BondYieldQuote> {
  try {
    const res = await fetch(`https://api.stock.naver.com/marketindex/bond/${reutersCode}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
    });
    if (!res.ok) return { value: null, tradedAt: null, change: null };
    const j = (await res.json()) as { closePrice?: string; localTradedAt?: string; fluctuations?: string };
    const v = parseFloat(j.closePrice ?? "");
    const chg = parseFloat(j.fluctuations ?? "");
    return {
      value: isNaN(v) || v <= 0 || v >= 20 ? null : v,
      tradedAt: j.localTradedAt ?? null,
      change: isNaN(chg) ? null : chg,
    };
  } catch {
    return { value: null, tradedAt: null, change: null };
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
    return { value: typeof p === "number" && p > 0 && p < 20 ? p : null, tradedAt: null, change: null };
  } catch {
    return { value: null, tradedAt: null, change: null };
  }
}
