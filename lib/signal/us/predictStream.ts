// 미장 예측 스트림 서비스 (사용자 지정 2026-07-21 "국장과 동일한 방식"·"SOXX 프락시" ·
// 2026-07-22 "사용자모델 제거 — 피셔F/M/본 3단계로 대체") — 한국 predict 체크포인트 스트림
// (lib/predict/service.ts checkpointStream, v1.13)의 미국판.
// 판정자: 조기창(프리장 08:30~09:25 + 정규장 ~11:00 ET) = 피셔F(0.05·1봉·강돌파, 07:00 창) /
//         이후(11:30~14:30) = 본피셔(0.15·2봉, 09:30 창). 사용자모델(RV1+T6)은 판정자에서 폐기.
// 3단계 비중 프로토콜 (한국 2026-07-22와 동일): 피셔F 반전 임시판정(1단계 50%) → 피셔M(0.10·2봉)
// 중간확인(2단계 +30%p, 반대면 30%p 축소 경고) → 본피셔 확정(3단계 +20%p, 누적 100%).
// 판정 지수 SOXX — 상방 = SOXL(3x) · 하방 = SOXS(-3x). 상수 근거는 config.usPredict 주석.
// 채점: 정규장 라벨(±0.9% SOXX 스케일) + 확정 판정 부호 적중 + 첫 방향 체크포인트 진입 손익.
// 저장: us_predict_days (마이그레이션 029). 트리거: /api/signal/us/state (cron-job.org).

import YahooFinance from "yahoo-finance2";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { avgRange } from "@/lib/predict/indicators";
import type { PredictDailyBar, Verdict } from "@/lib/predict/types";
import { US_SIGNAL_CONFIG } from "./config";
import { etNow } from "./data";
import {
  ET_CLOSE, ET_OPEN, ET_PRE_START, labelUsDay, pnlFromCut, runUsFisher, type UsBar,
} from "./models";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const UP = US_SIGNAL_CONFIG.usPredict;
const SY = UP.symbols;

const V_KO: Record<Verdict, string> = {
  leverage: `레버리지(${SY.leverage} ${SY.leverageX}x)`,
  inverse: `인버스(${SY.inverse} -${SY.leverageX}x)`,
  none: "추세없음",
};
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const ALL_CPS: string[] = [...UP.preCheckpoints, ...UP.regCheckpoints];

// judge: "user"는 폐기된 사용자모델의 과거 기록 호환용 (2026-07-21 이전 행)
type Judge = "user" | "fisherF" | "fisher";
type Rev = { at: string; checkpoint?: string; verdict: Verdict; strength: number; judge: Judge };
type Row = {
  date: string; final_verdict: Verdict; strength: number; stage: "open" | "final";
  revisions: Rev[] | null; label: Verdict | null; r_oc: number | null;
};

// ── 야후 5분봉 (프리·정규) — ET 변환 (DST 자동)
const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
export async function fetchJudge5m(daysBack: number): Promise<Map<string, UsBar[]>> {
  const byDay = new Map<string, UsBar[]>();
  try {
    const r = await yf.chart(SY.judge, {
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
        etMin, time: `${String(h).padStart(2, "0")}:${p.minute}`,
        open: q.open, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close,
        volume: typeof q.volume === "number" ? q.volume : 0,
      });
      byDay.set(day, arr);
    }
    for (const arr of byDay.values()) arr.sort((a, b) => a.etMin - b.etMin);
  } catch { /* 야후 실패 — 빈 맵 (호출부에서 생략) */ }
  return byDay;
}

