// 미장 예측 스트림 서비스 (사용자 지정 2026-07-21 2차: "국장과 동일한 방식") — 한국
// predict 체크포인트 스트림(lib/predict/service.ts checkpointStream)의 미국판.
// 판정자: 프리장(08:30~09:25 ET) = user 모델(RV1+T6) / 정규장(10:00~14:30) = 피셔.
// 상방 = USD(2x) 레버리지 · 하방 = SSG(-2x) 인버스. 상수 근거는 config.usPredict 주석.
// 채점: 정규장 라벨(±0.9% SMH 스케일) + 확정 판정 부호 적중 + 첫 방향 체크포인트 진입 손익.
// 저장: us_predict_days (마이그레이션 029). 트리거: /api/signal/us/state (cron-job.org).

import YahooFinance from "yahoo-finance2";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { atrPct, avgRange } from "@/lib/predict/indicators";
import type { Verdict } from "@/lib/predict/types";
import { US_SIGNAL_CONFIG } from "./config";
import { etNow, fetchSmhDaily } from "./data";
import {
  ET_CLOSE, ET_OPEN, ET_PRE_START, labelUsDay, pnlFromCut, runUsFisher, runUsUserModel, type UsBar,
} from "./models";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const UP = US_SIGNAL_CONFIG.usPredict;

const V_KO: Record<Verdict, string> = { leverage: "레버리지(USD 2x)", inverse: "인버스(SSG -2x)", none: "추세없음" };
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const ALL_CPS: string[] = [...UP.preCheckpoints, ...UP.regCheckpoints];

type Rev = { at: string; checkpoint?: string; verdict: Verdict; strength: number; judge: "user" | "fisher" };
type Row = {
  date: string; final_verdict: Verdict; strength: number; stage: "open" | "final";
  revisions: Rev[] | null; label: Verdict | null; r_oc: number | null;
};

