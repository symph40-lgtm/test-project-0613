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
// 방향 통지 (2026-07-26): ②b 통합 피셔 전이 모니터(F/M/본 전이를 08:25~15:55 ET 전 시간대)가
// 전담 — 체크포인트 스트림 문자는 STREAM_SMS=false로 폐기 (국장 2026-07-23 일원화 관례 이식).

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

// 방향 통지는 ②b SOXX 통합 피셔 전이 모니터가 전담 (이월 지시 2026-07-25 → 07-26 적용 —
// 국장 2026-07-23 "하닉 기존 문자 방식 폐기" 관례의 미국판). 체크포인트 스트림 문자는 폐기,
// 판정 기록·채점·회복·애프터 문자는 유지. 스트림 문자를 되살리려면 true로.
const STREAM_SMS = false;

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

  // ET 시각 한국시간 병기 (사용자 지시 2026-07-26 "미국장 문자는 한국시간 같이 표시") —
  // 현재 KST-ET 오프셋 실계산이라 서머타임(EDT 13h/EST 14h) 자동 반영
  const kstNow = new Date(Date.now() + 9 * 3600e3);
  const etToKst = ((kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes() - minuteOfDay) % 1440 + 1440) % 1440;
  const kstOf = (hhmm: string) => minToHHMM((hhmmToMin(hhmm) + etToKst) % 1440);
  const etk = (hhmm: string) => `${hhmm} ET(한국 ${kstOf(hhmm)})`;
  const headKst = (head: string) => head.replace(/^(\d{2}:\d{2})/, (m) => `${m} ET(한국 ${kstOf(m)})`);

  // SOXX 딥바이 알림 (사용자 확정 2026-08-03 "문자에 붙여줘" — scripts/us-dip-rebound-sweep 실측):
  // 5일 종가 누적 낙폭 ≥15% → 다음날 시가 매수·1일 보유 = 10년 8회·승률 100%·평균 +5.8%(SOXL≈+17%)·
  // 최악 0.0%. 표본 8회(≈15개월에 1회)라 자동 지침 아님 — 마감 후 정보성 통지로 한국 아침 주간거래
  // 판단을 지원 (7/30 사용자 실전 +25%가 이 셀의 실례). 얕은 낙폭(-8~10%)은 에지 없음 실측.
  try {
    if (minuteOfDay >= ET_CLOSE + 5 && minuteOfDay <= 20 * 60) {
      const dly = await fetchJudgeDaily(30);
      const last = dly[dly.length - 1];
      if (last && String(last.date) === today && dly.length >= 6) {
        const ref = dly[dly.length - 6];
        const drop = (last.close / ref.close - 1) * 100;
        if (drop <= -15) {
          await dispatchToChannels("signal", today, {
            key: "uspredict_dipbuy",
            severity: "high",
            text: `[미국예측·SOXX 딥바이] 5일 누적 ${drop.toFixed(1)}% — 급락 반등 조건 도달\n▶오늘 아침 주간거래(또는 오늘 밤 미국 개장가)에 SOXL 매수 검토 — 오늘 밤 미국 세션 반등이 과녁, 내일 아침 청산\n무응답=관망 (자동 지침 아님 — 직접 판단)\n----\n어젯밤 미국 종가 $${last.close.toFixed(2)} (5일 전 $${ref.close.toFixed(2)}). 실측(10년 8회): 승률 100%·평균 SOXX +5.8%(SOXL≈+17%)·최악 0.0%. 표본 8회(약 15개월에 1회) 정보성 통지 — 얕은 낙폭(-8~10%)은 에지 없음. 7/30 실전(SOXL +25%)이 이 유형.`,
            smsSubject: "SOXX 딥바이",
          });
        }
      }
    }
  } catch { /* 정보성 실패는 본 흐름 무관 */ }

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

  // ①b SOXX 피셔W(0.25) 섀도 트래킹 (ops 지시 2026-07-25) — 기록·채점 전용, 문자 없음.
  // 근거: 39일 스윕에서 0.25가 확정 컷 적중 100%(25회) vs 본피셔 0.15 94%(32회) — 소표본이라
  // 라이브 재현 검증. 컷 14:30(확정과 동일), 라벨·채점은 본 스트림과 같은 눈금.
  // 실행 창: 확정 컷+1분 이후 (첫 호출 1회 — 오늘 행 존재 여부로 중복 차단), 과거 결손일도 함께 백필.
  try {
    if (minuteOfDay >= hhmmToMin(UP.finalCp) + 1) {
      const { data: trkRows, error: trkErr } = await admin
        .from("predict_track_days")
        .select("date, labeled_at")
        .eq("symbol", SY.judge).eq("session", "reg").eq("model", "fisherw")
        .order("date", { ascending: false }).limit(1);
      const trkLast = trkRows?.[0] as { date: string; labeled_at: string | null } | undefined;
      const needNew = !trkErr && String(trkLast?.date ?? "") < today; // 오늘 판정 미기록 (+과거 결손 백필)
      const needScore = !trkErr && !!trkLast && !trkLast.labeled_at
        && (String(trkLast.date) < today || minuteOfDay >= ET_CLOSE + 5); // 미채점 잔여
      if (needNew || needScore) {
        const byDayW = await fetchJudge5m(14);
        const dailyW = await fetchJudgeDaily(80);
        for (const [d, bars] of byDayW) {
          if (d > today) continue;
          const reg = bars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
          const w = reg.filter((b) => b.etMin + 5 <= hhmmToMin(UP.finalCp));
          const histW = dailyW.filter((b) => b.date < d).slice(-120);
          if (w.length < 30 || histW.length < 30) continue;
          const { data: ex } = await admin
            .from("predict_track_days").select("date, labeled_at")
            .eq("date", d).eq("symbol", SY.judge).eq("session", "reg").eq("model", "fisherw").maybeSingle();
          if (ex && ex.labeled_at) continue;
          const out = runUsFisher(w, histW, 0.25, {});
          const entry = w[w.length - 1].close;
          const row: Record<string, unknown> = {
            date: d, symbol: SY.judge, session: "reg", model: "fisherw",
            verdict: out.verdict, strength: Math.round(out.confidence * 100), entry_px: entry,
            source: d === today ? "live" : "backfill",
          };
          // 세션 완결 시(과거일 또는 오늘 마감+5분) 라벨·손익까지 한 번에
          if (d < today || minuteOfDay >= ET_CLOSE + 5) {
            if (reg.length >= 60) {
              const { label, rOC } = labelUsDay(reg, UP.label.trendMinPct, UP.label.posUp, UP.label.posDown);
              row.label = label;
              row.r_oc = rOC;
              row.ret_pct = out.verdict !== "none"
                ? Number((((reg[reg.length - 1].close - entry) / entry) * 100 * (out.verdict === "leverage" ? 1 : -1)).toFixed(2))
                : null;
              row.labeled_at = new Date().toISOString();
            }
          }
          await admin.from("predict_track_days").upsert(row, { onConflict: "date,symbol,session,model" });
        }
      }
    }
  } catch (e) {
    console.error("[uspredict] 피셔W 섀도 트래킹 실패 (마이그레이션 031 미적용?):", e);
  }

  // ①c SOXX 애프터장 판정 (사용자 지시 2026-07-25) — 16:00~20:00 ET (KST 05~09시).
  // 피셔 단독·오프셋 = 세션 시가 0.4% (한국 애프터 이식 — config.usPredict.after 근거 참조).
  // 문자: 방향 등장·전환 시 + 19:30 확정 (상태 키 — 세션당 각 1회, dedupHours 16h).
  // 취침(01~07 KST = 16~18 ET)은 dispatch suppressSms로 SMS 억제·이메일만. 기록: predict_track_days.
  try {
    const AH = UP.after;
    if (minuteOfDay >= 16 * 60 + 20 && minuteOfDay <= 20 * 60 + 10) {
      const kstA = new Date(Date.now() + 9 * 3600e3);
      const kstMinA = kstA.getUTCHours() * 60 + kstA.getUTCMinutes();
      const QA = US_SIGNAL_CONFIG.quietSms;
      const quietA = kstMinA >= QA.fromKstMin && kstMinA < QA.toKstMin;
      const byDayA = await fetchJudge5m(5);
      const postOf = (d: string) => (byDayA.get(d) ?? []).filter((b) => b.etMin >= 16 * 60 && b.etMin < 20 * 60);
      // (a) 과거 미채점 애프터 행 라벨링 (야후 5분봉 보존 내 백필)
      try {
        const { data: unl } = await admin
          .from("predict_track_days").select("date, verdict, entry_px")
          .eq("symbol", SY.judge).eq("session", "after").eq("model", "fisher")
          .is("labeled_at", null).lt("date", today).limit(4);
        for (const r of unl ?? []) {
          const bars = postOf(String(r.date));
          if (bars.length < 30) continue;
          const { label, rOC } = labelUsDay(bars, AH.label.trendMinPct, AH.label.posUp, AH.label.posDown);
          const v = r.verdict as Verdict;
          const entry = Number(r.entry_px) || null;
          const ret = v !== "none" && entry
            ? Number((((bars[bars.length - 1].close - entry) / entry) * 100 * (v === "leverage" ? 1 : -1)).toFixed(2))
            : null;
          await admin.from("predict_track_days")
            .update({ label, r_oc: rOC, ret_pct: ret, labeled_at: new Date().toISOString() })
            .eq("date", String(r.date)).eq("symbol", SY.judge).eq("session", "after").eq("model", "fisher");
        }
      } catch { /* 채점 백필 실패는 판정을 막지 않는다 */ }
      // (b) 당일 라이브 판정·문자
      const barsA = postOf(today).filter((b) => b.etMin + 5 <= minuteOfDay);
      const dailyA = await fetchJudgeDaily(80);
      const histA = dailyA.filter((b) => b.date < today).slice(-120);
      const range10A = avgRange(histA, 10);
      if (barsA.length >= AH.orBars + AH.confirmBars && histA.length >= 30 && range10A !== null) {
        const offsetRatio = ((AH.offsetPct / 100) * barsA[0].open) / range10A;
        const out = runUsFisher(barsA, histA, offsetRatio, { confirmBars: AH.confirmBars, orBars: AH.orBars });
        if (out.verdict !== "none") {
          const confT = out.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
          const lagA = confT ? minuteOfDay - hhmmToMin(confT) : 0;
          const staleA = confT !== null && lagA >= 30;
          const isFinal = minuteOfDay >= hhmmToMin(AH.finalCp) + 1;
          const head = isFinal ? `애프터 확정(${etk(AH.finalCp)})` : "애프터";
          // 종료 임박 확인 = 발송 생략 (사용자 실손·지시 2026-07-29): 18:50 ET 확인 문자로 SOXS
          // 진입 → 확인가 483.46이 이미 애프터 하락 소진점, 잔여 70분에 +0.2% 반등 마감 = -3x
          // 실손실. 행동 불가능한 종료 임박(18:30 ET 이후) 신규 확인은 문자 자체를 보내지 않는다
          // ("이런 것은 문자에서 빼줘"). 19:30 확정 문자(채점·기록 기준)만 유지, 기록은 별도 블록.
          const lateConf = confT !== null && hhmmToMin(confT) >= 18 * 60 + 30;
          if (!lateConf || isFinal) {
            const guideA = staleA
              ? `⚠지연 통지(확인 ${etk(confT!)}, ${lagA}분 경과) — 추격 진입 금지, 현재가 기준 판단.`
              : lateConf
                ? `⚠종료 임박 확인(${etk(confT!)}) — 신규 진입 비권장, 기보유만 20:00 ET(한국 ${kstOf("20:00")}) 전 청산.`
                : `▶시간외 유동성 낮음·미검증 이식 상수 — 소액만 · 20:00 ET(한국 ${kstOf("20:00")}) 종료 전 청산.`;
            try {
              await dispatchToChannels("signal", today, {
                key: isFinal ? `uspredict_ah_final_${out.verdict}` : `uspredict_ah_${out.verdict}`,
                severity: "medium",
                text: `[미국예측·${head}] SOXX ${V_KO[out.verdict]} (강도 ${Math.round(out.confidence * 100)}%·라이브 채점 축적 중) — ${headKst(out.reason.split(" — ")[0])} (16~20시 ET·한국 05~09시). ${guideA} 무응답=현행 유지`,
                smsSubject: "미국 애프터",
                suppressSms: quietA,
              }, undefined, undefined, { dedupHours: 16 });
            } catch { /* 발송 실패 무시 */ }
          }
        }
        // 확정 이후 1회 기록 (라벨은 세션 종료 후 (a)에서)
        if (minuteOfDay >= hhmmToMin(AH.finalCp) + 5) {
          const wCut = barsA.filter((b) => b.etMin + 5 <= hhmmToMin(AH.finalCp));
          if (wCut.length >= AH.orBars + AH.confirmBars) {
            const fin = runUsFisher(wCut, histA, offsetRatio, { confirmBars: AH.confirmBars, orBars: AH.orBars });
            const { data: ex } = await admin
              .from("predict_track_days").select("date")
              .eq("date", today).eq("symbol", SY.judge).eq("session", "after").eq("model", "fisher").maybeSingle();
            if (!ex) {
              await admin.from("predict_track_days").upsert({
                date: today, symbol: SY.judge, session: "after", model: "fisher",
                verdict: fin.verdict, strength: Math.round(fin.confidence * 100),
                entry_px: wCut[wCut.length - 1].close, source: "live",
              }, { onConflict: "date,symbol,session,model" });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("[uspredict] 애프터장 판정 실패:", e);
  }

  // ── 공용 분봉·일봉 (②b 전이 모니터 + ② 스트림) — 모니터 창 07:25~15:55 ET 밖이면 종료.
  // 07:25 = 프리장 관찰 시작(07:00)+25분 = 피셔F 최초 확인 가능 시각 (OR 07:00~07:15 + 확인 1봉).
  // ⚠2026-07-27 실사고: 국장 관례 "08:25"를 시각 그대로 이식해 07:25 F 확인이 08:25에야 버스트
  // 통지(60분 지연 태그) — 국장 08:25는 프리장 시작(08:00)+25분이므로 미국 환산은 07:25가 맞다.
  // 15:55 = 정규장 마감 5분 전 (확정 14:30 이후에도 전이 계속 통지).
  if (minuteOfDay < hhmmToMin("07:25") || minuteOfDay > 15 * 60 + 55) return result;
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

  // 시초 레인지 폭 (09:30~09:45 ET) — 비슷한 장세 과거적중·광폭 경고 (한국 orBuckets 규칙의 SMH판)
  const OB = UP.orBuckets;
  const orBars = reg.slice(0, 3);
  const orWidthPct = orBars.length >= 3 && reg[0]?.open
    ? ((Math.max(...orBars.map((b) => b.high)) - Math.min(...orBars.map((b) => b.low))) / reg[0].open) * 100
    : null;
  const similarHit = orWidthPct === null ? null
    : orWidthPct >= OB.wideMinPct ? OB.hit.wide : orWidthPct >= OB.calmBelowPct ? OB.hit.mid : OB.hit.calm;
  const wideOr = orWidthPct !== null && orWidthPct >= OB.wideMinPct;

  // ②b SOXX 통합 피셔 전이 모니터 완전판 (이월 지시 2026-07-25 ①번 — 국장 ②b의 미국판).
  // F·M = 07:00 연속창(프리장 포함) / 본 = 09:30 정규장창 — 조기창 판정자·국장 창 관례와 동일.
  // 문자: 등장·전환·소멸 모든 전이 통지 (전이 키 — 같은 전이 1일 1회, dedup 16h), 취침 SMS 억제.
  // 41일 실측 (scripts/us-transition-monitor-sweep.ts, 2026-07-25):
  //   · 문자량 — 전이 키 적용 평균 4.0/일·최대 7 (F 1.7·M 1.4·본 1.0). 소멸은 구조상 0 (피셔는
  //     확인 후 C반전 외 none 복귀 없음 — 소멸 통지는 데이터 결손 방어용으로만 존재).
  //   · 14:30 이후 본피셔 '등장' 3건 잔여 -3.61/-2.39/+0.04% → 막판 등장은 진입 금지 문구.
  //     '전환' 2건 +0.34/-0.69%p 혼재(소표본) — 청산 검토 문구 유지 (국장 15:25 연장과 동일 취지).
  //   · 추세일 F/M 선행 리드 중앙 90분(21일) — 조기 통지 실익.
  if (UP.sms.enabled) {
    try {
      const contW = [...pre, ...reg].filter((b) => b.etMin + 5 <= minuteOfDay);
      const regW = reg.filter((b) => b.etMin + 5 <= minuteOfDay);
      const F = UP.fisherF, M = UP.fisherM;
      const fO = contW.length >= 5 ? runUsFisher(contW, hist, F.offsetRangeRatio, { confirmBars: F.confirmBars, strongBreakRatio: F.strongBreakRatio }) : null;
      const mO = contW.length >= 5 ? runUsFisher(contW, hist, M.offsetRangeRatio, { confirmBars: M.confirmBars }) : null;
      const bO = regW.length >= 6 ? runUsFisher(regW, hist, UP.offsetRangeRatio, { strongBreakRatio: 0.1 }) : null;
      const curF: Verdict = fO?.verdict ?? "none";
      const curM: Verdict = mO?.verdict ?? "none";
      const curB: Verdict = bO?.verdict ?? "none";
      const lab = (v: Verdict) => (v === "leverage" ? "레버" : v === "inverse" ? "인버" : "없음");
      const px = regW.length ? regW[regW.length - 1].close : contW.length ? contW[contW.length - 1].close : null;
      const stateLine = `\nSOXX: F${lab(curF)}·M${lab(curM)}·본${lab(curB)}${px !== null ? ` ${px.toFixed(2)}$` : ""}`;
      const nowHHMM = minToHHMM(minuteOfDay);
      const statCore = `이 시각대 과거적중 ${slotHitPct(nowHHMM) ?? "?"}%${minuteOfDay >= ET_OPEN && similarHit !== null ? `·비슷한 장세 과거적중 ${similarHit}%` : ""}`;
      const postFinal = minuteOfDay > hhmmToMin(UP.finalCp);
      const orWarn = wideOr ? `\n⚠오늘 시초레인지 ${orWidthPct!.toFixed(1)}% 광폭(90분위 초과) — 유사일 표본 부족, 비중 축소 권장.` : "";

      type UsTrState = { date: string; F: Verdict; M: Verdict; B: Verdict };
      const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "uspredict_tr_state").maybeSingle();
      const prevSt = (stRow?.value ?? null) as UsTrState | null;
      const sameDay = prevSt !== null && prevSt.date === today;
      type Trig = { tier: "F" | "M" | "B"; tierKo: string; prev: Verdict; cur: Verdict; reason: string; strength: number };
      const conf = (o: { confidence: number } | null): number => Math.round((o?.confidence ?? 0.5) * 100);
      const trigs: Trig[] = [
        { tier: "F", tierKo: "피셔F 임시판정", prev: sameDay ? prevSt!.F : "none", cur: curF, reason: fO?.reason ?? "", strength: conf(fO) },
        { tier: "M", tierKo: "피셔M 중간확인", prev: sameDay ? prevSt!.M : "none", cur: curM, reason: mO?.reason ?? "", strength: conf(mO) },
        { tier: "B", tierKo: "본피셔 확정", prev: sameDay ? prevSt!.B : "none", cur: curB, reason: bO?.reason ?? "", strength: conf(bO) },
      ];
      const guideOf = (t: Trig): string => {
        if (t.cur === "none") return "▶해당 단계 비중 축소·청산 검토.";
        if (t.prev !== "none" && t.prev !== t.cur) {
          return postFinal
            ? "▶막판 반전 — 기보유 청산 검토. 신규 전환 진입은 잔여 시간 부족(실측 2건 혼재·소표본) — 비권장."
            : "▶방향 반전 — 기존 포지션 청산 후 반대 방향 1단계(50%)부터.";
        }
        if (postFinal) return `⚠확정(${etk(UP.finalCp)}) 이후 막판 확인 — 실측 3건 잔여 -3.6~+0.0% — 신규 진입 금지, 상태 파악용.`;
        // F 단독(M 미동반) 경고 (2026-07-26 — 7/24 금 프리장 실사고: 08:10 마진 돌파 $0.4를 레버로
        // 확인·스탑컷. 실측(config 주석): M 동반 시 F 적중 97% vs 미동반 50% — 미동반이면 상한 명시)
        if (t.tier === "F") {
          const mWarn = curM !== t.cur ? ` ⚠피셔M 미확인 — F 단독 적중 50%·M 동반 97%(실측). 50% 초과 금지.` : "";
          return `▶1단계: 비중 50%만 진입(초과 금지 — 비중 엄수가 총이익의 원천)·스탑 ETF -${stopEtfPct.toFixed(1)}%. 피셔M 중간확인 대기.${mWarn}`;
        }
        if (t.tier === "M") {
          const warn = curF !== "none" && t.cur !== curF ? " ⚠피셔F와 반대 — F 선진입분 30%p 축소 검토." : "";
          return `▶2단계: +30%p 증액(누적 80% 상한 엄수)·스탑 ETF -${stopEtfPct.toFixed(1)}%.${warn}`;
        }
        return `▶3단계: 잔여 +20%p 본진입(누적 100% 상한 — 초과 신용 금지)·스탑 ETF -${stopEtfPct.toFixed(1)}% 고정·16:00 ET(한국 ${kstOf("16:00")}) 당일청산.`;
      };
      let anyChange = false;
      for (const t of trigs) {
        if (t.cur === t.prev) continue;
        anyChange = true;
        const label = t.prev === "none" ? `${V_KO[t.cur]} 확인` : t.cur === "none" ? `${V_KO[t.prev]} 소멸` : `${V_KO[t.prev]}→${V_KO[t.cur]} 전환`;
        // 지연 통지 가드 (국장 2026-07-23 실사고 이식): 확인 시각과 발송 시각이 30분+ 차이면 진입 지침 대신 경고
        const confT = t.cur !== "none" ? (t.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null) : null;
        const lagMin = confT ? minuteOfDay - hhmmToMin(confT) : 0;
        const stale = confT !== null && lagMin >= 30;
        // 소진 확인 가드 (SOXX 자체 실측 2026-07-25: 기진행 ≥2.5% 확인 16일 잔여 -0.68%·적중 31%)
        let exhaustPct: number | null = null;
        if (!stale && !postFinal && t.tier === "B" && t.cur !== "none" && regW.length >= 6) {
          const closes = regW.map((b) => b.close);
          const lastC = closes[closes.length - 1];
          const ext = t.cur === "inverse" ? Math.max(...closes) : Math.min(...closes);
          const prog = Math.abs(((lastC - ext) / ext) * 100);
          if (prog >= 2.5) exhaustPct = prog;
        }
        const guide = stale
          ? `⚠지연 통지(확인 ${etk(confT!)}, ${lagMin}분 경과) — 추격 진입 금지, 현재가와 다음 전이 문자 기준으로 판단.`
          : exhaustPct !== null
            ? `⚠극값 대비 이미 ${exhaustPct.toFixed(1)}% 진행된 확인 — 추세 소진으로 남은 마진 축소(SOXX 실측 잔여 -0.7%·적중 31%). 추격 진입 금지, 기보유 정리·반등 유의.`
            : guideOf(t);
        const stopLine = !stale && exhaustPct === null && !postFinal && t.cur !== "none" ? await etfStopLine(t.cur) : "";
        try {
          await dispatchToChannels("signal", today, {
            key: `uspredict_tr_${t.tier}_${t.prev}_${t.cur}`,
            severity: t.tier === "B" ? "high" : "medium",
            // 상단=액션만·하단=부연 (사용자 지시 2026-08-01 2차)
            text: `[미국예측·SOXX ${t.tierKo}] ${label}\n${guide}\n무응답=현행 유지\n----\n${t.cur !== "none" && t.reason ? `${headKst(t.reason.split(" — ")[0])} · ` : ""}강도 ${t.strength}%·${statCore}${!stale && t.cur !== "none" ? orWarn : ""}${stopLine}${stateLine}`,
            smsSubject: "미국 예측",
            suppressSms: quiet,
          }, undefined, undefined, { dedupHours: 16 });
        } catch { /* 발송 실패 무시 */ }
      }

      // 판정 후 2봉(5분봉×2=10분) 진행성 문자 (사용자 제안 2026-07-30 밤 "25분 너무 길어" — 5봉→2봉):
      // scripts/progn-us-sweep.ts 실측(~37일 소표본, 기준 0.1×10일폭) — F 2봉: OK 13건 +1.51%·컷23%
      // vs 미달 32건 -0.23%·컷50% (5봉과 동급 이상) / M 2봉: OK 11건 +1.02%·컷36% vs 미달 30건
      // -0.32%·컷47% (방향 일관). 1봉은 미달 평균 +0.08%로 분리 안 됨(기각). 판정 불변 정보 레이어.
      try {
        const r10us = avgRange(hist, 10);
        const usStats: Record<string, { ok: string; bad: string } | null> = {
          F: { ok: "13건: 평균 +1.51%·승률 69%·컷률 23%(소표본)", bad: "32건: 평균 -0.23%·컷률 50%(소표본)" },
          M: { ok: "11건: 평균 +1.02%·승률 55%·컷률 36%(소표본)", bad: "30건: 평균 -0.32%·컷률 47%(소표본)" },
          B: null,
        };
        const usChecks: { tier: "F" | "M" | "B"; tierKo: string; v: Verdict; reason: string; bars: typeof contW }[] = [
          { tier: "F", tierKo: "피셔F", v: curF, reason: fO?.reason ?? "", bars: contW },
          { tier: "M", tierKo: "피셔M", v: curM, reason: mO?.reason ?? "", bars: contW },
          { tier: "B", tierKo: "본피셔", v: curB, reason: bO?.reason ?? "", bars: regW },
        ];
        for (const pc of usChecks) {
          if (pc.v === "none" || pc.bars.length < 2 || r10us === null) continue;
          const confT = pc.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
          if (!confT) continue;
          const tN = hhmmToMin(confT) + 10; // 5분봉 2개
          if (minuteOfDay < tN + 1) continue;
          const confBar = pc.bars.find((b) => b.time === confT);
          const barN = [...pc.bars].reverse().find((b) => b.etMin <= tN);
          if (!confBar || !barN || barN.etMin < tN - 5) continue;
          const dirSgn = pc.v === "leverage" ? 1 : -1;
          const dirKo = pc.v === "leverage" ? "레버" : "인버";
          const prog = (barN.close - confBar.close) * dirSgn;
          const need = 0.1 * r10us;
          const ok = prog >= need;
          const pctS = (v: number) => ((100 * v) / confBar.close).toFixed(1);
          const st = usStats[pc.tier];
          const statTxt = st ? `과거 이 경우 ${ok ? st.ok : st.bad}` : "표본 부족 — 통계 축적 중";
          await dispatchToChannels("signal", today, {
            key: `uspredict_prog2_${pc.tier}_${pc.v}_${confT.replace(":", "")}`,
            severity: ok ? "low" : "medium",
            // 상단=액션만·하단=부연 (사용자 지시 2026-08-01 2차)
            text: ok
              ? `[미국예측·SOXX ${pc.tierKo} 진행확인]\n▶유지 (비중 변경 없음)\n----\n${dirKo} 판정(${etk(confT)} ${confBar.close.toFixed(2)}$) 후 10분 — ${dirKo} 방향으로 ${prog.toFixed(2)}$(${pctS(prog)}%) 전진 → 기준(전진 ${need.toFixed(2)}$=10일평균폭의 10%) 충족, 정상. ${statTxt}.`
              : `[미국예측·SOXX ${pc.tierKo} 진행경보]\n▶해당 단계 비중 축소 검토\n무응답=유지\n----\n${dirKo} 판정(${etk(confT)} ${confBar.close.toFixed(2)}$) 후 10분 — ${prog < 0 ? `판정 방향 반대로 ${(-prog).toFixed(2)}$(${pctS(-prog)}%) 역행` : `전진 ${prog.toFixed(2)}$(${pctS(prog)}%)뿐`} → 기준(전진 ${need.toFixed(2)}$=10일평균폭의 10%) 미달. ${statTxt}.`,
            smsSubject: ok ? "미국 진행확인" : "미국 진행경보",
            suppressSms: quiet,
          }, undefined, undefined, { dedupHours: 16 });
        }
      } catch { /* 진행성 문자 실패는 모니터를 막지 않는다 */ }

      // 09:30창 F 반전경보 (국장 rev9 이식): 본피셔 방향 유지 중 정규장창 피셔F(0.05·1봉·강돌파)가
      // 반대 방향을 확인하면 경보. 07창 F는 프리장 급등락이 OR에 들어간 날 반전을 못 잡음 (국장 근거).
      // SOXX 41일 실측: 발생 3건 — 3건 전부 본피셔 전환을 선행(리드 평균 12분)·선청산 이득 +1.46%p.
      try {
        if (curB !== "none" && regW.length >= 6) {
          const f9 = runUsFisher(regW, hist, F.offsetRangeRatio, { confirmBars: F.confirmBars, strongBreakRatio: F.strongBreakRatio });
          if (f9.verdict !== "none" && f9.verdict !== curB) {
            const confT9 = f9.reason.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
            const lag9 = confT9 ? minuteOfDay - hhmmToMin(confT9) : 0;
            const stale9 = confT9 !== null && lag9 >= 30;
            const guide9 = stale9
              ? `⚠지연 통지(확인 ${etk(confT9!)}, ${lag9}분 경과) — 추격 대응 금지, 현재가와 다음 문자 기준 판단.`
              : `▶보유 축소·청산 검토 — 본피셔 전환 확정 시 반대 진입 (SOXX 실측: 3/3건 본피셔 전환 선행·리드 12분·선청산 +1.46%p).`;
            await dispatchToChannels("signal", today, {
              key: `uspredict_rev9_${curB}_${f9.verdict}`,
              severity: "high",
              text: `[미국예측·SOXX 반전경보] 본피셔 ${V_KO[curB]} 유지 중 — 정규장창 피셔F ${V_KO[f9.verdict]} 확인${confT9 ? `(${etk(confT9)})` : ""}. ${guide9} 무응답=현행 유지${stateLine}`,
              smsSubject: "미국 반전경보",
              suppressSms: quiet,
            }, undefined, undefined, { dedupHours: 16 });
          }
        }
      } catch { /* 경보 실패는 모니터를 막지 않는다 */ }

      // 무추세 확인 문자 (국장 2026-07-25 관례 이식): 방향이 없을 때도 프리장·정규장 각 1회 가동 확인.
      // 모든 단계 없음 + 오늘 방향 이력도 없음일 때만 — 등장·소멸은 전이 문자 전담. 데이터 확보 시에만.
      const allNone = [curF, curM, curB].every((v) => v === "none");
      const prevAllNone = !sameDay || (["F", "M", "B"] as const).every((k) => prevSt![k] === "none");
      if (allNone && prevAllNone) {
        const preWindow = minuteOfDay >= hhmmToMin("08:30") && minuteOfDay < hhmmToMin("09:05") && contW.length >= 5;
        const regWindow = minuteOfDay >= hhmmToMin("10:00") && regW.length >= 5;
        if (preWindow || regWindow) {
          try {
            await dispatchToChannels("signal", today, {
              key: preWindow ? "uspredict_flat_pre" : "uspredict_flat_reg",
              severity: "low",
              text: preWindow
                ? `[미국예측] 프리장 방향 없음 (가동 확인) — SOXX 피셔F 미확인. 방향 확인 시 즉시 문자.${stateLine}`
                : `[미국예측] 정규장 방향 없음 (${etk("10:00")} 확인) — SOXX F/M/본 모두 미확인. 진입 대기, 방향 확인 시 즉시 문자.${stateLine}`,
              smsSubject: "미국 예측",
              suppressSms: quiet,
            }, undefined, undefined, { dedupHours: 16 });
          } catch { /* 발송 실패 무시 */ }
        }
      }
      if (anyChange || !sameDay) {
        await admin.from("ops_settings").upsert(
          { key: "uspredict_tr_state", value: { date: today, F: curF, M: curM, B: curB } satisfies UsTrState },
          { onConflict: "key" },
        );
      }
    } catch (e) {
      console.error("[uspredict] 전이 모니터 실패 (스트림 기록·채점은 계속):", e);
    }
  }

  const sms = async (whenLabel: string, prev: Verdict | null, v: { verdict: Verdict; strength: number; judge: Judge }, kind: "change" | "hold", sinceCp?: string) => {
    if (!STREAM_SMS || !UP.sms.enabled) return;
    const judgeKo = v.judge === "fisherF" ? "피셔F" : v.judge === "user" ? "사용자모델" : "피셔";
    const hitPct = v.verdict !== "none" ? slotHitPct(whenLabel) : null;
    // 비슷한 장세 과거적중은 정규장 컷에만 — 표본 있는 버킷만 표기 (한국과 동일 위치)
    const similar = v.verdict !== "none" && whenLabel >= "09:30" && similarHit !== null ? `·비슷한 장세 과거적중 ${similarHit}%` : "";
    const tail = `(강도 ${v.strength}%${hitPct !== null ? `·이 시각대 과거적중 ${hitPct}%` : ""}${similar})`;
    // 소진 확인 가드 (2026-07-25 — 한국 이식 + SOXX 자체 실측: 기진행 ≥2.5% 확인 16일
    // 잔여 평균 -0.68%·적중 31% vs 그 미만 -0.25%·50%): 방향 확인이 당일 극값 대비 이미 크게
    // 진행된 지점이면 진입 지침 대신 추격 금지 경고.
    let exhaustPct: number | null = null;
    if (kind === "change" && v.verdict !== "none") {
      const closes = reg.filter((b) => b.etMin + 5 <= minuteOfDay).map((b) => b.close);
      if (closes.length >= 6) {
        const lastC = closes[closes.length - 1];
        const ext = v.verdict === "inverse" ? Math.max(...closes) : Math.min(...closes);
        const prog = Math.abs(((lastC - ext) / ext) * 100);
        if (prog >= 2.5) exhaustPct = prog;
      }
    }
    let text: string;
    if (kind === "hold") {
      text = `[미국예측·${judgeKo}] ${whenLabel} ET 판정 유지 확인: ${V_KO[v.verdict]} (${sinceCp}부터 유지 · 강도 ${v.strength}%${hitPct !== null ? `·이 시각대 과거적중 ${hitPct}%` : ""})`;
    } else if (exhaustPct !== null) {
      text = (prev === null
        ? `[미국예측·${judgeKo}] ${whenLabel} ET 첫 판정: ${V_KO[v.verdict]} ${tail}`
        : `[미국예측·${judgeKo}] ${whenLabel} ET 판정 변경: ${V_KO[prev]}→${V_KO[v.verdict]} ${tail}`)
        + ` ⚠극값 대비 이미 ${exhaustPct.toFixed(1)}% 진행된 확인 — 추세 소진으로 남은 마진 축소(SOXX 실측 잔여 -0.7%·적중 31%). 추격 진입 금지, 기보유 정리·반등 유의.`;
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

  // ② 라이브 스트림 (기록·채점 — 문자는 STREAM_SMS=false로 ②b 전담) — 첫 체크포인트+1분 ~ 확정+3분
  if (minuteOfDay < hhmmToMin(ALL_CPS[0]) + 1 || minuteOfDay > hhmmToMin(UP.finalCp) + 3) return result;
  const prior = await loadRow(today);
  if (prior && prior.stage === "final") return result;

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

  // 노이즈컷 회복 문자 (2026-07-25 한국 이식 — predict_recut의 미국판): 판정 방향 유지 중
  // 스탑라인(SOXX -2%) 터치 후 원판정가 종가 회복 시 재진입 검토 1회. 한국 실측 승률 ~50%·
  // 소폭 순익(하닉 +3.5·삼전 +7.2%p) — 미국은 라이브로 보정. 키 = 방향별, dedupHours 16h.
  try {
    const lastV = revs.length ? revs[revs.length - 1].verdict : "none";
    if (lastV !== "none" && UP.sms.enabled) {
      let start = revs.length - 1;
      while (start > 0 && revs[start - 1].verdict === lastV) start--;
      const cutMin = firstDirCutMin(revs.slice(start));
      const entryBar = cutMin !== null ? reg.filter((b) => b.etMin + 5 <= cutMin).pop() : undefined;
      if (entryBar) {
        const entry = entryBar.close;
        const isUp = lastV === "leverage";
        const after = reg.filter((b) => b.etMin > entryBar.etMin && b.etMin + 5 <= minuteOfDay);
        const cutIdx = after.findIndex((b) => (isUp ? b.low <= entry * (1 - UP.stopPct / 100) : b.high >= entry * (1 + UP.stopPct / 100)));
        const rec = cutIdx >= 0 ? after.slice(cutIdx + 1).find((b) => (isUp ? b.close > entry : b.close < entry)) : undefined;
        if (rec) {
          await dispatchToChannels("signal", today, {
            key: `uspredict_recut_${lastV}`,
            severity: "medium",
            text: `[미국예측·회복] 스탑컷 후 원판정가 회복 — ${V_KO[lastV]} 판정 유지 중 (판정가 ${entry.toFixed(2)}$ · 컷 후 ${etk(rec.time)} 회복). ▶동일 방향 추세 지속 — 재진입 검토: 새 진입가 스탑 ETF -${stopEtfPct.toFixed(1)}% 재설정 · 한국 실측 승률 ~50% 이식 — 소액만. 무응답=미진입`,
            smsSubject: "미국 회복",
            suppressSms: quiet,
          }, undefined, undefined, { dedupHours: 16 });
        }
      }
    }
  } catch { /* 회복 문자 실패는 스트림을 막지 않는다 */ }

  // (구 조기경보 — 피셔F 반전·피셔M 중간확인 uspredict_ff/fm/fmopp — 는 2026-07-26 ②b 전이
  // 모니터로 대체 폐기: F·M 전이는 모니터가 전 시간대(08:25~15:55) 통지하고, 반전경보는
  // 정규장창 rev9가 전담한다. 국장 2026-07-23 일원화 관례와 동일.)

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