// 판정 지수(SOXX) 일봉 — avgRange10·ATR·전일 종가용 (SMH용 data.ts fetchSmhDaily와 분리)
export async function fetchJudgeDaily(count: number): Promise<PredictDailyBar[]> {
  try {
    const r = await yf.chart(SY.judge, { period1: new Date(Date.now() - (count + 10) * 86400e3), interval: "1d" });
    return (r.quotes ?? [])
      .filter((x): x is typeof x & { close: number; open: number; high: number; low: number } =>
        x.close != null && x.open != null && x.high != null && x.low != null)
      .map((x) => {
        const p = Object.fromEntries(etFmt.formatToParts(x.date instanceof Date ? x.date : new Date(x.date)).map((y) => [y.type, y.value]));
        return { date: `${p.year}-${p.month}-${p.day}`, open: x.open, high: x.high, low: x.low, close: x.close, volume: typeof x.volume === "number" ? x.volume : 0 };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

async function loadRow(date: string): Promise<Row | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("us_predict_days")
    .select("date, final_verdict, strength, stage, revisions, label, r_oc")
    .eq("date", date)
    .maybeSingle();
  if (error) throw new Error(`us_predict_days 조회 실패(마이그레이션 029 확인): ${error.message}`);
  return (data as Row | null) ?? null;
}

// 첫 방향 체크포인트의 컷 분 (진입 가정 시점) — 모니터링 변경분은 at(ISO)에서 ET 분 환산
function firstDirCutMin(revs: Rev[]): number | null {
  for (const r of revs) {
    if (r.verdict === "none") continue;
    if (r.checkpoint) return hhmmToMin(r.checkpoint);
    const p = Object.fromEntries(etFmt.formatToParts(new Date(r.at)).map((x) => [x.type, x.value]));
    const h = p.hour === "24" ? 0 : parseInt(p.hour, 10);
    return h * 60 + parseInt(p.minute, 10);
  }
  return null;
}

// ── 서비스 본체 — /api/signal/us/state에서 호출 (실패해도 신호 흐름 무관)
export async function runUsPredictStream(): Promise<{ judged: boolean; scored: string[] }> {
  const { date: today, minuteOfDay } = etNow();
  const admin = createAdminClient();
  const result = { judged: false, scored: [] as string[] };

  // ① 미채점 백필 (정규장 마감 후 소급 — 야후 5분봉 60일 보존)
  const { data: unscored } = await admin
    .from("us_predict_days")
    .select("date, final_verdict, revisions")
    .is("labeled_at", null)
    .order("date", { ascending: true })
    .limit(8);
  const scoreable = (unscored ?? []).filter(
    (r) => String(r.date) < today || minuteOfDay >= ET_CLOSE + 5,
  );
  if (scoreable.length > 0) {
    const oldest = String(scoreable[0].date);
    const daysBack = Math.min(55, Math.ceil((Date.now() - new Date(`${oldest}T00:00:00Z`).getTime()) / 86400e3) + 3);
    const byDay = await fetchJudge5m(daysBack);
    for (const r of scoreable) {
      const d = String(r.date);
      const reg = (byDay.get(d) ?? []).filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
      if (reg.length < 60) continue; // 반일장·결손 — 다음 기회에 재시도
      const { label, rOC } = labelUsDay(reg, UP.label.trendMinPct, UP.label.posUp, UP.label.posDown);
      const fv = r.final_verdict as Verdict;
      const hit = fv === "none" ? null : (fv === "leverage" && rOC > 0) || (fv === "inverse" && rOC < 0);
      const revs = (r.revisions ?? []) as Rev[];
      const cutMin = firstDirCutMin(revs);
      const firstDir = revs.find((x) => x.verdict !== "none")?.verdict ?? "none";
      const pnl = cutMin !== null ? pnlFromCut(reg, cutMin, firstDir, UP.stopPct).pnl : 0;
      await admin
        .from("us_predict_days")
        .update({ label, r_oc: rOC, hit, pnl_stop: pnl, labeled_at: new Date().toISOString() })
        .eq("date", d);
      result.scored.push(d);
    }
  }

  // ② 라이브 스트림 — 첫 체크포인트+1분 ~ 확정+3분 (08:31~14:33 ET = KST 21:31~03:33 서머타임)
  if (minuteOfDay < hhmmToMin(ALL_CPS[0]) + 1 || minuteOfDay > hhmmToMin(UP.finalCp) + 3) return result;
  const prior = await loadRow(today);
  if (prior && prior.stage === "final") return result;

  const [byDay, daily] = await Promise.all([fetchJudge5m(3), fetchJudgeDaily(80)]);
  const bars = byDay.get(today) ?? [];
  const pre = bars.filter((b) => b.etMin >= ET_PRE_START && b.etMin < ET_OPEN);
  const reg = bars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
  const hist = daily.filter((b) => b.date < today).slice(-120);
  const range10 = avgRange(hist, 10);
  const prevClose = hist[hist.length - 1]?.close;
  if (hist.length < 30 || range10 === null || !prevClose) return result;

  // 분봉 커버리지 가드 (한국 2026-07-20 실측 규칙 이식 — 정합 감사 2026-07-23): 야후 응답이
  // 호출마다 들쭉날쭉하면 피셔 상태기계가 불가능한 전이로 진동. 정규장 예상 5분봉의 80% 미만이면
  // 이번 호출은 판정 생략 (프리장 봉은 원래 성겨서 가드 제외).
  if (minuteOfDay > ET_OPEN + 10) {
    const expectReg = Math.floor((Math.min(minuteOfDay, ET_CLOSE) - ET_OPEN) / 5);
    if (expectReg > 2 && reg.length < expectReg * 0.8) {
      console.error(`[uspredict] 분봉 커버리지 부족 (${reg.length}/${expectReg}) — 이번 호출 판정 생략`);
      return result;
    }
  }

  const judgeAt = (cut: string): { verdict: Verdict; strength: number; judge: Judge } | null => {
    const cutMin = hhmmToMin(cut);
    if (cut <= UP.earlyUntilCp) {
      // 조기창 — 피셔F (07:00 창: 프리장+정규장 연속봉)
      const w = [...pre, ...reg].filter((b) => b.etMin + 5 <= cutMin);
      if (w.length < 5) return null;
      const F = UP.fisherF;
      const out = runUsFisher(w, hist, F.offsetRangeRatio, { confirmBars: F.confirmBars, strongBreakRatio: F.strongBreakRatio });
      return { verdict: out.verdict, strength: Math.round(out.confidence * 100), judge: "fisherF" };
    }
    // 본판정 — 본피셔 (09:30 창). 강돌파는 스트림에만 적용 (한국 lateStrongBreak 0.1 대응)
    const w = reg.filter((b) => b.etMin + 5 <= cutMin);
    if (w.length < 6) return null;
    const out = runUsFisher(w, hist, UP.offsetRangeRatio, { strongBreakRatio: 0.1 });
    if (out.verdict !== "none") return { verdict: out.verdict, strength: Math.round(out.confidence * 100), judge: "fisher" };
    // 핸드오프 유예 (2026-07-22 실측 사고: 11:01 모니터링이 본피셔 '미확인'을 '방향 소멸'로
    // 오표시 → 4분 뒤 본피셔 확인으로 복귀, 문자 2건 왕복). 본피셔가 none인 것은 반전 증거가
    // 아니므로 조기창 피셔F가 방향을 유지 중이면 그 판정을 승계한다. 소멸·전환은 F 자신의
    // C철회 또는 본피셔의 반대 확인 때만 발생. (본피셔는 한번 확인하면 C반전 외엔 none으로
    // 돌아가지 않아, 이 폴백은 사실상 핸드오프~본피셔 첫 확인 사이 구간에만 작동)
    const wEarly = [...pre, ...reg].filter((b) => b.etMin + 5 <= cutMin);
    if (wEarly.length >= 5) {
      const F = UP.fisherF;
      const fb = runUsFisher(wEarly, hist, F.offsetRangeRatio, { confirmBars: F.confirmBars, strongBreakRatio: F.strongBreakRatio });
      if (fb.verdict !== "none") return { verdict: fb.verdict, strength: Math.round(fb.confidence * 100), judge: "fisherF" };
    }
    return { verdict: "none", strength: Math.round(out.confidence * 100), judge: "fisher" };
  };

  // 시각별 적중 — 라이브 슬롯(표본 20↑) 우선, 미달 시 백테스트 사전값 (한국과 동일 체계.
  // 기준은 정규장 시가→종가 부호 — 사전값과 동일 눈금)
  const slotLive = new Map<string, { c: number; t: number }>();
  try {
    const { data: past } = await admin
      .from("us_predict_days")
      .select("r_oc, revisions")
      .not("labeled_at", "is", null)
      .order("date", { ascending: false })
      .limit(90);
    for (const d of past ?? []) {
      const rOC = d.r_oc as number | null;
      if (rOC === null) continue;
      for (const r of (d.revisions ?? []) as Rev[]) {
        if (!r.checkpoint || r.verdict === "none") continue;
        const s = slotLive.get(r.checkpoint) ?? { c: 0, t: 0 };
        s.t++;
        if ((r.verdict === "leverage" && rOC > 0) || (r.verdict === "inverse" && rOC < 0)) s.c++;
        slotLive.set(r.checkpoint, s);
      }
    }
  } catch { /* 통계 실패는 발송을 막지 않는다 */ }
  const slotHitPct = (hhmm: string): number | null => {
    const slot = [...ALL_CPS].reverse().find((s) => s <= hhmm) ?? ALL_CPS[0];
    const live = slotLive.get(slot);
    if (live && live.t >= 20) return Math.round((live.c / live.t) * 100);
    return UP.checkpointPriors[slot] ?? null;
  };

  // 조용 시간 (01:00~07:00 KST) — 문자 억제·이메일만 (12:30 ET 이후 체크포인트가 해당)
  const kst = new Date(Date.now() + 9 * 3600e3);
  const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const Q = US_SIGNAL_CONFIG.quietSms;
  const quiet = kstMin >= Q.fromKstMin && kstMin < Q.toKstMin;

  // 자동매도 스탑 '금액' (한국 2026-07-21 지시의 미국판) — 판정 시점 ETF 현재가에 스탑 %를 적용한
  // 절대 가격을 문자에 동봉. 매입가 기준이면 체결가가 밀린 만큼 스탑이 위로 올라와 노이즈에 컷됨.
  // 야후 quote는 낡은 스냅샷 가드(30분) — 프리장 컷은 전일 마감가 기준이라 생략될 수 있음(정상).
  const stopEtfPct = UP.stopPct * SY.leverageX; // SOXX -2.0% → 3x ETF -6.0%
  const etfStopLine = async (verdict: Verdict): Promise<string> => {
    try {
      const sym = verdict === "leverage" ? SY.leverage : SY.inverse;
      const q = await yf.quote(sym);
      const px = typeof q.regularMarketPrice === "number" ? q.regularMarketPrice : null;
      const t = q.regularMarketTime instanceof Date ? q.regularMarketTime
        : typeof q.regularMarketTime === "number" ? new Date(q.regularMarketTime * 1000) : null;
      if (!px || !t || Date.now() - t.getTime() > 30 * 60_000) return "";
      const stop = px * (1 - stopEtfPct / 100);
      return `\n▶자동매도 스탑: ${sym} $${stop.toFixed(2)} (판정시점 $${px.toFixed(2)} -${stopEtfPct.toFixed(1)}% — 매입가 아닌 이 값에 고정)`;
    } catch { return ""; }
  };

  // 시초 레인지 폭 (09:30~09:45 ET) — 유사장 적중·광폭 경고 (한국 orBuckets 규칙의 SMH판)
  const OB = UP.orBuckets;
  const orBars = reg.slice(0, 3);
  const orWidthPct = orBars.length >= 3 && reg[0]?.open
    ? ((Math.max(...orBars.map((b) => b.high)) - Math.min(...orBars.map((b) => b.low))) / reg[0].open) * 100
    : null;
  const similarHit = orWidthPct === null ? null
    : orWidthPct >= OB.wideMinPct ? OB.hit.wide : orWidthPct >= OB.calmBelowPct ? OB.hit.mid : OB.hit.calm;
  const wideOr = orWidthPct !== null && orWidthPct >= OB.wideMinPct;

  const sms = async (whenLabel: string, prev: Verdict | null, v: { verdict: Verdict; strength: number; judge: Judge }, kind: "change" | "hold", sinceCp?: string) => {
    if (!UP.sms.enabled) return;
    const judgeKo = v.judge === "fisherF" ? "피셔F" : v.judge === "user" ? "사용자모델" : "피셔";
    const hitPct = v.verdict !== "none" ? slotHitPct(whenLabel) : null;
    // 유사장 적중은 정규장 컷에만 — 표본 있는 버킷만 표기 (한국과 동일 위치)
    const similar = v.verdict !== "none" && whenLabel >= "09:30" && similarHit !== null ? `·유사장 적중 ${similarHit}%` : "";
    const tail = `(강도 ${v.strength}%${hitPct !== null ? `·이시각 실측적중 ${hitPct}%` : ""}${similar})`;
    let text: string;
    if (kind === "hold") {
      text = `[미국예측·${judgeKo}] ${whenLabel} ET 판정 유지 확인: ${V_KO[v.verdict]} (${sinceCp}부터 유지 · 강도 ${v.strength}%${hitPct !== null ? `·이시각 실측적중 ${hitPct}%` : ""})`;
    } else {
      text = prev === null
        ? `[미국예측·${judgeKo}] ${whenLabel} ET 첫 판정: ${V_KO[v.verdict]} ${tail}`
        : `[미국예측·${judgeKo}] ${whenLabel} ET 판정 변경: ${V_KO[prev]}→${V_KO[v.verdict]} ${tail}`;
      // 방향 판정이면 자동매도 스탑 금액 동봉 (ruleReminder와 무관 — 실매매 핵심 정보, 한국 동일)
      if (v.verdict !== "none") text += await etfStopLine(v.verdict);
      // 규칙 환기 — 한국 predict와 동일 체계 (config.usPredict.sms.ruleReminder=false로 끄면 단문 복귀)
      if (UP.sms.ruleReminder) {
        if (v.verdict !== "none") {
          // 프리장 피셔F 컷 = 1/3 선진입·개장 후 본진입 (한국 v1.13 프리장 지침) / 정규장 = 3단계 본진입
          text += whenLabel < "09:30"
            ? `\n▶프리장 피셔F 신호: 개장(09:30 ET) 후 시가 부근 1/3 선진입 · 스탑 진입가 ETF -${stopEtfPct.toFixed(1)}% · 개장 후 판정 유지 확인 시 본진입. 16:00 ET 당일청산.`
            : `\n▶피셔 확인: 본진입 가능(3단계: 추가 +20%p, 누적 100%) · 스탑 ETF -${stopEtfPct.toFixed(1)}% 고정(${SY.judge} -${UP.stopPct}% — 역행=확인실패, 즉시 컷) · 16:00 ET 당일청산.`;
          text += ` 수익은 적중률(${hitPct ?? "?"}%)이 아니라 규칙에서. 미국 소표본 — 소액만.`;
        } else if (prev !== null) {
          text += `\n▶규칙: 방향 소멸 — 보유 중이면 청산 검토. 확정(14:30 ET) 반대 보유 금지.`;
        } else {
          // 첫 판정이 무추세 (한국 2026-07-22 지시 동일) — 상태 통지 + 대기 지침
          text += `\n▶방향 없음 — 진입 대기. 방향 확인 시 즉시 문자.`;
        }
        // 광폭 시초레인지 경고 — SOXX 90분위(2.7%) 초과. 유사일 표본 부족(4일)이라 수치 단정 없이
        // 비중 축소만 권장 (한국은 광폭일 적중 급락 43% 실측 — SOXX는 라이브 누적으로 확인)
        if (wideOr && v.verdict !== "none" && whenLabel >= "09:30") {
          text += `\n⚠오늘 시초레인지 ${orWidthPct!.toFixed(1)}% 광폭(90분위 초과) — 유사일 표본 부족, 비중 축소 권장.`;
        }
      }
    }
    try {
      const key = kind === "hold"
        ? `uspredict_hold_${(sinceCp ?? whenLabel).replace(":", "")}_${v.verdict}`
        : ALL_CPS.includes(whenLabel)
          ? `uspredict_cp${whenLabel.replace(":", "")}_${v.verdict}`
          : `uspredict_chg_${prev ?? "none"}_${v.verdict}`;
      // dedupHours 16: 미장 거래일이 KST 이틀에 걸쳐 생기는 어제 세션 새벽 발송과의 키 충돌 방지
      await dispatchToChannels("signal", today, {
        key, severity: kind === "hold" ? "low" : "medium", text, smsSubject: "미국 예측", suppressSms: quiet,
      }, undefined, undefined, { dedupHours: 16 });
    } catch { /* 발송 실패는 판정 기록을 막지 않는다 */ }
  };

  let revs: Rev[] = prior?.revisions ?? [];
  let changed = false;
  const done = new Set(revs.map((r) => r.checkpoint).filter(Boolean));
  const verdictBefore: Verdict | null = revs.length ? revs[revs.length - 1].verdict : null;

  // 지나간 체크포인트 소급 기록 — 문자는 마지막 컷 하나만 (콜드 스타트 폭주 방지, 한국과 다른 점)
  const pending = ALL_CPS.filter((cp) => hhmmToMin(cp) + 1 <= minuteOfDay && !done.has(cp));
  for (const cp of pending) {
    const fin = judgeAt(cp);
    if (!fin) continue;
    revs = [...revs, { at: new Date().toISOString(), checkpoint: cp, verdict: fin.verdict, strength: fin.strength, judge: fin.judge }];
    changed = true;
    if (cp !== pending[pending.length - 1]) continue;
    // 문자: 방향 등장·소멸·전환 + 첫 판정은 '추세없음'이어도 발송 (한국 2026-07-22 지시 동일 —
    // 프리장 첫 판정은 시스템 가동·상태 확인 겸 무추세도 통지). 무추세 '유지'는 계속 조용.
    if (fin.verdict !== verdictBefore) {
      await sms(cp, verdictBefore, fin, "change");
    } else if (fin.verdict === verdictBefore && fin.verdict !== "none") {
      // 유지 확인 (사용자 지정 2026-07-20 한국 체계): 동일 판정 연속 체크포인트 2개째에 1회
      let cpCount = 0;
      let sinceCp: string | null = null;
      for (let i = revs.length - 1; i >= 0 && revs[i].verdict === fin.verdict; i--) {
        if (revs[i].checkpoint) { cpCount++; sinceCp = revs[i].checkpoint!; }
      }
      if (cpCount === 2 && sinceCp) await sms(cp, null, fin, "hold", sinceCp);
    }
  }

  // 체크포인트 사이 모니터링 — 판정 변경 시 기록 + 문자
  if (revs.length > 0 && minuteOfDay <= hhmmToMin(UP.finalCp)) {
    const nowHHMM = minToHHMM(minuteOfDay);
    const fin = judgeAt(nowHHMM < UP.finalCp ? nowHHMM : UP.finalCp);
    const last = revs[revs.length - 1];
    if (fin && fin.verdict !== last.verdict) {
      revs = [...revs, { at: new Date().toISOString(), verdict: fin.verdict, strength: fin.strength, judge: fin.judge }];
      changed = true;
      await sms(nowHHMM, last.verdict, fin, "change");
    }
  }

  // 피셔F 반전 조기 경보 + 피셔M 중간확인 (한국 2026-07-22 3단계의 미국판 — 본판정 구간
  // 11:05~14:30 ET, 창은 정규장 09:30 시작). 본 판정과 다른 방향을 F가 확인하면 1단계(50%) 임시
  // 판정, M(0.10·2봉)이 동방향 재확인하면 2단계(+30%p 누적 80%), 반대면 신뢰 하락 경고(30%p 축소).
  // 본 피셔가 확정하면 스트림 판정 변경 문자가 3단계(+20%p 누적 100%)를 안내. 키는 방향별 1일 1회.
  if (minuteOfDay >= hhmmToMin("11:05") && minuteOfDay <= hhmmToMin(UP.finalCp) && revs.length > 0 && UP.sms.enabled) {
    const w = reg.filter((b) => b.etMin + 5 <= minuteOfDay);
    if (w.length >= 6) {
      const F = UP.fisherF, M = UP.fisherM;
      const rf = runUsFisher(w, hist, F.offsetRangeRatio, { confirmBars: F.confirmBars, strongBreakRatio: F.strongBreakRatio });
      const rm = runUsFisher(w, hist, M.offsetRangeRatio, { confirmBars: M.confirmBars });
      const rMainNow = runUsFisher(w, hist, UP.offsetRangeRatio, { strongBreakRatio: 0.1 });
      const curV = revs[revs.length - 1].verdict;
      // 정확도 동봉 (사용자 지시 2026-07-22 밤): 이시각 실측적중(슬롯 실측 — 라이브 20회↑ 우선,
      // 미달 시 백테스트 사전값) + 유사장 적중(시초레인지 폭 유사형태 버킷) — 판정 문자와 동일 눈금
      const nowH = minToHHMM(minuteOfDay);
      const slotPct = slotHitPct(nowH);
      const statTail = `(이시각 실측적중 ${slotPct ?? "?"}%${similarHit !== null ? `·유사장 적중 ${similarHit}%` : ""})`;
      // 비중 사다리 2단계 (2026-07-22 사용자 지적 — 동방향 M 확인도 통지): 현 판정이 조기창
      // 피셔F 단계(본피셔 미확인)일 때 M이 같은 방향을 확인하면 +30%p 확대 신호. 반전 케이스와
      // 같은 키(방향별 1일 1회) — 본피셔가 이미 확인한 뒤에는 3단계라 불필요.
      if (rm.verdict !== "none" && rm.verdict === curV && rMainNow.verdict === "none") {
        try {
          await dispatchToChannels("signal", today, {
            key: `uspredict_fm_${rm.verdict}`,
            severity: "medium",
            text: `[미국예측·피셔M 중간확인] ${V_KO[rm.verdict]} 재확인 — ${rm.reason.split(" — ")[0]} ${statTail}. 현 판정(피셔F) 신뢰↑(SOXX 실측: M확인 시 F 적중 97%·미확인 50%). ▶2단계: 투자 비중 +30%p(누적 80%) 검토·스탑 ETF -${stopEtfPct.toFixed(1)}%. 확정(3단계 +20%p)은 본 피셔. 무응답=현행 유지${await etfStopLine(rm.verdict)}`,
            smsSubject: "미국 조기경보", suppressSms: quiet,
          }, undefined, undefined, { dedupHours: 16 });
        } catch { /* 발송 실패 무시 */ }
      }
      if (rf.verdict !== "none" && rf.verdict !== curV) {
        try {
          await dispatchToChannels("signal", today, {
            key: `uspredict_ff_${rf.verdict}`, // 방향별 하루 1회 — 키에 분 금지 (2026-07-20 폭주 사고 원칙)
            severity: "medium",
            text: `[미국예측·피셔F 임시판정] 조기 반전 감지: ${V_KO[rf.verdict]} — ${rf.reason.split(" — ")[0]} ${statTail}. 본 판정(피셔)은 아직 ${V_KO[curV]} — 임시(저문턱)라 오발 잦음. ▶1단계: 계획 비중 50% 진입 검토·스탑 ETF -${stopEtfPct.toFixed(1)}%. 피셔M 중간확인 대기. 무응답=현행 유지${await etfStopLine(rf.verdict)}`,
            smsSubject: "미국 조기경보", suppressSms: quiet,
          }, undefined, undefined, { dedupHours: 16 });
        } catch { /* 발송 실패 무시 */ }
        if (rm.verdict !== "none" && rm.verdict !== curV && rm.verdict === rf.verdict) {
          try {
            await dispatchToChannels("signal", today, {
              key: `uspredict_fm_${rm.verdict}`,
              severity: "medium",
              text: `[미국예측·피셔M 중간확인] ${V_KO[rm.verdict]} 재확인 — ${rm.reason.split(" — ")[0]} ${statTail}. 피셔F 신뢰↑(SOXX 실측: M확인 시 F 적중 97%·미확인 50%). ▶2단계: 투자 비중 +30%p(누적 80%) 검토·스탑 ETF -${stopEtfPct.toFixed(1)}%. 확정(3단계 +20%p)은 본 피셔. 무응답=현행 유지${await etfStopLine(rm.verdict)}`,
              smsSubject: "미국 조기경보", suppressSms: quiet,
            }, undefined, undefined, { dedupHours: 16 });
          } catch { /* 발송 실패 무시 */ }
        }
        if (rm.verdict !== "none" && rm.verdict !== rf.verdict) {
          try {
            await dispatchToChannels("signal", today, {
              key: `uspredict_fmopp_${rm.verdict}`,
              severity: "medium",
              text: `[미국예측·피셔M 경고] 피셔F(${V_KO[rf.verdict]})와 반대 방향 ${V_KO[rm.verdict]} 확인 — 피셔F 신뢰 하락 ${statTail}. ▶F 선진입분 30%p 축소(잔여 20%)·잔여분 스탑 ETF -${stopEtfPct.toFixed(1)}% 유지, 본 피셔 확정 대기(M과 같은 반대 확정 시 잔여도 청산). 무응답=현행 유지`,
              smsSubject: "미국 조기경보", suppressSms: quiet,
            }, undefined, undefined, { dedupHours: 16 });
          } catch { /* 발송 실패 무시 */ }
        }
      }
    }
  }

  if (!changed || revs.length === 0) return result;
  const isFinal = revs.some((r) => r.checkpoint === UP.finalCp);
  const latest = revs[revs.length - 1];
  await admin.from("us_predict_days").upsert(
    { date: today, final_verdict: latest.verdict, strength: latest.strength, stage: isFinal ? "final" : "open", revisions: revs },
    { onConflict: "date" },
  );
  result.judged = true;
  return result;
}

// ── 페이지용 로더 — 마이그레이션 029 미적용이면 null
export type UsPredictDay = {
  date: string; final_verdict: string; strength: number; stage: string;
  label: string | null; r_oc: number | null; hit: boolean | null; pnl_stop: number | null; revisions: Rev[] | null;
};
export async function loadUsPredictDays(n: number): Promise<UsPredictDay[] | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("us_predict_days")
    .select("date, final_verdict, strength, stage, label, r_oc, hit, pnl_stop, revisions")
    .order("date", { ascending: false })
    .limit(n);
  if (error) return null;
  return (data ?? []) as never;
}
