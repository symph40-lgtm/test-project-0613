// 운영 서비스 — 호출 시점 기준으로 알아서 처리 (스펙 5장):
//   ① 과거 미판정일 백필(최근 10거래일) ② 과거·당일 미채점일 채점 ③ 당일 10:30 경과 시 판정.
// KIS 과거 분봉으로 언제든 소급 가능 — 크론이 며칠 죽어도 다음 호출에서 복구된다.

import { PREDICT_CONFIG } from "./config";
import { atrPct, avgRange, isHighVolDay } from "./indicators";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { fetchDayMinutes, fetchTodayMinutes, fetchNxtPremarket, clipToJudgeWindow } from "./kisMinute";
import { labelDay } from "./label";
import { runAllModels } from "./runner";
import { runFisher } from "./models/fisher";
import { finalizeJudgment, runEnsemble } from "./ensemble";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { loadMacroHistory } from "./macro";
import { runAfterService } from "./after";
import { runSectorService } from "./sector";
import { loadTrackPerf, runTrackService } from "./track";
import {
  countAlertKey, hasJudgment, hasModelRows, lastAlertDateLike, listUnscoredDates, loadAccuracyStats,
  loadAfterPerf, loadDayRow, loadLiveModelPerf, loadRecentDays, loadRescueStats, loadSectorPerf,
  loadSsState, saveJudgment, saveSsState, scoreDay, upsertCheckpointDay, type Revision,
} from "./store";
import { MODEL_LABELS } from "./types";
import type { MinuteBar, PredictDailyBar, Verdict } from "./types";

const STREAM_MIN = 8 * 60 + 31; // 08:31부터 체크포인트 스트림 (첫 판정 08:30 완성봉 기준)
const JUDGE_MIN = 14 * 60 + 1; // 14:01 확정 — 모델별 스냅샷(대조군 채점) 기록 (v1.4: 창 09:00~13:59)
const SCORE_MIN = 15 * 60 + 35; // 15:35부터 당일 채점

const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

// 시초레인지(첫 15봉) 경계 이탈 횟수 — 무추세 확인 문자의 정보 라벨용 (2026-07-29 승인,
// scripts/intraday-regime-sweep.ts: 3종목 단조 일관 유일 지표 — 이탈 적은 날 남은 장 기대 낮음).
function countOrCross(reg: { close: number; high: number; low: number }[]): number | null {
  if (reg.length < 20) return null;
  const orH = Math.max(...reg.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...reg.slice(0, 15).map((b) => b.low));
  let cross = 0;
  let zone: -1 | 0 | 1 = 0;
  for (const b of reg.slice(15)) {
    const z: -1 | 0 | 1 = b.close > orH ? 1 : b.close < orL ? -1 : 0;
    if (z !== zone && z !== 0) cross++;
    zone = z;
  }
  return cross;
}
const V_KO: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };

// 체크포인트 스트림 문자 폐기 (2026-07-23 사용자 확정: 사용자모델·체크포인트 문자 중단) —
// 방향 통지는 ②b 통합 피셔 전이 모니터(삼전·하닉 동일 사슬)가 전담. 판정 기록·채점·성능/청산/애프터
// 문자는 그대로 유지. 스트림 문자를 되살리려면 true로.
const STREAM_SMS = false;

async function judgeOneDay(
  date: string,
  complete: PredictDailyBar[], // date 이전의 완결 일봉들 (오래된→최신)
  openPx: number,
  source: "live" | "backfill",
  isToday: boolean,
): Promise<boolean> {
  const code = PREDICT_CONFIG.symbol;
  const ymd = date.replace(/-/g, "");
  let dayMin = await fetchDayMinutes(code, ymd, PREDICT_CONFIG.judgeHour);
  if ((!dayMin || dayMin.length < 60) && isToday) {
    dayMin = await fetchTodayMinutes(code, PREDICT_CONFIG.judgeHour);
  }
  if (!dayMin || dayMin.length < 60) return false;
  // 당일 확정(모델 스냅샷)도 커버리지 가드 — 부족하면 다음 크론에서 재시도 (2026-07-20)
  if (isToday && dayMin.length < 300 * 0.8) return false;
  const morning = clipToJudgeWindow(dayMin, PREDICT_CONFIG.judgeHour);
  const prevDate = complete[complete.length - 1]?.date;
  const prevDayMinutes = prevDate ? await fetchDayMinutes(code, prevDate.replace(/-/g, ""), "153000") : null;
  let macro = null;
  try {
    macro = (await loadMacroHistory())(date); // M7 근사 축1 — 실패해도 판정은 진행
  } catch { /* 야후 장애 — 축1 중립 처리 */ }
  const outputs = runAllModels({
    date,
    dailyHistory: complete.slice(-120),
    openPx,
    morning,
    prevDayMinutes,
    macro,
  });
  const acc = await loadAccuracyStats();
  const ens = runEnsemble(outputs, acc);
  const final = finalizeJudgment(outputs, ens); // 피셔 단독 모드 — 앙상블은 참고 기록
  await saveJudgment(date, outputs, final, ens, source);
  return true;
}

export type PredictRunResult = {
  date: string;
  judgedToday: boolean;
  earlyToday: boolean; // 조기 판정/모니터링 갱신 수행 여부
  backfilled: string[];
  scored: string[];
};

