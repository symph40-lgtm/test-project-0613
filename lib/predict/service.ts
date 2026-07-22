// 운영 서비스 — 호출 시점 기준으로 알아서 처리 (스펙 5장):
//   ① 과거 미판정일 백필(최근 10거래일) ② 과거·당일 미채점일 채점 ③ 당일 10:30 경과 시 판정.
// KIS 과거 분봉으로 언제든 소급 가능 — 크론이 며칠 죽어도 다음 호출에서 복구된다.

import { PREDICT_CONFIG } from "./config";
import { atrPct } from "./indicators";
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
import {
  countAlertKey, hasJudgment, hasModelRows, lastAlertDateLike, listUnscoredDates, loadAccuracyStats,
  loadAfterPerf, loadDayRow, loadLiveModelPerf, loadRecentDays, loadRescueStats, loadSectorPerf,
  saveJudgment, scoreDay, upsertCheckpointDay, type Revision,
} from "./store";
import { MODEL_LABELS } from "./types";
import type { PredictDailyBar, Verdict } from "./types";

const STREAM_MIN = 8 * 60 + 31; // 08:31부터 체크포인트 스트림 (첫 판정 08:30 완성봉 기준)
const JUDGE_MIN = 14 * 60 + 1; // 14:01 확정 — 모델별 스냅샷(대조군 채점) 기록 (v1.4: 창 09:00~13:59)
const SCORE_MIN = 15 * 60 + 35; // 15:35부터 당일 채점