// ── 야후 5분봉 (프리·정규) — ET 변환 (DST 자동)
const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
async function fetchSmh5m(daysBack: number): Promise<Map<string, UsBar[]>> {
  const byDay = new Map<string, UsBar[]>();
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
    const byDay = await fetchSmh5m(daysBack);
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

  const [byDay, daily] = await Promise.all([fetchSmh5m(3), fetchSmhDaily(80)]);
  const bars = byDay.get(today) ?? [];
  const pre = bars.filter((b) => b.etMin >= ET_PRE_START && b.etMin < ET_OPEN);
  const reg = bars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
  const hist = daily.filter((b) => b.date < today).slice(-120);
  const range10 = avgRange(hist, 10);
  const prevClose = hist[hist.length - 1]?.close;
  if (hist.length < 30 || range10 === null || !prevClose) return result;

  const judgeAt = (cut: string): { verdict: Verdict; strength: number; judge: "user" | "fisher" } | null => {
    const cutMin = hhmmToMin(cut);
    if (cut < "09:30") {
      const w = pre.filter((b) => b.etMin + 5 <= cutMin);
      if (w.length < 4) return null;
      const out = runUsUserModel(w, prevClose, { rv1Premarket: UP.rv1Premarket });
      return { verdict: out.verdict, strength: Math.round(out.confidence * 100), judge: "user" };
    }
    const w = reg.filter((b) => b.etMin + 5 <= cutMin);
    if (w.length < 6) return null;
    const out = runUsFisher(w, hist, UP.offsetRangeRatio);
    return { verdict: out.verdict, strength: Math.round(out.confidence * 100), judge: "fisher" };
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

  // 조기(프리장) 신호 스탑 — 한국과 동일 공식: ATR14 × 0.7배(1.5~4% 클램프) → ETF 2배 환산
  const ES = UP.earlyStop;
  const atrToday = atrPct(hist, 14);
  const atrStopEtf = atrToday !== null ? 2 * Math.min(ES.maxPct, Math.max(ES.minPct, ES.k * atrToday)) : null;

  // 시초 레인지 폭 (09:30~09:45 ET) — 유사장 적중·광폭 경고 (한국 orBuckets 규칙의 SMH판)
  const OB = UP.orBuckets;
  const orBars = reg.slice(0, 3);
  const orWidthPct = orBars.length >= 3 && reg[0]?.open
    ? ((Math.max(...orBars.map((b) => b.high)) - Math.min(...orBars.map((b) => b.low))) / reg[0].open) * 100
    : null;
  const similarHit = orWidthPct === null ? null
    : orWidthPct >= OB.wideMinPct ? OB.hit.wide : orWidthPct >= OB.calmBelowPct ? OB.hit.mid : OB.hit.calm;
  const wideOr = orWidthPct !== null && orWidthPct >= OB.wideMinPct;

  const sms = async (whenLabel: string, prev: Verdict | null, v: { verdict: Verdict; strength: number; judge: "user" | "fisher" }, kind: "change" | "hold", sinceCp?: string) => {
    if (!UP.sms.enabled) return;
    const judgeKo = v.judge === "user" ? "사용자모델" : "피셔";
    const hitPct = v.verdict !== "none" ? slotHitPct(whenLabel) : null;
    // 유사장 적중은 정규장(피셔) 컷에만 — 표본 있는 버킷(mid)만 표기 (한국과 동일 위치)
    const similar = v.verdict !== "none" && v.judge === "fisher" && similarHit !== null ? `·유사장 적중 ${similarHit}%` : "";
    const tail = `(강도 ${v.strength}%${hitPct !== null ? `·이시각 실측적중 ${hitPct}%` : ""}${similar})`;
    let text: string;
    if (kind === "hold") {
      text = `[미국예측·${judgeKo}] ${whenLabel} ET 판정 유지 확인: ${V_KO[v.verdict]} (${sinceCp}부터 유지 · 강도 ${v.strength}%${hitPct !== null ? `·이시각 실측적중 ${hitPct}%` : ""})`;
    } else {
      text = prev === null
        ? `[미국예측·${judgeKo}] ${whenLabel} ET 첫 판정: ${V_KO[v.verdict]} ${tail}`
        : `[미국예측·${judgeKo}] ${whenLabel} ET 판정 변경: ${V_KO[prev]}→${V_KO[v.verdict]} ${tail}`;
      // 규칙 환기 — 한국 predict와 동일 체계 (사용자 지정 2026-07-21 3차. LMS 전환 감수,
      // config.usPredict.sms.ruleReminder=false로 끄면 단문 복귀)
      if (UP.sms.ruleReminder) {
        if (v.verdict !== "none") {
          text += v.judge === "user"
            ? `\n▶조기신호: 1/3만 선진입 · 스탑 ETF ${atrStopEtf !== null ? `-${atrStopEtf.toFixed(1)}%` : "ATR 0.7배"}(오늘 ATR 기준) · 10:00 ET 피셔 확인 후 본진입. 16:00 ET 당일청산.`
            : `\n▶피셔 확인: 본진입 가능 · 스탑 ETF -3% 고정(역행=확인실패, 즉시 컷) · 16:00 ET 당일청산.`;
          text += ` 수익은 적중률(${hitPct ?? "?"}%)이 아니라 규칙에서. 미국 소표본 — 소액만.`;
        } else if (prev !== null) {
          text += `\n▶규칙: 방향 소멸 — 보유 중이면 청산 검토. 확정(14:30 ET) 반대 보유 금지.`;
        }
        // 광폭 시초레인지 경고 — SMH 90분위(2.2%) 초과. 유사일 표본 부족(4일)이라 수치 단정 없이
        // 비중 축소만 권장 (한국은 광폭일 적중 급락 43% 실측 — SMH는 라이브 누적으로 확인)
        if (wideOr && v.verdict !== "none" && v.judge === "fisher") {
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
      await dispatchToChannels("signal", today, {
        key, severity: kind === "hold" ? "low" : "medium", text, smsSubject: "미국 예측", suppressSms: quiet,
      });
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
    // 방향 등장·소멸·전환 문자 (첫 기록 '추세없음'은 조용) — 비교 기준은 이번 호출 전 마지막 판정
    if (fin.verdict !== verdictBefore && !(verdictBefore === null && fin.verdict === "none")) {
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
