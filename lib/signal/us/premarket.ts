// 미장 프리장(프리마켓) 판정 서비스 (사용자 지정 2026-07-21) — 한국 애프터장 판정(lib/predict/after.ts)의
// 미국판. SMH 프리마켓 5분봉(07:00~09:30 ET)에 피셔(ACD)를 돌려 정규장 방향을 선판정한다.
// 구조: 08:00 첫 체크포인트 → 30분마다 → 09:25 확정(개장 직전), 사이 구간 모니터링(변경 시 문자),
// 정규장 마감 후 채점(시가→종가 부호 적중 + 스탑 -1.5% 손익 — 백테스트와 동일 기준).
// 상수 근거: scripts/us-premarket-backtest.ts 38거래일 스윕 (config.premarket 주석).
// 의존: lib/predict의 순수 모델(runFisher)·지표만 가져온다 (predict→signal 역방향 import는 없음 — 경계 유지).

import YahooFinance from "yahoo-finance2";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { runFisher } from "@/lib/predict/models/fisher";
import { avgRange } from "@/lib/predict/indicators";
import type { MinuteBar, Verdict } from "@/lib/predict/types";
import { US_SIGNAL_CONFIG } from "./config";
import { etNow, fetchSmhDaily } from "./data";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const PM = US_SIGNAL_CONFIG.premarket;

const V_KO: Record<Verdict, string> = { leverage: "상방(USD 2x)", inverse: "하방(SSG -2x)", none: "추세없음" };
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const OPEN_ET = 9 * 60 + 30, CLOSE_ET = 16 * 60;

type PreRev = { at: string; checkpoint?: string; verdict: Verdict; strength: number };
type PreRow = {
  date: string;
  final_verdict: Verdict;
  strength: number;
  stage: "open" | "final";
  revisions: PreRev[] | null;
  r_oc: number | null;
};

type EtBar = { etDay: string; etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };

// ── 야후 5분봉 (프리·정규 포함) — ET 변환 (DST 자동)
const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
async function fetchSmh5m(daysBack: number): Promise<Map<string, EtBar[]>> {
  const byDay = new Map<string, EtBar[]>();
  try {
    const r = await yf.chart(US_SIGNAL_CONFIG.symbols.judge, {
      period1: new Date(Date.now() - daysBack * 86400e3), interval: "5m", includePrePost: true,
    });
    for (const q of r.quotes ?? []) {
      if (q.close == null || q.open == null) continue;
      const d = q.date instanceof Date ? q.date : new Date(q.date);
      const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
      const h = p.hour === "24" ? 0 : parseInt(p.hour, 10);
      const etMin = h * 60 + parseInt(p.minute, 10);
      const day = `${p.year}-${p.month}-${p.day}`;
      const arr = byDay.get(day) ?? [];
      arr.push({
        etDay: day, etMin, time: `${String(h).padStart(2, "0")}:${p.minute}`,
        open: q.open, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close,
        volume: typeof q.volume === "number" ? q.volume : 0,
      });
      byDay.set(day, arr);
    }
    for (const arr of byDay.values()) arr.sort((a, b) => a.etMin - b.etMin);
  } catch { /* 야후 실패 — 빈 맵 (호출부에서 생략) */ }
  return byDay;
}

// ── 채점 — 백테스트와 동일: 정규장 시가 진입, 스탑(-stopPct% SMH) 5분봉 고저 관통
function scoreDay(regBars: EtBar[], verdict: Verdict): { rOC: number; hit: boolean | null; pnlStop: number } {
  const entry = regBars[0].open;
  const close = regBars[regBars.length - 1].close;
  const rOC = Number((((close - entry) / entry) * 100).toFixed(2));
  if (verdict === "none") return { rOC, hit: null, pnlStop: 0 };
  const dirUp = verdict === "leverage";
  let pnlStop: number | null = null;
  for (const b of regBars) {
    const adverse = dirUp ? ((b.low - entry) / entry) * 100 : ((entry - b.high) / entry) * 100;
    if (adverse <= -PM.stopPct) { pnlStop = -PM.stopPct; break; }
  }
  if (pnlStop === null) pnlStop = dirUp ? rOC : -rOC;
  return { rOC, hit: (dirUp && rOC > 0) || (!dirUp && rOC < 0), pnlStop: Number(pnlStop.toFixed(2)) };
}