const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const V_KO: Record<Verdict, string> = { leverage: "레버리지", inverse: "인버스", none: "추세없음" };

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
  const [pre, krxRaw] = await Promise.all([
    fetchNxtPremarket(code, ymd),
    fetchDayMinutes(code, ymd, PREDICT_CONFIG.judgeHour).then(
      (bars) => bars ?? fetchTodayMinutes(code, PREDICT_CONFIG.judgeHour),
    ),
  ]);
  const krx = krxRaw ?? [];
  // 데이터 커버리지 가드 (2026-07-20 실측: 장중 분봉 응답이 호출마다 들쭉날쭉 → 피셔 상태기계가
  // 불가능한 전이(레버리지→없음)로 진동). 정규장 예상 분봉의 80% 미만이면 이번 호출은 판정 생략.
  const expectKrx = Math.min(minuteOfDay, hhmmToMin("14:00") + 1) - 9 * 60 - 1;
  if (expectKrx > 10 && krx.length < expectKrx * 0.8) {
    console.error(`[predict] 분봉 커버리지 부족 (${krx.length}/${expectKrx}) — 이번 호출 판정 생략`);
    return false;
  }
  const acc = await loadAccuracyStats();

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
      });
      const i = outputs.findIndex((o) => o.model === "fisher");
      if (i >= 0) outputs[i] = early;
    } else if (cutHHMM > PREDICT_CONFIG.earlyOffsetUntil) {
      // 본판정 구간도 강돌파 즉시확인 (2026-07-22, 스트림 전용) — 스파이크형 급변 시 8봉 대기 생략
      const late = runFisher(input, { strongBreakRatio: PREDICT_CONFIG.lateStrongBreakRatio });
      const i = outputs.findIndex((o) => o.model === "fisher");
      if (i >= 0) outputs[i] = late;
    }
    const primary = cutHHMM < cfg.earlyModelBefore ? ("user" as const) : undefined;
    const fin = finalizeJudgment(outputs, runEnsemble(outputs, acc), primary);
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

  const smsChange = async (whenLabel: string, prev: Verdict | null, next: { verdict: Verdict; strength: number }) => {
    if (!PREDICT_CONFIG.sms.enabled) return;
    const judge = whenLabel < cfg.earlyModelBefore ? "user" : PREDICT_CONFIG.primaryModel;
    const judgeKo = judge === "user" ? "사용자모델" : "피셔"; // 어떤 모델의 판정인지 명시 (사용자 요청 2026-07-20)
    const hitPct = next.verdict !== "none" ? slotHitPct(whenLabel) : null;
    const similar = next.verdict !== "none" && similarHit !== null && whenLabel >= cfg.earlyModelBefore
      ? `·유사장 적중 ${similarHit}%` : "";
    const tail = `(강도 ${Math.round(next.strength)}%${hitPct !== null ? `·이시각 실측적중 ${hitPct}%` : ""}${similar})`;
    let text = prev === null
      ? `[예측·${judgeKo}] ${whenLabel} 첫 판정: ${V_KO[next.verdict]} ${tail}`
      : `[예측·${judgeKo}] ${whenLabel} 판정 변경: ${V_KO[prev]}→${V_KO[next.verdict]} ${tail}`;
    // 방향 판정이면 자동매도 스탑 금액 동봉 (ruleReminder와 무관 — 실매매 핵심 정보)
    if (next.verdict !== "none") {
      const pct = judge === "user" ? atrStopEtf : PREDICT_CONFIG.stops.fisher.etfPct;
      if (pct !== null) text += await etfStopLine(next.verdict, pct);
    }
    // 규칙 환기 (사용자 지정 2026-07-17 "당분간") — 수익은 적중률이 아니라 규칙에서.
    // 장문(LMS) 전환을 감수하고 동봉. config.sms.ruleReminder=false로 끄면 단문 복귀.
    if (PREDICT_CONFIG.sms.ruleReminder) {
      if (next.verdict !== "none") {
        // 신호 유형별 지침 — 프리장(≤09:00) 피셔F는 ETF 미개장이라 09:00 시가 1/3 선진입,
        // 정규장 피셔는 본진입. 스탑은 공히 ETF -3% (v1.13 — 프리장도 피셔 판정자)
        text += whenLabel <= "09:00"
          ? `\n▶프리장 피셔 신호: ETF 개장(09:00) 후 시가 부근 1/3 선진입 · 스탑 진입가 ETF -3% · 09:30 판정 유지 확인 후 본진입. 당일청산.`
          : `\n▶피셔 확인: 본진입 가능 · 스탑 ETF -3% 고정(역행=확인실패, 즉시 컷) · 당일청산.`;
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
    if (!PREDICT_CONFIG.sms.enabled) return;
    const judgeKo = cp < cfg.earlyModelBefore ? "사용자모델" : "피셔";
    const hitPct = slotHitPct(cp);
    try {
      await dispatchToChannels("signal", today, {
        key: `predict_hold_${sinceCp.replace(":", "")}_${verdict}`,
        severity: "low",
        text: `[예측·${judgeKo}] ${cp} 판정 유지 확인: ${V_KO[verdict]} (${sinceCp}부터 유지 · 강도 ${Math.round(strength)}%·이시각 실측적중 ${hitPct ?? "?"}%)`,
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

  // ②b 피셔F 반전 조기 경보 (2026-07-22 사용자 복기: 본 피셔 13:57 vs 피셔F 12:10 인버스 확인).
  // 224일 실측: 동일 방향 확인 시 피셔F 평균 37분 선행(본 피셔가 13시 이후에야 확인한 날은 80분),
  // 확인시점 진입 캡처 +146.5%p vs 본 피셔 +64.2%p. 단 본 피셔 무판정일의 피셔F 단독 신호는 80%가
  // 손해(과다 판정) — 판정 교체가 아니라 '조기 경보 문자'로만 편입. 본진입 판단은 본 피셔 유지.
  if (minuteOfDay >= hhmmToMin("10:35") && minuteOfDay <= hhmmToMin(lastCp) && revs.length > 0 && PREDICT_CONFIG.sms.enabled) {
    const nowHHMM2 = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const ffBars = krx.filter((b) => b.time < nowHHMM2);
    if (ffBars.length >= 20) {
      const rf = runFisher(
        { date: today, dailyHistory: complete.slice(-120), openPx: krx[0]?.open ?? ffBars[0].open, morning: ffBars, prevDayMinutes: null },
        { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes },
      );
      const curV = revs[revs.length - 1].verdict;
      if (rf.verdict !== "none" && rf.verdict !== curV) {
        try {
          await dispatchToChannels("signal", today, {
            key: `predict_ff_${rf.verdict}`, // 방향별 하루 1회 — 키에 분 금지 (2026-07-20 폭주 사고 원칙)
            severity: "medium",
            text: `[예측·피셔F 임시판정] 조기 반전 감지: ${V_KO[rf.verdict]} — ${rf.reason.split(" — ")[0]}. 본 판정(피셔)은 아직 ${V_KO[curV]} — 임시(저문턱)라 오발 잦음, 확정은 피셔 확인 문자. 무응답=현행 유지`,
            smsSubject: "예측 조기경보",
          });
        } catch { /* 발송 실패 무시 */ }
      }
    }
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
  if (todayBar && minuteOfDay >= STREAM_MIN) {
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
          text: `[예측] 15:10 당일청산 — 보유 ${pos} 매도 시간입니다. 장 마감(15:30) 전 정리. (월~금 고정, 7/21 지시)`,
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
        const sf = (cp: string) => {
          const s = slot.get(cp);
          return s && s.t > 0 ? `${cp} ${Math.round((s.c / s.t) * 100)}%(${s.t})` : `${cp} —`;
        };
        lines.push(`슬롯: ${["09:30", "10:30", "14:00"].map(sf).join("·")}`);
        const [after, sector] = await Promise.all([loadAfterPerf(), loadSectorPerf()]);
        const extra: string[] = [];
        if (after && after.t > 0) extra.push(`애프터 ${Math.round((after.c / after.t) * 100)}%(${after.t})`);
        if (sector && sector.t > 0) extra.push(`섹터 ${Math.round((sector.c / sector.t) * 100)}%(${sector.t})`);
        if (extra.length) lines.push(extra.join("·"));
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

  return result;
}
