// 장중 진입 브리핑 (사용자 지정 2026-07-10) — 스펙 부록 B 2026-07-10.
// 개장 후 고정 체크포인트(+1·3·5·10·15·20·30·50분) 8회, 09:50 이후엔 추세 전환·감속·판정 변경 시
// 즉시 + 없어도 60분마다 정기 발송. 본문은 판정·수급 + 지표 9종을 "직전 브리핑 값 대비 변화율"과
// 함께 표기 (첫 회는 전일 종가 대비). 지표 9종이라 장문(LMS) — 단문 90바이트 정책의 예외.
// 직전 값 저장소: alerts.market_snapshot (trigger_key 'signal', alertKey 'ebrief_*') — 새 테이블 불필요.
// 트리거: /api/signal/state 호출(60초 폴링·외부 크론)에 얹힘 — 상주 프로세스 없음.

import YahooFinance from "yahoo-finance2";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { fetchUs2yYield, fetchUs10yYield } from "@/lib/market/rateAlert";
import { SIGNAL_CONFIG } from "./config";
import { flowDelta } from "./engine/trend";
import type { IntradayTick, Judgment } from "./types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const S = SIGNAL_CONFIG.session;
const E = SIGNAL_CONFIG.entryBrief;

// 지표 9종 스냅샷 값 (레벨) — 변화율 계산의 원본
type BriefVals = {
  y2: number | null;   // 미 2년물 금리 (%)
  y10: number | null;  // 미 10년물 금리 (%)
  fx: number | null;   // USD/KRW
  oil: number | null;  // WTI ($)
  fut: number | null;  // K200 선물 (FKS200)
  nk: number | null;   // 닛케이 225 (JP225)
  soxx: number | null; // SOXX ETF ($, 시간외 포함 마지막 값)
  nq: number | null;   // 나스닥 선물 (NQ=F)
  es: number | null;   // S&P500 선물 (ES=F)
};

// alerts.market_snapshot에 저장하는 직전 브리핑 상태
export type EntryBriefSnapshot = {
  kind: "entry_brief";
  minuteOfDay: number;
  hhmm: string;
  vals: BriefVals;
  slope30: number | null; // 발송 시점의 K200 선물 30분 기울기 (%p) — 전환·감속 비교 기준
  dayType: string;
};