// 체크포인트 판정 스트림 (사용자 지정 2026-07-16): 08:30 첫 판정 → 30분마다 → 14:00 확정.
// 지나간 미기록 체크포인트는 과거 분봉으로 소급 기록 (크론이 띄엄띄엄 와도 타임라인 완성).
// 사이 구간(라이브 호출)은 모니터링 — 직전 기록과 판정이 다르면 변경 엔트리 + 문자.
// 판정자: 09:30 전 = user(RV1+T6, 프리마켓 유일 유효 신호) / 이후 = 피셔.
// 창: 10:30 전 = 08:00(NXT) 시작 / 이후 = 09:00 시작 (220일 실측 최적 조합).
async function checkpointStream(
  today: string,
  complete: PredictDailyBar[],
  minuteOfDay: number,
): Promise<boolean> {
  const cfg = PREDICT_CONFIG.schedule;
  const prior = await loadDayRow(today);
  if (prior && prior.stage === "final") return false;
  const code = PREDICT_CONFIG.symbol;
  const ymd = today.replace(/-/g, "");
  // 분봉은 15:30까지 (2026-07-27 실사고: judgeHour(14:00) 캡 때문에 7/25 승인된 모니터 창 연장
  // (14:00→15:25)이 동작 불능 — 14:00 이후 새 분봉이 없어 하닉 14:17 트레일 반전이 침묵했다).
  const [pre, krxRaw] = await Promise.all([
    fetchNxtPremarket(code, ymd),
    fetchDayMinutes(code, ymd, "153000").then(
      (bars) => bars ?? fetchTodayMinutes(code, "153000"),
    ),
  ]);
  const krx = krxRaw ?? [];
  // 데이터 커버리지 가드 (2026-07-20 실측: 장중 분봉 응답이 호출마다 들쭉날쭉 → 피셔 상태기계가
  // 불가능한 전이(레버리지→없음)로 진동). 정규장 예상 분봉의 80% 미만이면 이번 호출은 판정 생략.
  const expectKrx = Math.min(minuteOfDay, hhmmToMin("15:30")) - 9 * 60 - 1;
  if (expectKrx > 10 && krx.length < expectKrx * 0.8) {
    console.error(`[predict] 분봉 커버리지 부족 (${krx.length}/${expectKrx}) — 이번 호출 판정 생략`);
    return false;
  }
  // NXT 프리장 커버리지 가드 (2026-07-27 실사고: 10:14 호출만 프리장 응답 결손 → 08연속창 F·M이
  // 09창 앵커로 재계산돼 '인버스 소멸' 오발송, 직후 재확인은 1일 1회 키에 막혀 침묵). 정규장
  // 진입 후엔 프리장(08:00~08:50, 평시 ~50봉)이 과거 데이터라 결손 = 조회 장애 — 이번 호출 생략.
  if (minuteOfDay >= 9 * 60 + 5 && krx.length > 10 && (pre?.length ?? 0) < 40) {
    console.error(`[predict] NXT 프리장 커버리지 부족 (${pre?.length ?? 0}봉) — 이번 호출 판정 생략`);
    return false;
  }
  const acc = await loadAccuracyStats();

  // 하닉 트레일 반전 — 전일(全日) 적용 (사용자 승인 2026-07-28 밤, scripts/pullback-sweep.ts 227일:
  // 고변동일 한정 +88.2 → 전일 +98.9%p·전/후반 모두 개선·최악일 동일. 비용: 전환 132→290회 —
  // 열화 시 isHighVolDay(complete) 게이트 복원). 삼전은 전일 확대 전 변형 열위로 고변동일 유지.
  const hxTrailOpts = { trailRangeRatio: PREDICT_CONFIG.hxTrail.rangeRatio, trailConfirmMinutes: PREDICT_CONFIG.hxTrail.confirmMinutes };

  const judgeAt = (cutHHMM: string): { verdict: Verdict; strength: number } | null => {
    const usePre = cutHHMM < cfg.preWindowBefore;
    const bars = [...(usePre ? pre ?? [] : []), ...krx].filter((b) => b.time < cutHHMM);
    if (bars.length < 10) return null;
    const openPx = usePre ? pre?.[0]?.open ?? bars[0].open : krx[0]?.open ?? bars[0].open;
    const input = {
      date: today,
      dailyHistory: complete.slice(-120),
      openPx,
      morning: bars,
      prevDayMinutes: null, // 스트림 단계는 달튼 VA 생략 (확정 모델 스냅샷에서 반영)
    };
    const outputs = runAllModels(input);
    // 조기 구간(09:30~10:30 포함) 피셔는 저문턱 상수(0.05·4봉) 적용 — 사용자 승인 2026-07-21
    if (cutHHMM >= cfg.earlyModelBefore && cutHHMM <= PREDICT_CONFIG.earlyOffsetUntil) {
      const early = runFisher(input, {
        offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio,
        confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes,
        strongBreakRatio: PREDICT_CONFIG.earlyStrongBreakRatio, // 강돌파 즉시확인 (2026-07-22)
        reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, // F·M도 반전 3봉 (사용자 승인 2026-07-25 2차)
        confirmFromHHMM: PREDICT_CONFIG.confirmFromKr, // 프리장 확인 금지 (사용자 지시 2026-08-01)
      });
      const i = outputs.findIndex((o) => o.model === "fisher");
      if (i >= 0) outputs[i] = early;
    } else if (cutHHMM > PREDICT_CONFIG.earlyOffsetUntil) {
      // 본판정 구간도 강돌파 즉시확인 (2026-07-22, 스트림 전용) — 스파이크형 급변 시 8봉 대기 생략
      // + C반전 3봉 (사용자 승인 2026-07-25, 스트림 전용 — config.streamReversalMinutes 근거 참조)
      const late = runFisher(input, { strongBreakRatio: PREDICT_CONFIG.lateStrongBreakRatio, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, confirmFromHHMM: PREDICT_CONFIG.confirmFromKr, ...hxTrailOpts });
      const i = outputs.findIndex((o) => o.model === "fisher");
      if (i >= 0) outputs[i] = late;
    }
    const primary = cutHHMM < cfg.earlyModelBefore ? ("user" as const) : undefined;
    const fin = finalizeJudgment(outputs, runEnsemble(outputs, acc), primary);
    // 핸드오프 유예 (사용자 지시 2026-07-23 — 미장 7/22 실측 사고의 국장판): 조기창(≤10:30)
    // 피셔F가 확인한 방향을 본판정 구간에서 본피셔가 아직 미확인(none)이라는 이유로 '방향
    // 소멸'로 뒤집지 않는다. 본피셔 none이면 피셔F(0.05·4봉·강돌파)를 재평가해 방향 유지 중이면
    // 승계 — 소멸·전환은 F의 C철회 또는 본피셔의 반대 확인 때만. 본피셔는 한번 확인하면 C반전
    // 외엔 none으로 안 돌아가므로 이 폴백은 핸드오프~본피셔 첫 확인 사이에만 작동한다.
    if (fin.finalVerdict === "none" && cutHHMM > PREDICT_CONFIG.earlyOffsetUntil) {
      const fb = runFisher(input, {
        offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio,
        confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes,
        strongBreakRatio: PREDICT_CONFIG.earlyStrongBreakRatio,
        reversalMinutes: PREDICT_CONFIG.streamReversalMinutes,
        confirmFromHHMM: PREDICT_CONFIG.confirmFromKr, // 프리장 확인 금지 (사용자 지시 2026-08-01)
      });
      if (fb.verdict !== "none") return { verdict: fb.verdict, strength: Number((fb.confidence * 100).toFixed(0)) };
    }
    return { verdict: fin.finalVerdict, strength: fin.strengthPct };
  };

  // 오늘의 ATR 스탑 (조기 신호용, ETF 기준 %) — 문자에 계산값으로 동봉 (사용자 요청 2026-07-20)
  const sw = PREDICT_CONFIG.stops.earlySwing;
  const atrToday = atrPct(complete, 14);
  const atrStopEtf = atrToday !== null ? 2 * Math.min(sw.maxPct, Math.max(sw.minPct, sw.k * atrToday)) : null;

  // 시초 레인지 폭 (09:00~09:15) — 유사 사례 기준 피셔 적중률·광폭 경고 (사용자 지정 2026-07-20)
  const OB = PREDICT_CONFIG.orBuckets;
  const orBars = krx.slice(0, 15);
  const orWidthPct = orBars.length >= 15 && krx[0]?.open
    ? ((Math.max(...orBars.map((b) => b.high)) - Math.min(...orBars.map((b) => b.low))) / krx[0].open) * 100
    : null;
  const similarHit = orWidthPct === null ? null : orWidthPct >= OB.wideMinPct ? OB.hit.wide : orWidthPct >= 2 ? OB.hit.mid : OB.hit.calm;
  const wideOr = orWidthPct !== null && orWidthPct >= OB.wideMinPct;

  // 시각별 실측 적중률 (사용자 지정 2026-07-20: "그 시각의 판정은 그 시각의 적중률로 채점").
  // 라이브: 최근 채점일들의 타임라인에서 해당 슬롯 방향 판정 적중률 (표본 20회↑일 때 채택).
  // 미달 시: 220일 백테스트 사전값(config.checkpointPriors).
  const slotLive = new Map<string, { c: number; t: number }>();
  try {
    for (const d of await loadRecentDays(90)) {
      if (!d.label || !d.revisions) continue;
      for (const r of d.revisions) {
        if (!r.checkpoint || r.verdict === "none") continue;
        const s = slotLive.get(r.checkpoint) ?? { c: 0, t: 0 };
        s.t++;
        if (r.verdict === d.label) s.c++;
        slotLive.set(r.checkpoint, s);
      }
    }
  } catch { /* 통계 실패는 발송을 막지 않는다 */ }
  const slotHitPct = (hhmm: string): number | null => {
    // 체크포인트가 아니면 직전 슬롯 기준
    const slots = cfg.checkpoints as readonly string[];
    const slot = [...slots].reverse().find((s) => s <= hhmm) ?? slots[0];
    const live = slotLive.get(slot);
    if (live && live.t >= 20) return Math.round((live.c / live.t) * 100);
    return PREDICT_CONFIG.checkpointPriors[slot] ?? null;
  };

  // 자동매도 스탑 '금액' (사용자 지시 2026-07-21): 판정 시점 ETF 현재가에 스탑 %를 적용한
  // 절대 가격을 문자에 동봉 — 매입가 -3%로 걸면 체결가가 밀린 만큼 스탑이 위로 올라와
  // 저점 노이즈에 컷된다(7/21 실측). 소스는 네이버 일봉 마지막 봉(장중엔 현재가) — 오늘
  // 날짜가 아니면(개장 전·휴장) 잘못된 앵커라 생략. ETF 호가단위 5원 내림.
  const etfStopLine = async (verdict: Verdict, etfPct: number): Promise<string> => {
    try {
      const p = verdict === "leverage" ? PREDICT_CONFIG.etf.leverage : PREDICT_CONFIG.etf.inverse;
      const bars = await fetchDailyPredict(p.code, 2);
      const last = bars[bars.length - 1];
      if (!last || last.date !== today || !(last.close > 0)) return "";
      const stop = Math.floor((last.close * (1 - etfPct / 100)) / 5) * 5;
      return `\n▶자동매도 스탑: ${p.name} ${stop.toLocaleString()}원 (판정시점 ${last.close.toLocaleString()}원 -${etfPct.toFixed(1)}% — 매입가 아닌 이 값에 고정)`;
    } catch { return ""; }
  };

  // 삼전 병기 스냅샷 (사용자 지시 2026-07-23): 피셔 단계 문자에 삼전·하닉 동시 상태 동봉 —
  // 삼전도 동일 규칙(F 0.05·4 / M 0.10·8 / 본 0.15·8+강돌파, 09:00 정규장창)으로 판정. 실패 시 병기 생략.
  const ssLab = (v: Verdict) => (v === "leverage" ? "레버" : v === "inverse" ? "인버" : "없음");
  let ssTail = ""; // "\n삼전: F레버·M없음·본없음 270,250원"
  let ssPxStr = ""; // 병기 가격 부분 — 소멸 불변식 가드 후 ssTail 재조립용 (2026-07-27)
  let ssF: Verdict = "none", ssM: Verdict = "none", ssB: Verdict = "none";
  let ssFReason = "", ssMReason = "", ssBReason = "";
  let ssFc = 50, ssMc = 50, ssBc = 50; // 강도(신뢰도×100) — 전이 문자 동봉용 (2026-07-25)
  let ssRegBars: MinuteBar[] | null = null; // 09창 반전 경보용 (2026-07-25)
  let ssContBars: MinuteBar[] | null = null; // 08 연속창 — 효율 소진 경고용 (2026-07-26)
  let ssHistBars: PredictDailyBar[] = [];
  try {
    if (minuteOfDay >= hhmmToMin("08:25")) {
      const nowHHMMs = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
      const ssDaily = await fetchDailyPredict("005930", 140);
      const ssHist = ssDaily.filter((b) => b.date < today);
      const ssPre = await fetchNxtPremarket("005930", ymd); // 프리장부터 (하닉과 동일 창 규칙)
      const ssMin = (await fetchDayMinutes("005930", ymd, "153000")) ?? (await fetchTodayMinutes("005930", "153000")); // 15:30 캡 — 하닉과 동일 (2026-07-27)
      const ssReg = (ssMin ?? []).filter((b) => b.time < nowHHMMs);
      const ssCont = [...(ssPre ?? []), ...ssReg]; // F·M = 08:00 연속창, 본 = 09:00 정규장창
      if (ssCont.length >= 20 && ssHist.length >= 11) {
        const inCont = { date: today, dailyHistory: ssHist, openPx: ssCont[0].open, morning: ssCont, prevDayMinutes: null };
        // 삼전 강돌파 0.075 (사용자 승인 2026-07-25 — config.ssStrongBreakRatio 근거 참조, 하닉과 분리)
        // 장초반 크기 ×3 (사용자 승인 2026-07-29 — config.earlyVol, F 전용·M 적용은 실측 기각)
        const f = runFisher(inCont, { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes, strongBreakRatio: PREDICT_CONFIG.ssStrongBreakRatio, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, earlyVolMult: PREDICT_CONFIG.earlyVol.mult, earlyVolUntil: PREDICT_CONFIG.earlyVol.until, confirmFromHHMM: PREDICT_CONFIG.confirmFromKr });
        const m = runFisher(inCont, { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, earlyVolMult: PREDICT_CONFIG.earlyVol.mMult, earlyVolUntil: PREDICT_CONFIG.earlyVol.until, confirmFromHHMM: PREDICT_CONFIG.confirmFromKr });
        // 삼전 고변동일 트레일 반전 (사용자 승인 2026-07-27 — config.ssTrail 근거 참조, 문턱 0.3 분리)
        const ssTrailOpts = isHighVolDay(ssHist)
          ? { trailRangeRatio: PREDICT_CONFIG.ssTrail.rangeRatio, trailConfirmMinutes: PREDICT_CONFIG.ssTrail.confirmMinutes }
          : {};
        const b = ssReg.length >= 20
          ? runFisher({ date: today, dailyHistory: ssHist, openPx: ssReg[0].open, morning: ssReg, prevDayMinutes: null }, { strongBreakRatio: PREDICT_CONFIG.ssStrongBreakRatio, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, ...ssTrailOpts })
          : { model: "fisher" as const, verdict: "none" as Verdict, confidence: 0.3, reason: "정규장 창 미형성" };
        ssF = f.verdict; ssM = m.verdict; ssB = b.verdict;
        ssFReason = f.reason; ssMReason = m.reason; ssBReason = b.reason;
        ssFc = Math.round(f.confidence * 100); ssMc = Math.round(m.confidence * 100); ssBc = Math.round(b.confidence * 100);
        ssRegBars = ssReg.length >= 20 ? ssReg : null;
        ssContBars = ssCont;
        ssHistBars = ssHist;
        const ssPxBar = ssReg.length ? ssReg[ssReg.length - 1] : ssCont[ssCont.length - 1];
        ssPxStr = ` ${ssPxBar.close.toLocaleString()}원`;
        ssTail = `\n삼전: F${ssLab(ssF)}·M${ssLab(ssM)}·본${ssLab(ssB)}${ssPxStr}`;
      }
    }
  } catch { /* 삼전 스냅샷 실패 — 병기 생략 */ }

  const smsChange = async (whenLabel: string, prev: Verdict | null, next: { verdict: Verdict; strength: number }) => {
    if (!STREAM_SMS || !PREDICT_CONFIG.sms.enabled) return;
    const judge = whenLabel < cfg.earlyModelBefore ? "user" : PREDICT_CONFIG.primaryModel;
    const judgeKo = judge === "user" ? "사용자모델" : "피셔"; // 어떤 모델의 판정인지 명시 (사용자 요청 2026-07-20)
    const hitPct = next.verdict !== "none" ? slotHitPct(whenLabel) : null;
    const similar = next.verdict !== "none" && similarHit !== null && whenLabel >= cfg.earlyModelBefore
      ? `·비슷한 장세 과거적중 ${similarHit}%` : "";
    const tail = `(강도 ${Math.round(next.strength)}%${hitPct !== null ? `·이 시각대 과거적중 ${hitPct}%` : ""}${similar})`;
    let text = prev === null
      ? `[예측·${judgeKo}] ${whenLabel} 첫 판정: ${V_KO[next.verdict]} ${tail}`
      : `[예측·${judgeKo}] ${whenLabel} 판정 변경: ${V_KO[prev]}→${V_KO[next.verdict]} ${tail}`;
    // 방향 판정이면 자동매도 스탑 금액 동봉 (ruleReminder와 무관 — 실매매 핵심 정보)
    if (next.verdict !== "none") {
      const pct = judge === "user" ? atrStopEtf : PREDICT_CONFIG.stops.fisher.hxEtfPct; // 스트림 = 하닉
      if (pct !== null) text += await etfStopLine(next.verdict, pct);
    }
    // 규칙 환기 (사용자 지정 2026-07-17 "당분간") — 수익은 적중률이 아니라 규칙에서.
    // 장문(LMS) 전환을 감수하고 동봉. config.sms.ruleReminder=false로 끄면 단문 복귀.
    if (PREDICT_CONFIG.sms.ruleReminder) {
      if (next.verdict !== "none") {
        // 신호 유형별 지침 — 프리장(≤09:00) 피셔F는 ETF 미개장이라 09:00 시가 1/3 선진입,
        // 정규장 피셔는 본진입. 스탑은 하닉 ETF 기준 (v1.13 — 프리장도 피셔 판정자, 2026-07-28 폭 분리)
        const hxSp = PREDICT_CONFIG.stops.fisher.hxEtfPct;
        text += whenLabel <= "09:00"
          ? `\n▶프리장 피셔 신호: ETF 개장(09:00) 후 시가 부근 1/3 선진입 · 스탑 진입가 ETF -${hxSp}% · 09:30 판정 유지 확인 후 본진입. 당일청산.`
          : `\n▶피셔 확인: 본진입 가능(3단계: 추가 +20%p, 누적 100%) · 스탑 ETF -${hxSp}% 고정(역행=확인실패, 즉시 컷) · 당일청산.`;
        text += ` 수익은 적중률(${hitPct ?? "?"}%)이 아니라 규칙에서.`;
      } else if (prev !== null) {
        text += `\n▶규칙: 방향 소멸 — 보유 중이면 청산 검토. 확정(14:00) 반대 보유 금지.`;
      } else {
        // 첫 판정이 무추세 (사용자 지시 2026-07-22) — 상태 통지 + 대기 지침
        text += `\n▶방향 없음 — 진입 대기. 방향 확인 시 즉시 문자.`;
      }
      // 광폭 레인지 저신뢰 경고 (OR ≥4%, 220일 중 11일 유형 — 피셔 적중 43%로 하락)
      if (wideOr && next.verdict !== "none") {
        text += `\n⚠오늘 시초레인지 ${orWidthPct!.toFixed(1)}% 광폭 — 유사일 피셔 적중 ${OB.hit.wide}%(평소 ${OB.hit.calm}~${OB.hit.mid}%). 비중 축소 권장.`;
      }
    }
    if (ssTail) text += ssTail; // 삼전 병기 (2026-07-23)
    try {
      // 키에 분(minute)을 넣지 않는다 — 2026-07-20 실측 사고: 상태 저장 실패 시 매 크론마다
      // 같은 판정이 분 단위 새 키로 재발송돼 2분 간격 문자 폭주. 체크포인트는 slot 키,
      // 모니터링 변경은 '이전→다음' 전환 키로 하루 1회 고정.
      const isCheckpoint = (PREDICT_CONFIG.schedule.checkpoints as readonly string[]).includes(whenLabel);
      const key = isCheckpoint
        ? `predict_cp${whenLabel.replace(":", "")}_${next.verdict}`
        : `predict_chg_${prev ?? "none"}_${next.verdict}`;
      await dispatchToChannels("signal", today, { key, severity: "medium", text, smsSubject: "예측 판정" });
    } catch { /* 발송 실패는 판정 기록을 막지 않는다 */ }
  };

  let revs: Revision[] = prior?.revisions ?? [];
  let changed = false;
  const done = new Set(revs.map((r) => r.checkpoint).filter(Boolean));
  const lastCp = cfg.checkpoints[cfg.checkpoints.length - 1];

  // 유지 확인 문자 (사용자 지정 2026-07-20): 같은 방향 판정이 체크포인트 2개 연속 유지되면
  // 1회만 확인 발송 — "바뀔 때 + 유지 확인 한 번" 체계.
  const smsHold = async (cp: string, verdict: Verdict, strength: number, sinceCp: string) => {
    if (!STREAM_SMS || !PREDICT_CONFIG.sms.enabled) return;
    const judgeKo = cp < cfg.earlyModelBefore ? "사용자모델" : "피셔";
    const hitPct = slotHitPct(cp);
    try {
      await dispatchToChannels("signal", today, {
        key: `predict_hold_${sinceCp.replace(":", "")}_${verdict}`,
        severity: "low",
        text: `[예측·${judgeKo}] ${cp} 판정 유지 확인: ${V_KO[verdict]} (${sinceCp}부터 유지 · 강도 ${Math.round(strength)}%·이 시각대 과거적중 ${hitPct ?? "?"}%)`,
        smsSubject: "예측 판정",
      });
    } catch { /* 발송 실패 무시 */ }
  };

  // ① 지나간 체크포인트 소급 기록 (완성봉 보장: 체크포인트 +1분 경과분만)
  for (const cp of cfg.checkpoints) {
    if (hhmmToMin(cp) + 1 > minuteOfDay || done.has(cp)) continue;
    const fin = judgeAt(cp);
    if (!fin) continue;
    const prev = revs.length ? revs[revs.length - 1].verdict : null;
    revs = [...revs, { at: new Date().toISOString(), checkpoint: cp, verdict: fin.verdict, strength: fin.strength }];
    changed = true;
    // 문자: 방향 등장·소멸·전환 + 첫 판정은 '추세없음'이어도 발송 (사용자 지시 2026-07-22 —
    // 아침 첫 판정은 시스템 가동·상태 확인 겸 무추세도 통지). 무추세 '유지'는 계속 조용.
    if (fin.verdict !== prev) {
      await smsChange(cp, prev, fin);
    } else if (fin.verdict === prev && fin.verdict !== "none") {
      // 방향 유지 — 끊김 없이 이어진 동일 판정 중 체크포인트가 정확히 2개째일 때 1회 확인
      let cpCount = 0;
      let sinceCp: string | null = null;
      for (let i = revs.length - 1; i >= 0 && revs[i].verdict === fin.verdict; i--) {
        if (revs[i].checkpoint) { cpCount++; sinceCp = revs[i].checkpoint!; }
      }
      if (cpCount === 2 && sinceCp) await smsHold(cp, fin.verdict, fin.strength, sinceCp);
    }
  }

  // ② 체크포인트 사이 모니터링 — 현재 완성봉 기준 판정이 직전 기록과 다르면 변경 기록
  if (minuteOfDay > hhmmToMin(cfg.checkpoints[0]) && minuteOfDay <= hhmmToMin(lastCp) && revs.length > 0) {
    const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const fin = judgeAt(nowHHMM < lastCp ? nowHHMM : lastCp);
    const last = revs[revs.length - 1];
    if (fin && fin.verdict !== last.verdict) {
      revs = [...revs, { at: new Date().toISOString(), verdict: fin.verdict, strength: fin.strength }];
      changed = true;
      await smsChange(nowHHMM, last.verdict, fin);
    }
  }

  // ②b 통합 피셔 전이 모니터 (2026-07-23 사용자 확정: 하닉 기존 문자 방식 폐기 — 삼전·하닉 동일 사슬).
  // 두 종목 모두 F(0.05·4봉)/M(0.10·8봉)/본(0.15·8봉+강돌파)을 같은 규칙으로 감시.
  // 창: F·M = 08:00 연속창(NXT 프리장 포함 — "프리장부터"), 본 = 09:00 정규장창 (nowcast 관례와 동일).
  // 상수는 하닉 220일+224일 실측 검증분 — 오프셋이 각 종목 10일 평균폭에 비례라 변동폭은 종목별 자동 적응.
  // 문자: 등장·전환·소멸 모든 전이 통지(전이 키 — 같은 전이 1일 1회), 어느 트리거든 두 종목 상태 병기.
  // 판정 기록·채점·성능/청산/애프터 문자는 기존 스트림 유지 — 방향 통지 층만 이 모니터로 일원화.
  // 모니터 창 연장 14:00 → 15:25 (사용자 지시 2026-07-25: 확정 후에도 상황이 바뀌면 —
  // 인버스→추세없음→레버리지 — 계속 판정·통지. 7/24 삼전 13:05 반등 인버스 유지 실사고).
  // 애프터장(15:30~20:00)은 하닉 애프터 스트림이 전담, 삼전 애프터 문자는 트래킹 검증 후 승격.
  if (PREDICT_CONFIG.sms.enabled && minuteOfDay >= hhmmToMin("08:25") && minuteOfDay <= 15 * 60 + 25) {
    try {
      const nowHHMM2 = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
      // 강도·실측·유사사례 3종 동봉 (사용자 지시 2026-07-25 — 모든 판정 문자 공통 눈금)
      // + 측정 시각 (사용자 지시 2026-07-27: 소멸 등 확인시각 없는 문자도 시각을 다 붙일 것)
      const statCore = `측정 ${nowHHMM2}·이 시각대 과거적중 ${slotHitPct(nowHHMM2) ?? "?"}%${similarHit !== null ? `·비슷한 장세 과거적중 ${similarHit}%` : ""}`;
      // 이벤트일 경고 라인 (사용자 승인 2026-07-29 밤 — 7/29 실사고 후속: 이벤트일 아침 반등이
      // 낮에 붕괴하는 왕복. 신호 억제는 counter-f-sweep 기각 — 정보 한 줄만, 판정·비중 불변).
      // 캘린더는 predict-daily 소유지만 판정 로직이 아닌 일정 데이터라 공용 참조 (kisToken 전례).
      let eventWarn = "";
      try {
        const { upcomingEvents } = await import("@/lib/predict-daily/eventCalendar");
        const { PREDICT_DAILY_CONFIG } = await import("@/lib/predict-daily/config");
        const evs = [
          ...upcomingEvents(today, 0).map((e) => e.kind as string),
          ...PREDICT_DAILY_CONFIG.events.filter((e) => e.date === today).map((e) => e.label),
        ];
        if (evs.length) eventWarn = `\n⚠오늘 이벤트일(${evs.join("·")}) — 발표 전후 왕복 위험, 비중 축소 권장 (일봉은 자동 감산)`;
      } catch { /* 캘린더 조회 실패 — 라인 생략 */ }
      // 스탑 폭 종목 분리 (2026-07-28 — config.stops.fisher 근거 참조): 하닉 -5% / 삼전 -3%
      const fisherEtf = (sym: "hx" | "ss") => (sym === "hx" ? PREDICT_CONFIG.stops.fisher.hxEtfPct : PREDICT_CONFIG.stops.fisher.etfPct);
      const ffStop = fisherEtf("hx");
      // 하닉 3단계 (F·M 08 연속창 / 본 09 정규장창)
      const hxCont = [...(pre ?? []), ...krx].filter((b) => b.time < nowHHMM2);
      const hxReg = krx.filter((b) => b.time < nowHHMM2);
      let hxFo: ReturnType<typeof runFisher> | null = null;
      let hxMo: ReturnType<typeof runFisher> | null = null;
      let hxBo: ReturnType<typeof runFisher> | null = null;
      if (hxCont.length >= 20) {
        const inC = { date: today, dailyHistory: complete.slice(-120), openPx: hxCont[0].open, morning: hxCont, prevDayMinutes: null };
        // 강돌파 동봉 (2026-07-25 정합 수정): 판정 스트림·실시간 조회의 F는 강돌파 포함인데
        // 모니터 F에만 빠져 있었음 — 스펙(F 0.05·4봉+강돌파)대로 통일. 하닉 0.1.
        // 장초반 크기 ×3 (사용자 승인 2026-07-29 — config.earlyVol 근거 참조, F 전용)
        hxFo = runFisher(inC, { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes, strongBreakRatio: PREDICT_CONFIG.earlyStrongBreakRatio, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, earlyVolMult: PREDICT_CONFIG.earlyVol.mult, earlyVolUntil: PREDICT_CONFIG.earlyVol.until, confirmFromHHMM: PREDICT_CONFIG.confirmFromKr });
        // 장초반 크기 ×1.25 (사용자 승인 2026-07-30 — config.earlyVol.mMult 근거 참조)
        hxMo = runFisher(inC, { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, earlyVolMult: PREDICT_CONFIG.earlyVol.mMult, earlyVolUntil: PREDICT_CONFIG.earlyVol.until, confirmFromHHMM: PREDICT_CONFIG.confirmFromKr });
      }
      if (hxReg.length >= 20) {
        hxBo = runFisher(
          { date: today, dailyHistory: complete.slice(-120), openPx: hxReg[0].open, morning: hxReg, prevDayMinutes: null },
          { strongBreakRatio: PREDICT_CONFIG.lateStrongBreakRatio, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, ...hxTrailOpts },
        );
      }
      let hxF2: Verdict = hxFo?.verdict ?? "none";
      let hxM2: Verdict = hxMo?.verdict ?? "none";
      let hxB2: Verdict = hxBo?.verdict ?? "none";
      const prevState = await loadSsState();
      const sameDay = prevState !== null && prevState.date === today;
      // 소멸 불변식 가드 (2026-07-27 실사고): 피셔 상태기계는 확인 후 up↔down 전환만 가능 —
      // 같은 날 '방향→none'은 판정이 아니라 분봉 결손 아티팩트다 (10:14 프리장 결손 → F·M
      // '인버스 소멸' 오발송, 재확인은 1일 1회 키에 막혀 침묵). 직전 상태 유지 + 로그 —
      // 프리장 가드가 못 잡는 결손 모드까지 최종 차단.
      const keepDir = (prev: Verdict, cur: Verdict, tag: string): Verdict => {
        if (prev !== "none" && cur === "none") {
          console.error(`[predict] ${tag} ${prev}→none 차단 (확인 후 none 복귀 불가 — 데이터 결손 의심)`);
          return prev;
        }
        return cur;
      };
      if (sameDay) {
        hxF2 = keepDir(prevState!.hx.F, hxF2, "하닉F"); hxM2 = keepDir(prevState!.hx.M, hxM2, "하닉M"); hxB2 = keepDir(prevState!.hx.B, hxB2, "하닉본");
        ssF = keepDir(prevState!.ss.F, ssF, "삼전F"); ssM = keepDir(prevState!.ss.M, ssM, "삼전M"); ssB = keepDir(prevState!.ss.B, ssB, "삼전본");
        if (ssTail) ssTail = `\n삼전: F${ssLab(ssF)}·M${ssLab(ssM)}·본${ssLab(ssB)}${ssPxStr}`;
      }
      const hxPx = hxReg.length ? hxReg[hxReg.length - 1].close : hxCont.length ? hxCont[hxCont.length - 1].close : null;
      const hxLine = `\n하닉: F${ssLab(hxF2)}·M${ssLab(hxM2)}·본${ssLab(hxB2)}${hxPx !== null ? ` ${hxPx.toLocaleString()}원` : ""}`;
      const bothLines = `${hxLine}${ssTail || "\n삼전: 스냅샷 없음"}`;

      // 갭 경고 표기 (사용자 승인 2026-07-25 — config.gapWarn 근거 참조): |갭| ≥ 3% 날
      // 해당 종목의 방향 전이·회복 문자에 유사일 실측 한 줄 동봉. 판정·비중 불변 — 정보 레이어.
      const GW = PREDICT_CONFIG.gapWarn;
      const prevHxClose = complete[complete.length - 1]?.close;
      const hxGapPct = hxReg.length && prevHxClose ? ((hxReg[0].open - prevHxClose) / prevHxClose) * 100 : null;
      const ssPrevClose = ssHistBars[ssHistBars.length - 1]?.close;
      const ssGapPct = ssRegBars && ssRegBars.length && ssPrevClose ? ((ssRegBars[0].open - ssPrevClose) / ssPrevClose) * 100 : null;
      const gapLine = (sym: "hx" | "ss"): string => {
        const g = sym === "hx" ? hxGapPct : ssGapPct;
        if (g === null || Math.abs(g) < GW.minAbsPct) return "";
        return `\n⚠갭 ${g >= 0 ? "+" : ""}${g.toFixed(1)}% ${g >= 0 ? "급등" : "급락"}일 — ${GW[sym][g >= 0 ? "up" : "down"]}. 비중 축소 권장.`;
      };
      // 광폭 시초레인지 경고 복원 (2026-07-25 — 체크포인트 문자 폐기 때 함께 사라졌던 명시줄.
      // 실측: OR ≥4% 날 피셔 적중 43% vs 평소 62~68%, 하닉 220일. 삼전은 하닉 버킷 이식)
      const orWarnLine = (sym: "hx" | "ss"): string => {
        const bars = sym === "hx" ? hxReg : ssRegBars ?? [];
        if (bars.length < 15) return "";
        const or15 = bars.slice(0, 15);
        const w = ((Math.max(...or15.map((b) => b.high)) - Math.min(...or15.map((b) => b.low))) / bars[0].open) * 100;
        if (w < PREDICT_CONFIG.orBuckets.wideMinPct) return "";
        return `\n⚠시초레인지 ${w.toFixed(1)}% 광폭 — 유사일 피셔 적중 ${PREDICT_CONFIG.orBuckets.hit.wide}%(평소 ${PREDICT_CONFIG.orBuckets.hit.calm}~${PREDICT_CONFIG.orBuckets.hit.mid}%). 비중 축소.`;
      };

      // 효율 소진 경고 (사용자 요청 2026-07-26 — 스펙 2.20 실측): 전일 추세일(레짐 Q1·Q3)에
      // 확인 시점 60분 DC2(순이동/총이동) ≥ 0.35면 유사조건 실측 열위 — 승률 38~44%·누적 ~0
      // (저효율 확인 53~63%·전건 양수 대비), 두 종목·전후반 4/4 일관. 판정 불변 — 정보 레이어.
      // 무추세일 게이트(3/4)·DC1 소진(혼재)은 기준 미달로 미적용 (스펙 2.20).
      const hxPrevTrend = complete.length > 0 && labelDay(complete[complete.length - 1]).label !== "none";
      const ssPrevTrend = ssHistBars.length > 0 && labelDay(ssHistBars[ssHistBars.length - 1]).label !== "none";
      const dc2Warn = (sym: "hx" | "ss", tier: "F" | "M" | "B", confT: string | null): string => {
        if (!confT) return "";
        if (!(sym === "hx" ? hxPrevTrend : ssPrevTrend)) return "";
        const bars = tier === "B" ? (sym === "hx" ? hxReg : ssRegBars ?? []) : (sym === "hx" ? hxCont : ssContBars ?? []);
        const idx = bars.findIndex((b) => b.time === confT);
        if (idx < 59) return "";
        const w = bars.slice(idx - 59, idx + 1);
        let path = 0;
        for (let i = 0; i + 5 <= w.length; i += 5) path += Math.abs(w[i + 4].close - w[i].open);
        const dc2 = path > 0 ? Math.abs(w[w.length - 1].close - w[0].open) / path : null;
        if (dc2 === null || dc2 < 0.35) return "";
        return `\n⚠고효율 구간 확인 — 추세 소진으로 남은 마진 축소(60분 DC2 ${dc2.toFixed(2)}) — 전일추세일 고효율 확인 실측 승률 38~44%·본전 (저효율 확인 53~63% 대비 열위). 비중 축소 권장.`;
      };

      type Trig = { sym: "hx" | "ss"; symKo: string; tier: "F" | "M" | "B"; tierKo: string; prev: Verdict; cur: Verdict; reason: string; fDir: Verdict; strength: number };
      const conf = (o: { confidence: number } | null): number => Math.round((o?.confidence ?? 0.5) * 100);
      const trigs: Trig[] = [
        { sym: "hx", symKo: "하닉", tier: "F", tierKo: "피셔F 임시판정", prev: sameDay ? prevState!.hx.F : "none", cur: hxF2, reason: hxFo?.reason ?? "", fDir: hxF2, strength: conf(hxFo) },
        { sym: "hx", symKo: "하닉", tier: "M", tierKo: "피셔M 중간확인", prev: sameDay ? prevState!.hx.M : "none", cur: hxM2, reason: hxMo?.reason ?? "", fDir: hxF2, strength: conf(hxMo) },
        { sym: "hx", symKo: "하닉", tier: "B", tierKo: "본피셔 확정", prev: sameDay ? prevState!.hx.B : "none", cur: hxB2, reason: hxBo?.reason ?? "", fDir: hxF2, strength: conf(hxBo) },
        { sym: "ss", symKo: "삼전", tier: "F", tierKo: "피셔F 임시판정", prev: sameDay ? prevState!.ss.F : "none", cur: ssF, reason: ssFReason, fDir: ssF, strength: ssFc },
        { sym: "ss", symKo: "삼전", tier: "M", tierKo: "피셔M 중간확인", prev: sameDay ? prevState!.ss.M : "none", cur: ssM, reason: ssMReason, fDir: ssF, strength: ssMc },
        { sym: "ss", symKo: "삼전", tier: "B", tierKo: "본피셔 확정", prev: sameDay ? prevState!.ss.B : "none", cur: ssB, reason: ssBReason, fDir: ssF, strength: ssBc },
      ];
      // 비중 역순 20/30/50 (사용자 승인 2026-07-30 밤 — scripts/weight-order-sweep.ts 227일:
      // 현행 50/30/20 대비 하닉 +82.7→+93.9·삼전 +63.1→+71.5%p, 컷 실손 -123.5→-90.5/-98.1→-85.0.
      // 원리: 계층 원값 F<M<본 — 가장 확실한 신호(본)에 가장 큰 비중. F 컷 한 방의 계좌 타격
      // -2.5%p→-1.0%p. 열화 시 이 함수의 비중 숫자만 원복(50/30/20).
      const guideOf = (t: Trig): string => {
        if (t.cur === "none") return "▶해당 단계 비중 축소·청산 검토.";
        if (t.prev !== "none" && t.prev !== t.cur) return "▶방향 반전 — 기존 포지션 청산 후 반대 방향 1단계(20%)부터.";
        const sp = fisherEtf(t.sym);
        if (t.tier === "F") return `▶1단계: 계획 비중 20% 진입 검토·스탑 ETF -${sp}%. 피셔M 중간확인 대기.`;
        if (t.tier === "M") {
          const warn = t.fDir !== "none" && t.cur !== t.fDir ? " ⚠피셔F와 반대 — F 선진입분 축소 검토." : "";
          return `▶2단계: 투자 비중 +30%p(누적 50%) 검토·스탑 ETF -${sp}%.${warn}`;
        }
        return `▶3단계: 본진입 +50%p(누적 100%) 검토·스탑 ETF -${sp}% 고정·당일청산.`;
      };
      let anyChange = false;
      for (const t of trigs) {
        if (t.cur === t.prev) continue;
        anyChange = true;
        const label = t.prev === "none" ? `${V_KO[t.cur]} 확인` : t.cur === "none" ? `${V_KO[t.prev]} 소멸` : `${V_KO[t.prev]}→${V_KO[t.cur]} 전환`;
        // 지연 통지 가드 (2026-07-23 실사고: 배포 직후 초기화가 2시간 전 확인을 '레버리지 확인'으로 발송
        // → 하락 중 매수 신호로 오독). 확인 시각과 발송 시각이 30분+ 차이면 진입 지침 대신 경고.
        const confT = t.cur !== "none" ? (t.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null) : null;
        const lagMin = confT ? minuteOfDay - hhmmToMin(confT) : 0;
        const stale = confT !== null && lagMin >= 30;
        // 소진 확인 가드 (2026-07-25 — 7/23 하닉 11:24 실사고, config.exhaustGuard 근거 참조):
        // 본피셔 방향 확인이 당일 극값 대비 이미 크게 진행된 지점이면 진입 지침 대신 추격 금지.
        let exhaustPct: number | null = null;
        if (!stale && t.tier === "B" && t.cur !== "none") {
          const eBars = t.sym === "hx" ? hxReg : ssRegBars ?? [];
          if (eBars.length >= 20) {
            const closes = eBars.map((b) => b.close);
            const lastC = closes[closes.length - 1];
            const ext = t.cur === "inverse" ? Math.max(...closes) : Math.min(...closes);
            const prog = Math.abs(((lastC - ext) / ext) * 100);
            if (prog >= PREDICT_CONFIG.exhaustGuard.minProgressPct) exhaustPct = prog;
          }
        }
        const guide = stale
          ? `⚠지연 통지(확인 ${confT}, ${lagMin}분 경과) — 추격 진입 금지, 현재가와 다음 전이 문자 기준으로 판단.`
          : exhaustPct !== null
            ? `⚠극값 대비 이미 ${exhaustPct.toFixed(1)}% 진행된 확인 — 추세 소진으로 남은 마진 축소(유사일 잔여 평균 -1.2~-2.0%·적중 27~33%). 추격 진입 금지, 기보유 정리·반등 유의.`
            // 삼전 10:00 진입 지연 (사용자 채택 2026-08-01 — config.ssEntryDelayHHMM 근거): 판정은 유효,
            // 실행만 보류 → 10:00 도달 문자에서 유지 확인 후 실행. 하닉은 즉시 진입 유지.
            : t.sym === "ss" && t.cur !== "none" && minuteOfDay < hhmmToMin(PREDICT_CONFIG.ssEntryDelayHHMM)
              ? `▶진입 보류(삼전 10:00 지연 채택) — 10:00 도달 문자에서 방향 유지 시 ${t.tier === "F" ? "1단계 20%" : t.tier === "M" ? "2단계 +30%p(누적 50%)" : "3단계 +50%p(누적 100%)"} 실행. 청산·전환 판단은 즉시 유효.`
              : guideOf(t);
        const stopLine = !stale && exhaustPct === null && t.sym === "hx" && t.cur !== "none" ? await etfStopLine(t.cur, ffStop) : "";
        try {
          await dispatchToChannels("signal", today, {
            key: `predict_tr_${t.sym}${t.tier}_${t.prev}_${t.cur}`,
            severity: t.tier === "B" ? "high" : "medium",
            // 액션 선두·근거 후행 (사용자 지시 2026-08-01 — 장중 빠른 판단용)
            text: `[예측·${t.symKo} ${t.tierKo}] ${guide} 무응답=현행 유지 | 근거: ${label}${t.cur !== "none" && t.reason ? ` — ${t.reason.split(" — ")[0]}` : ""} (강도 ${t.strength}%·${statCore})${!stale && t.cur !== "none" ? gapLine(t.sym) + orWarnLine(t.sym) + dc2Warn(t.sym, t.tier, confT) : ""}${stopLine}${t.cur !== "none" ? eventWarn : ""}${bothLines}`,
            smsSubject: "예측 판정",
          });
        } catch { /* 발송 실패 무시 */ }
      }

      // 삼전 10:00 지연 진입 실행 문자 (사용자 채택 2026-08-01 — entry-delay-sweep 388a0c8:
      // 새 비중 기준 삼전 +71.5→+82.1%p·컷 실손 -85→-71.8. 10:00 이전 판정은 '보류' 지침으로
      // 나갔으므로, 도달 시점에 유지 중인 단계를 그 시점 가격으로 실행하라는 1일 1회 알림).
      try {
        if (minuteOfDay >= hhmmToMin(PREDICT_CONFIG.ssEntryDelayHHMM) && minuteOfDay <= hhmmToMin(PREDICT_CONFIG.ssEntryDelayHHMM) + 5) {
          const held: string[] = [];
          if (ssF !== "none") held.push(`F 1단계 20% ${V_KO[ssF]}`);
          if (ssM !== "none") held.push(`M 2단계 +30%p ${V_KO[ssM]}`);
          if (ssB !== "none") held.push(`본 3단계 +50%p ${V_KO[ssB]}`);
          if (held.length) {
            const pxB = ssContBars.length ? ssContBars[ssContBars.length - 1] : null;
            await dispatchToChannels("signal", today, {
              key: "predict_ss_delay_entry",
              severity: "medium",
              text: `[예측·삼전 지연진입] ▶10:00 도달 — 유지 중 단계 지금 실행: ${held.join(" · ")}${pxB ? ` (현재 ${pxB.close.toLocaleString()}원 ${pxB.time})` : ""}. 무응답=현행 유지 | 근거: 삼전 10:00 진입 지연 채택(8/1) — 227일 실측 +71.5→+82.1%p·컷 실손 -85→-71.8. 청산·전환은 지연 없이 즉시.`,
              smsSubject: "예측 판정",
            });
          }
        }
      } catch { /* 발송 실패 무시 */ }

      // 판정 후 5봉 진행성 문자 (사용자 승인 2026-07-30 "모든 판정에" — docs/early-vol-policy.md):
      // 하닉·삼전 F/M/본 6조합. 판정 5분 뒤 진행폭을 기준(0.1×10일폭)과 비교해 후속 문자 1회 —
      // 기준·실제(원·%)·해당 조합 실측 통계 명시(사용자 지정 형식), 전진/역행 표기(오독 교정).
      // 통계 출처: scripts/prog5-all-sweep.ts 227일. 키에 확인시각 — 판정(전환)마다 1회. 판정 불변 정보 레이어.
      try {
        const r10hx = avgRange(complete.slice(-120), 10);
        const r10ss = ssHistBars.length >= 11 ? avgRange(ssHistBars.slice(-120), 10) : null;
        const PROG5_STATS: Record<string, { ok: string; bad: string }> = {
          hxF: { ok: "35건: 평균 +2.40%·승률 71%·컷률 6%", bad: "194건: 평균 -0.06%·컷률 30%" },
          hxM: { ok: "37건: 평균 +1.28%·승률 62%·컷률 22%", bad: "167건: 평균 +0.21%·컷률 28%" },
          hxB: { ok: "56건: 평균 +1.06%·승률 61%·컷률 0%", bad: "339건: 평균 +0.15%·컷률 5%" },
          ssF: { ok: "26건: 평균 +0.58%·승률 54%·컷률 27%", bad: "189건: 평균 +0.20%·컷률 35%" },
          ssM: { ok: "29건: 평균 +0.75%·승률 59%·컷률 34%", bad: "168건: 평균 +0.28%·컷률 34%" },
          ssB: { ok: "37건: 평균 +0.93%·승률 76%·컷률 8%", bad: "265건: 평균 +0.18%·컷률 15%" },
        };
        const progChecks: { key: string; symKo: string; tierKo: string; v: Verdict; reason: string; bars: MinuteBar[] | null; r10: number | null }[] = [
          { key: "hxF", symKo: "하닉", tierKo: "F", v: hxF2, reason: hxFo?.reason ?? "", bars: hxCont, r10: r10hx },
          { key: "hxM", symKo: "하닉", tierKo: "M", v: hxM2, reason: hxMo?.reason ?? "", bars: hxCont, r10: r10hx },
          { key: "hxB", symKo: "하닉", tierKo: "본피셔", v: hxB2, reason: hxBo?.reason ?? "", bars: hxReg, r10: r10hx },
          { key: "ssF", symKo: "삼전", tierKo: "F", v: ssF, reason: ssFReason, bars: ssContBars, r10: r10ss },
          { key: "ssM", symKo: "삼전", tierKo: "M", v: ssM, reason: ssMReason, bars: ssContBars, r10: r10ss },
          { key: "ssB", symKo: "삼전", tierKo: "본피셔", v: ssB, reason: ssBReason, bars: ssRegBars, r10: r10ss },
        ];
        for (const pc of progChecks) {
          if (pc.v === "none" || !pc.bars || pc.bars.length < 20 || pc.r10 === null) continue;
          const progConfT = pc.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
          if (!progConfT) continue;
          const t5 = hhmmToMin(progConfT) + 5;
          if (minuteOfDay < t5 + 1) continue;
          const confBar = pc.bars.find((b) => b.time === progConfT);
          const bar5 = [...pc.bars].reverse().find((b) => hhmmToMin(b.time) <= t5);
          if (!confBar || !bar5 || hhmmToMin(bar5.time) < t5 - 1) continue;
          const dirSgn = pc.v === "leverage" ? 1 : -1;
          const dirKo = pc.v === "leverage" ? "레버" : "인버";
          const prog = (bar5.close - confBar.close) * dirSgn;
          const need = 0.1 * pc.r10;
          const ok = prog >= need;
          const pct = (v: number) => ((100 * v) / confBar.close).toFixed(1);
          const st = PROG5_STATS[pc.key];
          await dispatchToChannels("signal", today, {
            key: `predict_prog5_${pc.key}_${pc.v}_${progConfT.replace(":", "")}`,
            severity: ok ? "low" : "medium",
            // 액션 선두·근거 후행 (사용자 지시 2026-08-01)
            text: ok
              ? `[예측·${pc.symKo} ${pc.tierKo} 진행확인] ▶유지 | 근거: ${dirKo} 판정(${progConfT} ${confBar.close.toLocaleString()}원) 후 5분 — ${dirKo} 방향으로 ${Math.round(prog).toLocaleString()}원(${pct(prog)}%) 전진 → 기준(전진 ${Math.round(need).toLocaleString()}원=10일평균폭 ${Math.round(pc.r10).toLocaleString()}원의 10%) 충족, 정상. 과거 이 경우 ${st.ok}.`
              : `[예측·${pc.symKo} ${pc.tierKo} 진행경보] ▶해당 단계 비중 축소 검토. 무응답=유지 | 근거: ${dirKo} 판정(${progConfT} ${confBar.close.toLocaleString()}원) 후 5분 — ${prog < 0 ? `판정 방향 반대로 ${Math.round(-prog).toLocaleString()}원(${pct(-prog)}%) 역행` : `전진 ${Math.round(prog).toLocaleString()}원(${pct(prog)}%)뿐`} → 기준(판정 방향으로 전진 ${Math.round(need).toLocaleString()}원=10일평균폭 ${Math.round(pc.r10).toLocaleString()}원의 10%) 미달, 힘없는 판정. 과거 이 경우 ${st.bad}.`,
            smsSubject: ok ? "예측 진행확인" : "예측 진행경보",
          });
        }
      } catch { /* 진행성 문자 실패는 모니터를 막지 않는다 */ }

      // 09창 F 반전 경보 (사용자 승인 2026-07-25 — 스펙 2.12): 본피셔 방향 유지 중 09시창
      // 피셔F(0.05·4봉·강돌파)가 반대 방향을 확인하면 경보. 08창 F는 프리장 급등락이 OR에 들어간 날
      // 반전을 못 잡음 (실측 커버 7/25 → 09창 25/25, 리드 중앙 하닉 11분·삼전 2분, 순효과 하닉 +9.5%p).
      // 키 = 방향 조합(1일 1회), 지연 통지 가드 동일. F 판정자(08창)·전이 문자는 불변 — 경보 레이어만 추가.
      // 확정(14:00) 이후 가이드 분기 (2026-07-26 — 스펙 2.17, scripts/f-rejudge-sweep.ts 224일 실측):
      // 확정 후 F9 '신규' 반대 확인은 F 단독으론 손실(M 미재확인 5건 합 -4.6%p), 피셔M(0.10·08창)
      // 동방향 재확인 동반 시에만 전건 이득(4/4, +3.1%p) — 소표본이라 가이드 문구만 분기, 판정 불변.
      try {
        const revChecks = [
          { sym: "hx", symKo: "하닉", bState: hxB2, mState: hxM2, reg: hxReg.length >= 20 ? hxReg : null, hist: complete.slice(-120), sb: PREDICT_CONFIG.earlyStrongBreakRatio },
          { sym: "ss", symKo: "삼전", bState: ssB, mState: ssM, reg: ssRegBars, hist: ssHistBars, sb: PREDICT_CONFIG.ssStrongBreakRatio },
        ] as const;
        for (const rc of revChecks) {
          if (rc.bState === "none" || !rc.reg || rc.hist.length < 11) continue;
          const f9 = runFisher(
            { date: today, dailyHistory: rc.hist, openPx: rc.reg[0].open, morning: rc.reg, prevDayMinutes: null },
            { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes, strongBreakRatio: rc.sb, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes },
          );
          if (f9.verdict === "none" || f9.verdict === rc.bState) continue;
          const confT9 = f9.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
          const lag9 = confT9 ? minuteOfDay - hhmmToMin(confT9) : 0;
          const stale9 = confT9 !== null && lag9 >= 30;
          const postFinal9 = minuteOfDay > hhmmToMin("14:00");
          const mSame9 = rc.mState === f9.verdict;
          // 문구 쉬운 말로 (사용자 지시 2026-07-29 밤: "좀 쉽게 문자로 보낼 때 적어줘")
          const guide9 = stale9
            ? `⚠늦게 도착한 알림(확인 ${confT9}, ${lag9}분 지남) — 지금 따라 들어가지 말고 다음 문자 기준으로 판단.`
            : postFinal9
              ? mSame9
                ? `▶청산·전환 검토 — 피셔M도 같은 방향 재확인 (과거 4번 모두 이득·표본 적음).`
                : `▶일단 관망 — F 혼자만 반대인 경우는 과거에 손해였음. 피셔M 재확인 문자를 기다리세요.`
              : `▶보유 줄이기·청산 검토. 과거 반전한 날은 이 경보가 100% 먼저 왔음(2~11분 전). 단 경보가 떠도 반전 안 하는 날도 있으니, 반대로 갈아타는 건 본피셔 전환 확정 문자까지 기다리세요.`;
          // 상태줄 F·M(08시창)과 경보의 09시창 F 혼동 방지 각주 (사용자 지적·승인 2026-07-29 —
          // 7/29 10:28 실사례: 상태줄 "F레버·M레버"와 본문 "피셔F 인버스 확인"이 모순처럼 읽힘)
          await dispatchToChannels("signal", today, {
            key: `predict_rev9_${rc.sym}_${rc.bState}_${f9.verdict}`,
            severity: "high",
            text: `[예측·${rc.symKo} 반전경보] 본피셔 ${V_KO[rc.bState]} 유지 중인데, 9시 이후 흐름만 보면 ${V_KO[f9.verdict]} 신호가 떴습니다${confT9 ? `(${confT9} 확인)` : ""}${postFinal9 ? ` · 피셔M 재확인 ${mSame9 ? "O" : "X"}` : ""}. ${guide9} 무응답=현행 유지\n※아래 상태줄 F·M은 아침(08시)창 기준이라 이 경보와 다르게 보일 수 있음${bothLines}`,
            smsSubject: "예측 반전경보",
          });
        }
      } catch { /* 경보 실패는 모니터를 막지 않는다 */ }

      // 노이즈컷 회복 문자 (사용자 승인 2026-07-25 — 스펙 2.14): 본피셔 방향 유지 중 판정가 대비
      // 본주 -1.5% 스탑라인을 찍었다가 원판정가를 종가로 회복하면 재진입 검토 통지. 컷 시점엔 침묵
      // (사용자 지정 — 스탑 실행은 HTS 자동매도 몫, 문자 없음). 트리거는 실측 우월안 '원진입가 회복'
      // (A선 회복은 재컷 왕복 큼 — 실측 승률 49~50%·누적 하닉 +3.5/삼전 +7.2%p). 키 = 종목·방향 1일 1회.
      try {
        // 종목별 스탑 폭 (2026-07-28): ETF % ÷2 = 본주 % — 컷·회복 감지도 실매매 스탑과 일치시킴
        const recChecks = [
          { sym: "hx", symKo: "하닉", bState: hxB2, reason: hxBo?.reason ?? "", reg: hxReg },
          { sym: "ss", symKo: "삼전", bState: ssB, reason: ssBReason, reg: ssRegBars ?? [] },
        ] as const;
        for (const rc of recChecks) {
          if (rc.bState === "none" || rc.reg.length < 20) continue;
          const stopFrac = fisherEtf(rc.sym) / 2 / 100; // ETF % ÷2 = 본주 %
          const confT = rc.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
          const confBar = confT ? rc.reg.find((b) => b.time === confT) : undefined;
          if (!confT || !confBar) continue;
          const entry = confBar.close;
          const isUp = rc.bState === "leverage";
          const afterConf = rc.reg.filter((b) => b.time > confT);
          const cutIdx = afterConf.findIndex((b) => (isUp ? b.low <= entry * (1 - stopFrac) : b.high >= entry * (1 + stopFrac)));
          if (cutIdx < 0) continue; // 스탑라인 미접촉 — 해당 없음
          const rec = afterConf.slice(cutIdx + 1).find((b) => (isUp ? b.close > entry : b.close < entry));
          if (!rec) continue; // 아직 회복 전
          const lagR = minuteOfDay - hhmmToMin(rec.time);
          const staleR = lagR >= 30;
          const guideR = staleR
            ? `⚠지연 통지(회복 ${rec.time}, ${lagR}분 경과) — 추격 진입 금지, 현재가와 다음 문자 기준 판단.`
            : `▶동일 방향 추세 지속 — 재진입 검토: 새 진입가 기준 스탑 ETF -${fisherEtf(rc.sym)}% 재설정 · 실측 승률 ~50%·소폭 순익 — 소액 권장.`;
          const stopLineR = !staleR && rc.sym === "hx" ? await etfStopLine(rc.bState, fisherEtf("hx")) : "";
          await dispatchToChannels("signal", today, {
            key: `predict_recut_${rc.sym}_${rc.bState}`,
            severity: "medium",
            text: `[예측·${rc.symKo} 회복] 스탑컷 후 원판정가 회복 — 본피셔 ${V_KO[rc.bState]} 유지 중 (판정 ${confT} ${entry.toLocaleString()}원 · 컷 ${afterConf[cutIdx].time} → 회복 ${rec.time}). ${guideR} 무응답=미진입${staleR ? "" : gapLine(rc.sym)}${stopLineR}${bothLines}`,
            smsSubject: "예측 회복",
          });
        }
      } catch { /* 회복 문자 실패는 모니터를 막지 않는다 */ }

      // 무추세 확인 문자 (사용자 지시 2026-07-25): 방향이 없을 때도 ①프리장 ②정규장 각 1회
      // "아직 방향 없음" 통지 — 시스템 가동 확인 겸 (사용자: "추세가 없다는 것을 확인하기 위함").
      // 모든 단계(하닉·삼전 F/M/본)가 없음 + 오늘 방향 이력도 없음일 때만 — 등장·소멸은 전이 문자 전담.
      // 데이터 가드: 분봉 확보 시에만 (휴장·결손일 오발송 방지). 키 predict_flat_* — 하루 1회.
      const allNone = [hxF2, hxM2, hxB2, ssF, ssM, ssB].every((v) => v === "none");
      const prevAllNone = !sameDay
        || (["F", "M", "B"] as const).every((t) => prevState!.hx[t] === "none" && prevState!.ss[t] === "none");
      if (allNone && prevAllNone) {
        const preWindow = minuteOfDay >= hhmmToMin("08:30") && minuteOfDay < hhmmToMin("09:05") && hxCont.length >= 20;
        const regWindow = minuteOfDay >= hhmmToMin("10:00") && hxReg.length >= 20;
        if (preWindow || regWindow) {
          // 경계 이탈 정보 라벨 (사용자 승인 2026-07-29 — 장중 레짐 실측 후속, 판정 불변):
          // 시초레인지 경계 이탈 횟수가 3종목 단조 일관한 유일 지표 — 이탈 적은 날은 남은 장 기대
          // 낮음 (10시후 삼전 +5.4·하닉 -8.8·TOP10 +3.2%p — scripts/intraday-regime-sweep.ts).
          // 개입은 종목 간 이득 상쇄로 기각 — 표시만. 정규장 확인 문자에만 (프리장은 09시창 미형성).
          const crossLabel = regWindow
            ? (() => {
              const hxC = countOrCross(hxReg), ssC = ssRegBars ? countOrCross(ssRegBars) : null;
              if (hxC === null && ssC === null) return "";
              const cnt = ` 경계이탈 하닉 ${hxC ?? "?"}·삼전 ${ssC ?? "?"}회`;
              const low = (hxC ?? 9) <= 1 && (ssC ?? 9) <= 1;
              return cnt + (low ? " — 이탈 적은 날은 남은 장 기대 낮음(실측: 하닉 음수)." : ".");
            })()
            : "";
          try {
            await dispatchToChannels("signal", today, {
              key: preWindow ? "predict_flat_pre" : "predict_flat_reg",
              severity: "low",
              text: preWindow
                ? `[예측] 프리장 방향 없음 (가동 확인·측정 ${nowHHMM2}) — 하닉·삼전 피셔F 미확인. 방향 확인 시 즉시 문자.${bothLines}`
                : `[예측] 정규장 방향 없음 (측정 ${nowHHMM2}) — 하닉·삼전 F/M/본 모두 미확인. 진입 대기, 방향 확인 시 즉시 문자.${crossLabel}${bothLines}`,
              smsSubject: "예측 상태",
            });
          } catch { /* 발송 실패 무시 */ }
        }
      }
      if (anyChange || !sameDay) await saveSsState({ date: today, ss: { F: ssF, M: ssM, B: ssB }, hx: { F: hxF2, M: hxM2, B: hxB2 } });
    } catch { /* 모니터 실패는 스트림(기록·채점)을 막지 않는다 */ }
  }

  if (!changed || revs.length === 0) return false;
  const isFinal = revs.some((r) => r.checkpoint === lastCp);
  await upsertCheckpointDay(today, revs[revs.length - 1], revs, isFinal, prior);
  return true;
}

