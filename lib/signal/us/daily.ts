// 미장 일봉 스윙 서비스 (사용자 지시 2026-07-23) — 한국 predict-daily(삼전 기준)의 미국판,
// 판정 지수 SOXX·행동 대상 SOXL(3x). 구성요소는 SOXX 10.5년 절제 실측 (config.usDaily 주석):
// 미너비니 판정자 + 사다리(와인스타인 생존 50%) + 10Y 급등 게이트. 브레이크·DXY·이벤트 감산은
// SOXX 실측 기각 — 수퍼트렌드·이벤트는 표시만.
// 흐름: ①백필·채점(r1·r3) ②마감 판정(16:05~16:59 ET — 기록, 조용시간이라 통지는 ③에서)
// ③애프터장 마감(19:55~20:15 ET = 08:55~09:15 KST 여름) 포스트마켓 가격 재확인 + 다음날
// 매수/매도 지침 문자 (매일 — 유지 시 N거래일째 표기, 한국 일봉 문자와 동일 사상).
// 저장: predict_daily_days 공유 (symbol="SOXX"). 순수 지표는 lib/predict-daily/models 재사용,
// 판정 조립은 미국 상수가 달라 자체 구현 (한국 judgeDaily는 삼전 게이트·원화 눈금 내장).

import YahooFinance from "yahoo-finance2";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { atr14, ema, isoWeekKey, MODELS, sma, supertrendUp } from "@/lib/predict-daily/models";
import { loadRecentDays, predictDailyTablesReady, updateLabels, upsertDay } from "@/lib/predict-daily/store";
import type { DailyBar, PredictDailyRow, Stance } from "@/lib/predict-daily/types";
import { US_SIGNAL_CONFIG } from "./config";
import { etNow } from "./data";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const D = US_SIGNAL_CONFIG.usDaily;
const SY = US_SIGNAL_CONFIG.usPredict.symbols; // SOXX / SOXL / SOXS

type UsDailyJudgment = {
  stance: Stance;
  baseExposure: number;
  exposure: number;
  votes: number;
  gates: string[];
  stopPx: number | null; // SOXX $ (센트 반올림)
  stopPct: number;
  closePx: number;
  modelStances: Record<string, Stance>;
  stUp: boolean;
  dd: number;
  midVote: number;
  trendT: number;
};

// ── 데이터
async function fetchDailyUs(symbol: string, days: number): Promise<DailyBar[]> {
  try {
    const r = await yf.chart(symbol, { period1: new Date(Date.now() - (days + 10) * 1.5 * 86400e3), interval: "1d" });
    return (r.quotes ?? [])
      .filter((x): x is typeof x & { open: number; high: number; low: number; close: number } =>
        x.open != null && x.high != null && x.low != null && x.close != null)
      .map((x) => {
        const d = x.date instanceof Date ? x.date : new Date(x.date);
        return { date: d.toISOString().slice(0, 10), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0 };
      });
  } catch {
    return [];
  }
}

// 오늘 미 10Y 변화 %p (^TNX 일봉 마지막 두 봉) — 게이트용. 실패 시 null(게이트 생략 폴백)
async function fetchY10Chg(): Promise<{ level: number; chg: number } | null> {
  const bars = await fetchDailyUs("^TNX", 10);
  if (bars.length < 2) return null;
  const a = bars[bars.length - 2].close, b = bars[bars.length - 1].close;
  return { level: b, chg: Number((b - a).toFixed(3)) };
}

// ── 판정 조립 — 한국 judgeDaily의 미국판 (미너비니 + 사다리 v4 + 10Y 게이트, SOXX 실측 구성)
function midTermVote(bars: DailyBar[], i: number, weinstein: Stance): number {
  const closes = bars.map((b) => b.close);
  let v = weinstein === "long" ? 1 : weinstein === "short" ? -1 : 0;
  const ma50 = sma(closes, 50)[i], ma200 = sma(closes, 200)[i];
  if (ma50 !== null && ma200 !== null) v += ma50 > ma200 ? 1 : -1;
  const weekKeys = bars.map((b) => isoWeekKey(b.date));
  const wkClose: number[] = [];
  const wkKey: string[] = [];
  for (let j = 0; j < bars.length; j++) {
    if (wkKey.length && wkKey[wkKey.length - 1] === weekKeys[j]) wkClose[wkClose.length - 1] = closes[j];
    else { wkKey.push(weekKeys[j]); wkClose.push(closes[j]); }
  }
  const wkEma = ema(wkClose, 13);
  const w = wkKey.lastIndexOf(weekKeys[i]);
  if (w >= 2 && wkEma[w - 1] !== null && wkEma[w - 2] !== null) v += wkEma[w - 1]! > wkEma[w - 2]! ? 1 : -1;
  return v;
}