// 전일 대비 등락 (첫 브리핑의 괄호 값) — 금리는 %p, 나머지는 %
type DayChg = { y2Pp: number | null; others: Partial<Record<keyof BriefVals, number | null>>; nkClosed: boolean };

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtBil = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}억`;
const signed = (v: number, d: number) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

// 거래량 배율 — 최근 완성 5분봉 거래량 ÷ 당일 평균 (buildVolumeAlert와 동일 계산.
// 사용자 지정 2026-07-15: 개별 거래량 문자를 중단하고 브리핑 본문에 급증/급감으로 포함)
function volRatio(ticks: IntradayTick[], sel: (t: IntradayTick) => number | null | undefined): number | null {
  const V = SIGNAL_CONFIG.volumeAlert;
  const pts = ticks.filter((t) => {
    const v = sel(t);
    return v != null && isFinite(v) && t.minuteOfDay >= S.openMin;
  });
  if (pts.length < 4) return null;
  const nowMin = ticks[ticks.length - 1].minuteOfDay;
  const byBucket = new Map<number, number>();
  for (const p of pts) byBucket.set(Math.floor(p.minuteOfDay / 5), sel(p) as number);
  const buckets = [...byBucket.entries()].filter(([b]) => (b + 1) * 5 <= nowMin).sort(([a], [b]) => a - b);
  const bars: number[] = [];
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i][0] - buckets[i - 1][0] !== 1) continue;
    const vol = buckets[i][1] - buckets[i - 1][1];
    if (vol >= 0) bars.push(vol);
  }
  if (bars.length < V.minBars + 1) return null;
  const last = bars[bars.length - 1];
  const avg = bars.slice(0, -1).reduce((s, x) => s + x, 0) / (bars.length - 1);
  return avg > 0 ? last / avg : null;
}

function volNote(ratio: number | null): string {
  if (ratio === null) return "?";
  const V = SIGNAL_CONFIG.volumeAlert;
  const tag = ratio >= V.ratio ? "급증" : ratio <= V.lowRatio ? "급감" : "보통";
  return `${ratio.toFixed(1)}배(${tag})`;
}

// K200 선물 등락률의 최근 30분 기울기 (%p) — 전환·감속 판정용 (스펙 부록 B 2026-07-10)
export function futSlope30(ticks: IntradayTick[]): number | null {
  const pts = ticks
    .filter((t) => t.futChg !== null && isFinite(t.futChg) && t.minuteOfDay >= S.openMin)
    .map((t) => ({ min: t.minuteOfDay, v: t.futChg as number }));
  if (pts.length < 2) return null;
  const cur = pts[pts.length - 1];
  const past = pts.filter((p) => p.min <= cur.min - E.slopeWindowMin);
  const base = past.length > 0 ? past[past.length - 1] : pts[0];
  if (cur.min - base.min < 15) return null; // 창의 절반도 안 되면 기울기로 안 봄
  return cur.v - base.v;
}

// ── 지표 9종 수집 — 발송이 확정된 호출에서만 (매 틱 네트워크 낭비 방지).
// K200 선물은 여기서 수집하지 않는다 — 판정 라인과 같은 틱(futPx·futChg)을 쓴다
// (실측 2026-07-14 14:03: 별도 호출이 스테일 값(전일대)을 반환해 직전比 +2.46% 왜곡.
//  헤드라인 +0.51%와 지표 라인이 서로 다른 소스였던 문제 — 사용자 지적).
async function fetchBriefIndicators(): Promise<{ vals: Omit<BriefVals, "fut">; day: DayChg }> {
  const q = async (sym: string) => {
    try {
      return await yf.quote(sym);
    } catch {
      return null;
    }
  };
  // 신선도 가드 — 24시간 거래 상품(선물·환율)이 30분 이상 오래된 체결가면 스테일로 보고 제외
  // (실측 2026-07-14: NQ·ES·WTI가 브리핑마다 같은 값·+0.00%로 고정 — 사용자 지적)
  const freshOr = <T,>(qq: T | null, maxMin = 30): T | null => {
    if (!qq) return null;
    const t = (qq as { regularMarketTime?: unknown }).regularMarketTime;
    const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t * 1000 : null;
    if (ms === null || Date.now() - ms > maxMin * 60000) return null;
    return qq;
  };
  const [y2, y10, fxq0, oilq0, nkq, soxxq, nqq0, esq0] = await Promise.all([
    fetchUs2yYield().catch(() => ({ value: null, change: null, tradedAt: null })),
    fetchUs10yYield().catch(() => ({ value: null, change: null, tradedAt: null })),
    q("KRW=X"), q("CL=F"), q("^N225"), q("SOXX"), q("NQ=F"), q("ES=F"),
  ]);
  const fxq = freshOr(fxq0), oilq = freshOr(oilq0), nqq = freshOr(nqq0), esq = freshOr(esq0);

  // 닛케이 당일 체결 가드 (data.ts D1과 동일 근거 — 휴장이면 어제 값·등락률 오용 방지)
  let nkPx: number | null = nkq?.regularMarketPrice ?? null;
  let nkChg: number | null = nkq?.regularMarketChangePercent ?? null;
  let nkClosed = false;
  {
    const t = nkq?.regularMarketTime;
    const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t * 1000 : null;
    const dayKst = (x: number) => new Date(x + 9 * 3600e3).toISOString().slice(0, 10);
    if (ms === null || dayKst(ms) !== dayKst(Date.now())) {
      nkPx = null;
      nkChg = null;
      nkClosed = true;
    }
  }

  const vals: Omit<BriefVals, "fut"> = {
    y2: y2.value,
    y10: y10.value,
    fx: fxq?.regularMarketPrice ?? null,
    oil: oilq?.regularMarketPrice ?? null,
    nk: nkPx,
    soxx: soxxq?.postMarketPrice ?? soxxq?.regularMarketPrice ?? null, // 시간외 포함 마지막 값
    nq: nqq?.regularMarketPrice ?? null,
    es: esq?.regularMarketPrice ?? null,
  };
  const day: DayChg = {
    y2Pp: y2.change, // 전일 대비 %p (10Y는 네이버 change가 없을 수 있어 미사용 — 레벨만)
    others: {
      fx: fxq?.regularMarketChangePercent ?? null,
      oil: oilq?.regularMarketChangePercent ?? null,
      nk: nkChg,
      soxx: soxxq?.postMarketChangePercent ?? soxxq?.regularMarketChangePercent ?? null,
      nq: nqq?.regularMarketChangePercent ?? null,
      es: esq?.regularMarketChangePercent ?? null,
    },
    nkClosed,
  };
  return { vals, day };
}

// ── 본문 구성 (순수 함수 — 테스트 가능)
export function buildEntryBriefText(args: {
  reason: string;
  hhmm: string;
  j: Judgment;
  ticks: IntradayTick[];
  vals: BriefVals;
  day: DayChg;
  prev: EntryBriefSnapshot | null;
}): string {
  const { reason, hhmm, j, ticks, vals, day, prev } = args;
  const t = j.trend;
  const last = ticks[ticks.length - 1];

  // 금리: 직전比 %p 차, 첫 회는 전일比 %p (2Y만 — 10Y 전일치 소스 불안정 시 생략)
  const pp = (cur: number | null, prevV: number | null | undefined, dayPp: number | null): string => {
    if (cur === null) return "?";
    const d = prev ? (prevV != null ? cur - prevV : null) : dayPp;
    return `${cur.toFixed(3)}%(${d === null ? "?" : signed(d, 3) + "p"})`;
  };
  // 가격류: 직전比 %, 첫 회는 전일比 %
  const px = (key: keyof BriefVals, digits: number, comma = false): string => {
    const cur = vals[key];
    if (cur === null) return "?";
    const prevV = prev?.vals[key];
    const d = prev
      ? prevV != null && prevV !== 0 ? ((cur - prevV) / prevV) * 100 : null
      : day.others[key] ?? null;
    const level = comma ? Math.round(cur).toLocaleString("ko-KR") : cur.toFixed(digits);
    return `${level}(${d === null ? "?" : signed(d, 2) + "%"})`;
  };

  const dirLabel = t?.dir === "UP" ? "상방" : t?.dir === "DOWN" ? "하방" : "방향 미형성";
  const judgeLine = t
    ? `판정 ${j.dayType}·${dirLabel} T${t.score.toFixed(0)}/${t.maxAvailable}` +
      ` · K200선물 ${last?.futChg !== null && last?.futChg !== undefined ? signed(last.futChg, 2) + "%" : "?"}` +
      ` 하닉 ${last?.hynixChg !== null && last?.hynixChg !== undefined ? signed(last.hynixChg, 2) + "%" : "?"}` +
      ` 삼전 ${last?.samsungChg !== null && last?.samsungChg !== undefined ? signed(last.samsungChg, 2) + "%" : "?"}`
    : `판정 ${j.dayType} · 장중 데이터 수집 중`;

  // 수급 — 외인 현물(누적+Δ30분)이 주요 팩터 (2026-07-10)
  const kf = flowDelta(ticks, (x) => x.kospiFrgn);
  const flowParts: string[] = [];
  if (kf !== null) flowParts.push(`외인현물 ${fmtBil(kf.cur)}(Δ${kf.spanMin}분 ${fmtBil(kf.delta)})`);
  else if (last?.kospiFrgn != null) flowParts.push(`외인현물 ${fmtBil(last.kospiFrgn)}`);
  if (last?.kospiPrgm != null) flowParts.push(`프로그램 ${fmtBil(last.kospiPrgm)}`);
  if (last?.futFrgn != null) flowParts.push(`선물외인 ${fmtBil(last.futFrgn)}`);
  const flowLine = flowParts.length > 0 ? flowParts.join(" · ") : "수급(KIS) 데이터 대기";

  // 거래량 라인 — 하닉·삼전 최근 5분봉 거래량 배율 (당일 평균 대비, 급증 ≥1.3배 / 급감 ≤0.6배)
  const volLine = `거래량(5분봉) 하닉 ${volNote(volRatio(ticks, (x) => x.hynixVol))} · 삼전 ${volNote(volRatio(ticks, (x) => x.samsungVol))}`;

  const lines = [
    `[스탁가드] 장중브리핑 ${reason} (${hhmm})`,
    judgeLine,
    flowLine,
    volLine,
    `미2Y ${pp(vals.y2, prev?.vals.y2, day.y2Pp)} 10Y ${pp(vals.y10, prev?.vals.y10, null)}`,
    `환율 ${px("fx", 1)}원 · WTI ${px("oil", 2)}$`,
    `K200선물 ${px("fut", 2)} · 닛케이 ${day.nkClosed && vals.nk === null ? "휴장" : px("nk", 0, true)}`,
    `SOXX ${px("soxx", 2)}$ · 나스닥선물 ${px("nq", 0, true)} · S&P선물 ${px("es", 0, true)}`,
    `※괄호=${prev ? `직전 ${prev.hhmm}` : "전일종가"}比`,
  ];
  return lines.join("\n");
}

// ── 발송 판단 + 실행 — state 라우트에서 매 호출 실행 (발송 조건일 때만 지표 수집·발송)
export async function maybeSendEntryBrief(j: Judgment, ticks: IntradayTick[]): Promise<number> {
  const now = ticks.length > 0 ? ticks[ticks.length - 1].minuteOfDay : null;
  if (now === null) return 0;
  const firstCp = S.openMin + E.checkpoints[0];
  if (now < firstCp || now > S.endMin) return 0;

  // 오늘 발송된 브리핑 이력 (키 집합 + 최신 스냅샷)
  const admin = createAdminClient();
  const kstDayStartUtc = new Date(`${j.date}T00:00:00+09:00`).toISOString();
  const { data } = await admin
    .from("alerts")
    .select("created_at, message, market_snapshot")
    .eq("trigger_key", "signal")
    .gte("created_at", kstDayStartUtc)
    .order("created_at", { ascending: true });
  const sent = new Set<string>();
  let prev: EntryBriefSnapshot | null = null;
  for (const r of data ?? []) {
    const k = (r.message as { alertKey?: string } | null)?.alertKey;
    if (typeof k !== "string" || !k.startsWith("ebrief_")) continue;
    sent.add(k);
    const snap = r.market_snapshot as EntryBriefSnapshot | null;
    if (snap && snap.kind === "entry_brief") prev = snap; // asc 정렬 — 마지막이 최신
  }

  // 1) 고정 체크포인트 — 유예 내 최신 것 1건만 (수집 늦게 시작 시 몰아서 발송 방지)
  let key: string | null = null;
  let reason: string | null = null;
  const dueCp = E.checkpoints.filter((c) => now >= S.openMin + c && now <= S.openMin + c + E.checkpointGraceMin);
  const cp = dueCp.length > 0 ? Math.max(...dueCp) : null;
  if (cp !== null && !sent.has(`ebrief_c${cp}`)) {
    key = `ebrief_c${cp}`;
    reason = `개장+${cp}분`;
  } else if (now >= S.openMin + E.checkpoints[E.checkpoints.length - 1]) {
    // 2) 09:50 이후 — 전환·감속·판정 변경(15분 간격) 또는 정기(60분)
    const sinceLast = prev === null ? Infinity : now - prev.minuteOfDay;
    const cur = futSlope30(ticks);
    if (sinceLast >= E.hourlyMin) {
      key = `ebrief_m${now}`;
      reason = "정기(1시간)";
    } else if (sinceLast >= E.changeCooldownMin) {
      if (prev !== null && prev.dayType !== j.dayType) {
        key = `ebrief_m${now}`;
        reason = `판정 변경(${prev.dayType}→${j.dayType})`;
      } else if (
        cur !== null && prev?.slope30 != null &&
        Math.abs(cur) >= E.minSlopePct && Math.abs(prev.slope30) >= E.minSlopePct &&
        Math.sign(cur) !== Math.sign(prev.slope30)
      ) {
        key = `ebrief_m${now}`;
        reason = "추세 전환";
      } else if (
        cur !== null && prev?.slope30 != null &&
        Math.sign(cur) === Math.sign(prev.slope30) &&
        Math.abs(prev.slope30) >= E.decelBasePct &&
        Math.abs(cur) <= E.decelRatio * Math.abs(prev.slope30)
      ) {
        key = `ebrief_m${now}`;
        reason = "추세 감속";
      }
    }
  }
  if (key === null || reason === null) return 0;

  const hhmm = hm(now);
  const { vals: fetched, day } = await fetchBriefIndicators();
  // K200 선물은 판정 라인과 같은 틱 소스 — 헤드라인·지표 라인 불일치 제거 (2026-07-15)
  const lastTick = ticks[ticks.length - 1];
  const vals: BriefVals = { ...fetched, fut: lastTick?.futPx ?? null };
  day.others.fut = lastTick?.futChg ?? null;
  const text = buildEntryBriefText({ reason, hhmm, j, ticks, vals, day, prev });
  const snapshot: EntryBriefSnapshot = {
    kind: "entry_brief",
    minuteOfDay: now,
    hhmm,
    vals,
    slope30: futSlope30(ticks),
    dayType: j.dayType,
  };
  return dispatchToChannels(
    "signal",
    j.date,
    { key, severity: "medium", text, smsSubject: `장중브리핑 ${reason}` },
    `장중 브리핑 — ${reason} (${hhmm})`,
    snapshot as unknown as Record<string, unknown>,
  );
}