export async function runPredictService(): Promise<PredictRunResult> {
  const code = PREDICT_CONFIG.symbol;
  const { date: today, minuteOfDay } = kstNowPredict();
  const daily = await fetchDailyPredict(code, 170);
  const complete = daily.filter((b) => b.date < today); // 오늘 제외 = 확정 일봉
  const result: PredictRunResult = { date: today, judgedToday: false, earlyToday: false, backfilled: [], scored: [] };
  if (complete.length < 40) return result;

  // ① 최근 10거래일 중 판정 자체가 없는 날 백필 (판정→즉시 채점)
  for (const bar of complete.slice(-10)) {
    if (await hasJudgment(bar.date)) continue;
    const idx = complete.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const ok = await judgeOneDay(bar.date, complete.slice(0, idx), bar.open, "backfill", false);
    if (ok) {
      const { label, rOC } = labelDay(bar);
      await scoreDay(bar.date, label, rOC);
      result.backfilled.push(bar.date);
    }
  }

  // ② 판정은 있는데 미채점인 과거일 채점
  for (const d of await listUnscoredDates(today)) {
    const bar = complete.find((b) => b.date === d);
    if (!bar) continue;
    const { label, rOC } = labelDay(bar);
    await scoreDay(d, label, rOC);
    result.scored.push(d);
  }

  // ③a 체크포인트 스트림 (08:31~) — 08:30 첫 판정, 30분마다, 14:00 확정. 사이는 모니터링
  const todayBar = daily.find((b) => b.date === today);
  // 프리장 게이트 교정 (사용자 실측 2026-07-29: 08:45 하닉 M 확인 → 09:00 발송 15분 지연):
  // 네이버 일봉의 '오늘 봉'은 09:00 개장 후에야 생겨 todayBar 게이트가 프리장 확인(08시창 F·M)을
  // 전부 09:00까지 눌러왔다. 평일 09:05 전엔 todayBar 없이 진입 — checkpointStream 내부 가드
  // (분봉 커버리지 80%·hxCont≥20봉·판정 최소 봉수)가 휴장일 무데이터를 걸러 오발송 없음.
  const dowToday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const preSessionOk = dowToday >= 1 && dowToday <= 5 && minuteOfDay < 9 * 60 + 5;
  if ((todayBar || preSessionOk) && minuteOfDay >= STREAM_MIN) {
    result.earlyToday = await checkpointStream(today, complete, minuteOfDay);
  }

  // ③b 모델별 확정 스냅샷 (14:01 이후, 09:00~13:59 창) — 대조군 채점용 모델 행 + 가중치 기록
  if (todayBar && minuteOfDay >= JUDGE_MIN && !(await hasModelRows(today))) {
    result.judgedToday = await judgeOneDay(today, complete, todayBar.open, "live", true);
  }

  // ③c 15:10 당일청산 매도 문자 (ops 지시 2026-07-21: "월~금 15:10 레버리지 매도 문자").
  // 창 15:09~15:28에 들어온 호출에서 1회 발송 — 장중 ~2분 간격 외부 호출(7/21 revisions 실측:
  // 체크포인트가 매시 :02에 기록)이 주 운반체라 실발송 ≈15:09~15:11. 백업: 14:30 Vercel 크론
  // (Hobby 지연 +34~54분 → 15:04~15:24 도착분 중 15:09 이후 것).
  // 당일 판정 스트림에 방향이 한 번이라도 있었던 날만 발송 — 무추세일은 보유가 없어 소음.
  if (todayBar && minuteOfDay >= 15 * 60 + 9 && minuteOfDay <= 15 * 60 + 28) {
    try {
      const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
      const row = dow >= 1 && dow <= 5 ? await loadDayRow(today) : null;
      const hadDir = row?.revisions?.some((r) => r.verdict !== "none") ?? false;
      if (hadDir) {
        const last = row!.revisions![row!.revisions!.length - 1].verdict;
        const pos = last !== "none" ? V_KO[last] : "레버리지·인버스";
        await dispatchToChannels("signal", today, {
          key: "predict_sell_1510",
          severity: "medium",
          text: `[예측·하닉] 15:10 당일청산 — 보유 하닉 ${pos} 매도 시간입니다. 장 마감(15:30) 전 정리. (월~금 고정, 7/21 지시)`,
          smsSubject: "예측 당일청산",
        });
      }
    } catch { /* 발송 실패는 본 흐름 무관 */ }
  }

  // ④ 당일 채점 (15:35 이후 — 일봉 확정)
  if (todayBar && minuteOfDay >= SCORE_MIN && (await hasJudgment(today))) {
    const unscoredToday = (await listUnscoredDates("9999-12-31")).includes(today);
    if (unscoredToday) {
      const { label, rOC } = labelDay(todayBar);
      await scoreDay(today, label, rOC);
      result.scored.push(today);
    }
  }

  // ⑤ 결정 통지 (사용자 확정 2026-07-20): 결정 필요 사항은 문자로 + 하실 일 상세.
  // 무응답 대비 리마인드 — 같은 키로 **총 3회까지**(초회 + 리마인드 2회, 하루 1회 dedup이라
  // 자연히 거래일 간격). 결정이 반영되면 config.resolvedDecisions에 키를 넣어 중단.
  if (result.scored.length > 0) {
    try {
      const rescue = await loadRescueStats();
      for (const [m, s] of Object.entries(rescue)) {
        if (s.t < 20 || s.c / s.t < 0.55) continue;
        const key = `predict_promote_${m}`;
        if ((PREDICT_CONFIG.resolvedDecisions as readonly string[]).includes(key)) continue; // 결정 완료
        const sent = await countAlertKey(key);
        if (sent >= 3) continue; // 초회 + 리마인드 2회 소진
        const name = (MODEL_LABELS as Record<string, string>)[m]?.split(" ")[0] ?? m;
        const remind = sent === 0 ? "" : sent === 1 ? " (재알림 1/2)" : " (재알림 2/2 — 마지막)";
        await dispatchToChannels("signal", today, {
          key,
          severity: "high",
          text:
            `[예측 결정필요]${remind} 보완 후보 승격기준 도달: ${name} — 피셔 공백일 방향적중 ${s.c}/${s.t} (${Math.round((s.c / s.t) * 100)}%)\n` +
            `▶하실 일:\n①Claude 앱 실행 → 스탁가드 프로젝트에서 새 세션\n②"${name} 공백 보완 검토해줘"라고 입력 → 검증 리포트 확인 후 "적용해줘"로 결정\n③무응답이면 현행(피셔 단독) 유지 — 판정 로직은 승인 없이 안 바뀝니다`,
          smsSubject: "예측 결정필요",
        });
      }
    } catch { /* 통지 실패는 본 흐름 무관 */ }
  }

  // ⑤c 주기 성능 요약 문자 (사용자 지시 2026-07-21): 2~3일에 한 번, 모델·조건값 성능 피드백.
  // 라이브 채점분(백테스트 시딩 제외) 방향적중 + 체크포인트 슬롯 실측(조기창 0.05·4봉 성과가
  // 여기 쌓임) + 애프터·섹터 한 줄. 간격은 마지막 predict_perf_* 발송일로부터 2일(KST) 이상.
  if (todayBar && minuteOfDay >= SCORE_MIN && PREDICT_CONFIG.sms.enabled) {
    try {
      const lastSent = await lastAlertDateLike("predict_perf_");
      const daysSince = lastSent ? Math.round((Date.parse(today) - Date.parse(lastSent)) / 86400e3) : 99;
      if (daysSince >= 2) {
        const perf = await loadLiveModelPerf();
        const fmt = (m: string) => {
          const s = perf[m];
          return s && s.dirT > 0 ? `${Math.round((s.dirC / s.dirT) * 100)}%(${s.dirC}/${s.dirT})` : "—";
        };
        const lines = [
          `[예측 성능] 라이브 방향적중 ~${today.slice(5)}`,
          `피셔 ${fmt("fisher")}·피셔F ${fmt("fisherf")}·피셔W ${fmt("fisherw")}`,
          `M7 ${fmt("m7")}·크레 ${fmt("crabel")}·라쉬 ${fmt("raschke")}`,
          `달튼 ${fmt("dalton")}·그라 ${fmt("grimes")}·사용자 ${fmt("user")}`,
        ];
        // 체크포인트 슬롯 실측 — 조기창 신규 상수의 실전 검증 지표
        const slot = new Map<string, { c: number; t: number }>();
        for (const d of await loadRecentDays(90)) {
          if (!d.label || !d.revisions) continue;
          for (const r of d.revisions) {
            if (!r.checkpoint || r.verdict === "none") continue;
            const s = slot.get(r.checkpoint) ?? { c: 0, t: 0 };
            s.t++;
            if (r.verdict === d.label) s.c++;
            slot.set(r.checkpoint, s);
          }
        }
        // 맞춘 횟수 병기 (사용자 지시 2026-07-29: "슬롯 가로에 맞춘 횟수도 적어줘" — 모델 줄과 동일한 c/t 형식)
        const sf = (cp: string) => {
          const s = slot.get(cp);
          return s && s.t > 0 ? `${cp} ${Math.round((s.c / s.t) * 100)}%(${s.c}/${s.t})` : `${cp} —`;
        };
        lines.push(`슬롯(판정정확도): ${["09:30", "10:30", "14:00"].map(sf).join("·")}`);
        const [after, sector] = await Promise.all([loadAfterPerf(), loadSectorPerf()]);
        const extra: string[] = [];
        if (after && after.t > 0) extra.push(`애프터 ${Math.round((after.c / after.t) * 100)}%(${after.t})`);
        if (sector && sector.t > 0) extra.push(`섹터 ${Math.round((sector.c / sector.t) * 100)}%(${sector.t})`);
        if (extra.length) lines.push(extra.join("·"));
        // 삼전 트래킹 방향적중 (2026-07-25 신설 — 피셔W 라이브 재현 감시)
        try {
          const tp = await loadTrackPerf();
          if (tp) {
            const f = (k: string, name: string) => {
              const s = tp[k];
              return s && s.t > 0 ? `${name} ${Math.round((s.c / s.t) * 100)}%(${s.t})` : null;
            };
            const parts = [f("reg/fisher", "본"), f("reg/fisherw", "W"), f("reg/fisher9", "F9"), f("pre/fisherf", "프리F"), f("after/fisher", "애프터")].filter(Boolean);
            if (parts.length) lines.push(`삼전: ${parts.join("·")}`);
          }
        } catch { /* 트래킹 통계 실패 무시 */ }
        lines.push(`조기창 0.05·4봉 적용중(7/22~) — 09:30~10:30 슬롯이 실측`);
        await dispatchToChannels("signal", today, {
          key: `predict_perf_${today}`,
          severity: "low",
          text: lines.join("\n"),
          smsSubject: "예측 성능",
        });
      }
    } catch { /* 성능 문자 실패는 본 흐름 무관 */ }
  }

  // ⑥ 애프터장 판정·채점 (15:50~19:35 스트림 + 미채점 백필) — 실패해도 정규장 흐름 무관
  try {
    const after = await runAfterService();
    if (after.judged) result.earlyToday = true;
    result.scored.push(...after.scored.map((d) => `${d}(애프터)`));
  } catch (e) {
    console.error("[predict] 애프터장 처리 실패 (마이그레이션 027 미적용?):", e);
  }

  // ⑦ 섹터 ETF 페이퍼 트래킹 (방산·조선, 10:30 피셔 — 문자 없음, 기록·채점만)
  try {
    const sec = await runSectorService();
    result.scored.push(...sec.scored.map((s) => `${s}(섹터)`));
  } catch (e) {
    console.error("[predict] 섹터 트래킹 실패 (마이그레이션 028 미적용?):", e);
  }

  // ⑧ 삼전 다세션 트래킹 (ops 지시 2026-07-25 — 프리장F·정규장 본/W·애프터, 문자 없음)
  try {
    const tr = await runTrackService();
    result.scored.push(...tr.scored.map((s) => `${s}(트래킹)`));
  } catch (e) {
    console.error("[predict] 삼전 트래킹 실패 (마이그레이션 031 미적용?):", e);
  }

  // ⑨ TIGER 반도체TOP10 모니터링 스트림 (사용자 승인 2026-07-28 밤 — 1단계 문자·기록 전용)
  try {
    const { runEtfTop10Monitor } = await import("./etfTop10");
    await runEtfTop10Monitor();
  } catch (e) {
    console.error("[predict] TOP10 모니터 실패 (기존 스트림 무관):", e);
  }

  // ⑩ 매일 추세 리뷰 (사용자 지시 2026-07-30) — 마감 후 15:42~16:10 창 1회, 실패는 내부에서 삼킴
  try {
    const { runDailyReview } = await import("./dailyReview");
    await runDailyReview();
  } catch (e) {
    console.error("[predict] 추세 리뷰 실패 (본 흐름 무관):", e);
  }

  // ⑪ 하닉 6봉 창판정 페이퍼 스트림 (사용자 승인 2026-07-31 — 문자·기록 전용, 두 청산 기준 병행 채점)
  try {
    const { runCandleWindowMonitor } = await import("./candleWindow");
    await runCandleWindowMonitor();
  } catch (e) {
    console.error("[predict] 창판정 페이퍼 스트림 실패 (본 흐름 무관):", e);
  }

  return result;
}