async function loadPreRow(date: string): Promise<PreRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("us_premarket_days")
    .select("date, final_verdict, strength, stage, revisions, r_oc")
    .eq("date", date)
    .maybeSingle();
  if (error) throw new Error(`us_premarket_days 조회 실패(마이그레이션 029 확인): ${error.message}`);
  return (data as PreRow | null) ?? null;
}

// ── 서비스 본체 — /api/signal/us/state에서 호출 (실패해도 정규장 흐름 무관)
export async function runUsPremarketService(): Promise<{ judged: boolean; scored: string[] }> {
  const { date: today, minuteOfDay } = etNow();
  const admin = createAdminClient();
  const result = { judged: false, scored: [] as string[] };

  // ① 미채점 백필 (정규장 마감 후 소급 가능 — 야후 5분봉은 60일 보존)
  const { data: unscored } = await admin
    .from("us_premarket_days")
    .select("date, final_verdict")
    .is("labeled_at", null)
    .order("date", { ascending: true })
    .limit(8);
  const scoreable = (unscored ?? []).filter(
    (r) => String(r.date) < today || minuteOfDay >= CLOSE_ET + 5,
  );
  if (scoreable.length > 0) {
    const oldest = String(scoreable[0].date);
    const daysBack = Math.min(55, Math.ceil((Date.now() - new Date(`${oldest}T00:00:00Z`).getTime()) / 86400e3) + 3);
    const byDay = await fetchSmh5m(daysBack);
    for (const r of scoreable) {
      const d = String(r.date);
      const regBars = (byDay.get(d) ?? []).filter((b) => b.etMin >= OPEN_ET && b.etMin < CLOSE_ET);
      if (regBars.length < 30) continue; // 반일장·결손 — 다음 기회에 재시도
      const s = scoreDay(regBars, r.final_verdict as Verdict);
      await admin
        .from("us_premarket_days")
        .update({ r_oc: s.rOC, hit: s.hit, pnl_stop: s.pnlStop, labeled_at: new Date().toISOString() })
        .eq("date", d);
      result.scored.push(d);
    }
  }

  // ② 라이브 스트림 — 07:45(OR+확인 최소 성립)~09:28 ET
  if (minuteOfDay < hhmmToMin(PM.sessionStartEt) + (PM.orBars + PM.confirmBars + 1) * 5 || minuteOfDay > hhmmToMin(PM.finalCp) + 3) return result;
  const prior = await loadPreRow(today);
  if (prior && prior.stage === "final") return result;

  const [byDay, daily] = await Promise.all([fetchSmh5m(3), fetchSmhDaily(80)]);
  const pre = (byDay.get(today) ?? []).filter((b) => b.etMin >= hhmmToMin(PM.sessionStartEt) && b.etMin < OPEN_ET);
  if (pre.length < PM.orBars + PM.confirmBars + 2) return result;
  const history = daily.filter((b) => b.date < today).slice(-120);
  const range10 = avgRange(history, 10);
  if (history.length < 30 || range10 === null) return result;

  // 오프셋 = 세션 시가 × (조기 0.15% / 09:00부터 0.4%) — 백테스트 실측 (config 주석)
  const judgeAt = (cut: string): { verdict: Verdict; strength: number } | null => {
    const w = pre.filter((b) => b.time < cut);
    if (w.length < PM.orBars + PM.confirmBars + 2) return null;
    const offsetPct = cut >= PM.lateFrom ? PM.offsetPctLate : PM.offsetPctEarly;
    const offsetRatio = ((offsetPct / 100) * w[0].open) / range10;
    const minute: MinuteBar[] = w.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const out = runFisher(
      { date: today, dailyHistory: history, openPx: w[0].open, morning: minute, prevDayMinutes: null },
      { orMinutes: PM.orBars, offsetRangeRatio: offsetRatio, confirmMinutes: PM.confirmBars, reversalMinutes: PM.reversalBars, earlyConfirmBy: "08:00" },
    );
    return { verdict: out.verdict, strength: Number((out.confidence * 100).toFixed(0)) };
  };

  const sms = async (whenLabel: string, prev: Verdict | null, v: { verdict: Verdict; strength: number }, isFinal: boolean) => {
    const head = isFinal ? `프리장 확정(${PM.finalCp} ET)` : `프리장 ${whenLabel} ET`;
    let text = prev === null
      ? `[스탁가드 미국] ${head} 첫 판정: ${V_KO[v.verdict]} (강도 ${v.strength}%)`
      : `[스탁가드 미국] ${head} 판정 변경: ${V_KO[prev]}→${V_KO[v.verdict]} (강도 ${v.strength}%)`;
    if (v.verdict !== "none") {
      text += `\n▶개장(09:30 ET·한국 22:30) 진입 참고 · 스탑 ETF -3% · 16:00 ET 당일 청산. 소표본(38일) 검증 — 소액만.`;
    }
    try {
      await dispatchToChannels("signal", today, {
        key: `us_pre_${isFinal ? "final" : whenLabel.replace(":", "")}_${v.verdict}`,
        severity: "medium",
        text,
        smsSubject: "미국 프리장",
      });
    } catch { /* 발송 실패 무시 */ }
  };

  let revs: PreRev[] = prior?.revisions ?? [];
  let changed = false;
  const done = new Set(revs.map((r) => r.checkpoint).filter(Boolean));
  const verdictBefore: Verdict | null = revs.length ? revs[revs.length - 1].verdict : null;

  // 체크포인트 — 크론이 늦게 시작한 날은 지난 컷을 한 호출에 소급 판정 (문자는 마지막 것 하나만 — 폭주 방지)
  const pending = PM.checkpoints.filter((cp) => hhmmToMin(cp) + 1 <= minuteOfDay && !done.has(cp));
  for (const cp of pending) {
    const fin = judgeAt(cp);
    if (!fin) continue;
    revs = [...revs, { at: new Date().toISOString(), checkpoint: cp, verdict: fin.verdict, strength: fin.strength }];
    changed = true;
    const isLast = cp === pending[pending.length - 1];
    if (!isLast) continue;
    const isFinal = cp === PM.finalCp;
    if (fin.verdict !== verdictBefore && !(verdictBefore === null && fin.verdict === "none")) await sms(cp, verdictBefore, fin, isFinal);
    else if (isFinal && fin.verdict !== "none") await sms(cp, null, fin, true);
  }

  // 모니터링 (체크포인트 사이 변경)
  if (revs.length > 0 && minuteOfDay <= hhmmToMin(PM.finalCp)) {
    const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const fin = judgeAt(nowHHMM < PM.finalCp ? nowHHMM : PM.finalCp);
    const last = revs[revs.length - 1];
    if (fin && fin.verdict !== last.verdict) {
      revs = [...revs, { at: new Date().toISOString(), verdict: fin.verdict, strength: fin.strength }];
      changed = true;
      await sms(nowHHMM, last.verdict, fin, false);
    }
  }

  if (!changed || revs.length === 0) return result;
  const isFinal = revs.some((r) => r.checkpoint === PM.finalCp);
  const latest = revs[revs.length - 1];
  await admin.from("us_premarket_days").upsert(
    { date: today, final_verdict: latest.verdict, strength: latest.strength, stage: isFinal ? "final" : "open", revisions: revs },
    { onConflict: "date" },
  );
  result.judged = true;
  return result;
}

// ── 페이지용 로더 — 마이그레이션 029 미적용이면 null
export type UsPreDay = {
  date: string; final_verdict: string; strength: number; stage: string;
  r_oc: number | null; hit: boolean | null; pnl_stop: number | null; revisions: PreRev[] | null;
};
export async function loadUsPremarketDays(n: number): Promise<UsPreDay[] | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("us_premarket_days")
    .select("date, final_verdict, strength, stage, r_oc, hit, pnl_stop, revisions")
    .order("date", { ascending: false })
    .limit(n);
  if (error) return null;
  return (data ?? []) as never;
}