export function judgeUsDaily(bars: DailyBar[], y10Chg: number | null): UsDailyJudgment {
  const i = bars.length - 1;
  const modelStances: Record<string, Stance> = {};
  for (const m of MODELS) modelStances[m.id] = m.run(bars)[i];
  const stUp = supertrendUp(bars)[i];
  let hi52 = -Infinity;
  for (let j = Math.max(0, i - 251); j <= i; j++) hi52 = Math.max(hi52, bars[j].close);
  const dd = bars[i].close / hi52 - 1;
  let trendT = 0;
  if (i >= 60) {
    const rs: number[] = [];
    for (let j = i - 59; j <= i; j++) rs.push(bars[j].close / bars[j - 1].close - 1);
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rs.length);
    trendT = sd > 0 ? (mean / sd) * Math.sqrt(rs.length) : 0;
  }
  const stance = modelStances["minervini"];
  const votes = (["donchian", "wilder", "weinstein", "elder"] as const).reduce(
    (a, id) => a + (modelStances[id] === "long" ? 1 : modelStances[id] === "short" ? -1 : 0), 0);
  const midVote = midTermVote(bars, i, modelStances["weinstein"]);

  // 사다리 v4 (SOXX 실측 채택): 미너비니 long 100% / flat+와인스타인 생존 50% / 붕괴 0
  let baseExposure = 0;
  if (stance === "long") baseExposure = 1;
  else if (stance === "flat" && modelStances["weinstein"] === "long") baseExposure = D.ladderWeakHold;

  let exposure = baseExposure;
  const gates: string[] = [];
  if (exposure > 0 && y10Chg !== null && y10Chg >= D.y10Gate.spikePp) {
    exposure *= D.y10Gate.factor;
    gates.push(`10Y급등(+${y10Chg.toFixed(2)}%p)`);
  }

  const closePx = bars[i].close;
  const atr = atr14(bars)[i];
  const stopPct = atr && closePx > 0
    ? Math.min(D.stop.maxPct, Math.max(D.stop.minPct, (D.stop.atrMult * atr) / closePx))
    : 0.08;
  return {
    stance, baseExposure, exposure, votes, gates,
    stopPx: exposure > 0 ? Number((closePx * (1 - stopPct)).toFixed(2)) : null,
    stopPct, closePx, modelStances, stUp, dd, midVote, trendT,
  };
}

// ── 문구 (한국 일봉 문자와 동일 사상, 대상만 SOXL)
function actionLabel(stance: Stance, exposure: number): string {
  if (exposure >= 0.9) return `풀보유(${SY.leverage} 100%)`;
  if (exposure >= 0.35) return `현금화 약(${SY.leverage} 50%)`;
  if (exposure >= 0.1) return `현금화 중(${SY.leverage} 25%)`;
  return stance === "short" ? "현금화 강(전량 현금·하락추세)" : "현금화 강(전량 현금)";
}
const tierOf = (e: number) => (e >= 0.9 ? 4 : e >= 0.6 ? 3 : e >= 0.35 ? 2 : e >= 0.1 ? 1 : 0);

function regimeLine(j: UsDailyJudgment): string {
  const mid = j.midVote >= 1 ? "↑" : j.midVote <= -1 ? "↓" : "→";
  const kind = j.trendT >= 1 ? "상승장" : j.trendT <= -1 ? "하락장" : "변동장";
  return `장세 단기${j.stUp ? "↑" : "↓"}(수퍼)·중장기${mid}(3지표${j.midVote >= 0 ? "+" : ""}${j.midVote})·${kind}·52주고점比${Math.round(j.dd * 100)}%.`;
}

// 미너비니·와인스타인 누적 방향적중 (r3 채점분, 표본 5+)
function mwAcc(rows: PredictDailyRow[]): string {
  const calc = (id: string): string => {
    let ok = 0, n = 0;
    for (const r of rows) {
      if (r.label_r3 === null || !r.model_stances) continue;
      const s = r.model_stances[id];
      if (!s || s === "flat") continue;
      n++;
      if (s === "long" ? r.label_r3 > 0 : r.label_r3 < 0) ok++;
    }
    return n >= 5 ? `(적중${Math.round((100 * ok) / n)}%/${n})` : "";
  };
  return `미너비니 ${calc("minervini")}·와인 ${calc("weinstein")}`;
}

// ── 서비스 본체 — /api/signal/us/state에서 호출
export async function runUsDailyService(): Promise<Record<string, unknown>> {
  const { date: today, minuteOfDay } = etNow();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const isWeekday = dow >= 1 && dow <= 5;
  const inJudge = isWeekday && minuteOfDay >= D.judgeWindowEt.from && minuteOfDay <= D.judgeWindowEt.to;
  const inAfter = isWeekday && minuteOfDay >= D.afterWindowEt.from && minuteOfDay <= D.afterWindowEt.to;
  const out: Record<string, unknown> = { judged: false, notified: false, scored: 0, backfilled: 0 };
  if (!inJudge && !inAfter) return out; // 창 밖 — DB 조회조차 생략 (크론 1분 호출 대비)
  if (!(await predictDailyTablesReady())) return { ...out, note: "마이그레이션 030 미적용" };

  const bars = await fetchDailyUs(SY.judge, D.daysFetch);
  if (bars.length < D.warmup + 10) return out;
  const rows = await loadRecentDays(SY.judge, 320);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const idxByDate = new Map(bars.map((b, i) => [b.date, i]));

  // ① 백필 (최근 backfillDays 완결 봉 중 미기록일 — 게이트는 소급 생략) + 채점 (r1·r3)
  for (let i = Math.max(D.warmup, bars.length - D.backfillDays); i < bars.length; i++) {
    const b = bars[i];
    const isToday = b.date === today;
    if (isToday && minuteOfDay < D.judgeWindowEt.from) continue; // 오늘 봉은 마감 후에만
    if (byDate.has(b.date)) continue;
    const j = judgeUsDaily(bars.slice(0, i + 1), null);
    await upsertDay({
      date: b.date, symbol: SY.judge, stance: j.stance, exposure: j.exposure, base_exposure: j.baseExposure,
      model_stances: j.modelStances, macro: null, flow: null, gates: j.gates, event: null,
      stop_px: j.stopPx, close_px: j.closePx, revisions: null,
      label_r1: null, label_r3: null, correct1: null, correct3: null, source: isToday ? "us_close" : "us_backfill",
    });
    out.backfilled = (out.backfilled as number) + 1;
  }
  // 채점 — 판정일 D 대비 r1 = D+1 종가/D 종가, r3 = D+3/D
  for (const r of rows) {
    if (r.label_r3 !== null) continue;
    const i = idxByDate.get(r.date);
    if (i === undefined) continue;
    const r1 = i + 1 < bars.length ? Number(((bars[i + 1].close / bars[i].close - 1) * 100).toFixed(2)) : null;
    const r3 = i + 3 < bars.length ? Number(((bars[i + 3].close / bars[i].close - 1) * 100).toFixed(2)) : null;
    if (r1 === null && r3 === null) continue;
    await updateLabels(r.date, SY.judge, {
      label_r1: r1, label_r3: r3,
      correct1: r1 === null || r.stance === "flat" ? null : r.stance === "long" ? r1 > 0 : r1 < 0,
      correct3: r3 === null || r.stance === "flat" ? null : r.stance === "long" ? r3 > 0 : r3 < 0,
      labeled_at: new Date().toISOString(),
    });
    out.scored = (out.scored as number) + 1;
  }

  const y10 = await fetchY10Chg().catch(() => null);

  // ② 마감 판정 (16:05~16:59 ET) — 오늘 봉 확정 판정 기록 (통지는 ③ 애프터 마감에서)
  if (inJudge && bars[bars.length - 1].date === today) {
    const j = judgeUsDaily(bars, y10?.chg ?? null);
    await upsertDay({
      date: today, symbol: SY.judge, stance: j.stance, exposure: j.exposure, base_exposure: j.baseExposure,
      model_stances: j.modelStances, macro: y10 ? { sox: null, fxLevel: null, fxChg: null, y10: y10.level, y10Chg: y10.chg, wti: null, wtiChg: null, dxy: null, dxyChg: null } : null,
      flow: null, gates: j.gates, event: null, stop_px: j.stopPx, close_px: j.closePx, revisions: null,
      label_r1: null, label_r3: null, correct1: null, correct3: null, source: "us_close",
    });
    out.judged = true;
  }

  // ③ 애프터장 마감 (19:55~20:15 ET = 08:55~09:15 KST 여름 / 겨울 +1h) — 포스트마켓 가격으로
  // 재확인 후 '다음날 지침' 문자 (매일 1회 — 사용자 지시: "애프터장 마감 때 다음날 매수/매도 알려줘")
  if (inAfter && D.sms.enabled && bars[bars.length - 1].date === today) {
    // 포스트마켓 최종가 — 낡은 스냅샷 가드 (마감 판정 대비 애프터 변동 반영)
    let afterPx: number | null = null;
    try {
      const q = await yf.quote(SY.judge);
      const t = q.postMarketTime instanceof Date ? q.postMarketTime : typeof q.postMarketTime === "number" ? new Date(q.postMarketTime * 1000) : null;
      if (typeof q.postMarketPrice === "number" && t && Date.now() - t.getTime() < 3 * 3600e3) afterPx = q.postMarketPrice;
    } catch { /* 폴백: 정규 종가 판정 그대로 */ }

    const barsAfter = afterPx !== null
      ? [...bars.slice(0, -1), { ...bars[bars.length - 1], close: afterPx, high: Math.max(bars[bars.length - 1].high, afterPx), low: Math.min(bars[bars.length - 1].low, afterPx) }]
      : bars;
    const j = judgeUsDaily(barsAfter, y10?.chg ?? null);
    const closeJ = judgeUsDaily(bars, y10?.chg ?? null);
    const label = actionLabel(j.stance, j.exposure);
    const changedInAfter = tierOf(j.exposure) !== tierOf(closeJ.exposure);

    // 유지 스트릭 — 같은 단계 연속 거래일 수 (오늘 포함)
    const freshRows = await loadRecentDays(SY.judge, 320);
    let streak = 1;
    let since = today;
    const tier = tierOf(closeJ.exposure);
    for (let k = freshRows.length - 1; k >= 0; k--) {
      const r = freshRows[k];
      if (r.date >= today) continue;
      if (r.stance === closeJ.stance && tierOf(r.exposure) === tier) { streak++; since = r.date; }
      else break;
    }
    const stopLine = j.stopPx
      ? ` 손절 ${SY.judge} $${j.stopPx.toFixed(2)}(-${Math.round(j.stopPct * 100)}% — ${SY.leverage} 약 -${Math.round(j.stopPct * 300)}%)`
      : "";
    const evNote = ""; // 이벤트 감산은 SOXX 실측 기각 — 필요 시 표시 전용으로 추가
    const pxPart = afterPx !== null
      ? `종가 $${closeJ.closePx.toFixed(2)}→애프터 $${afterPx.toFixed(2)}(${(((afterPx - closeJ.closePx) / closeJ.closePx) * 100).toFixed(1)}%)`
      : `종가 $${closeJ.closePx.toFixed(2)}`;
    const head = changedInAfter
      ? `${actionLabel(closeJ.stance, closeJ.exposure)} → ${label} (애프터 변동 반영)`
      : `${label}${streak > 1 ? ` 유지 — ${since.slice(5).replace("-", "/")}부터 ${streak}거래일째` : ""}`;
    const text = `[미국일봉] ${SY.judge} 내일 지침: ${head}. ${pxPart}.${stopLine} ${regimeLine(j)} ${mwAcc(freshRows)}${evNote} 무응답=현행 유지`;
    try {
      await dispatchToChannels("signal", today, {
        key: "usdaily_notify", severity: "medium", text, smsSubject: "미국 일봉",
      }, undefined, undefined, { dedupHours: 16 });
      out.notified = true;
    } catch { /* 발송 실패 무시 */ }
  }

  return out;
}
