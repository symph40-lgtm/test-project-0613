// SOXX 신모델(v2 통합 사양·수정안) 스트림 — 창1(1분 6봉 누적 순전진) 진입 + F(07시창 피셔) 심판
// (사용자 지시 2026-08-03 밤 "신모델 구체적으로 빈틈없이 확인하고 적용").
// 근거 실측 (SOXXM 245일, scripts/soxx-*):
//   창1 선행 186일 수정안(이견 낮 보유·비이견 1박 금지·동의만 1박) +78.2%p — 역진입판 +73.1 대비 +5.1 우위
//   (4d220ca 재확인) · F 선행 59일 E1(F 100% → 창1 반대 시 전환) 1박 +36.2%p (b195960) → 통합 +114.4%p·
//   최악일 -4.1%. 창2(재점화)·창 반대 점화는 전 용도 기각 — 창의 정보는 그날 첫 판정뿐 (4d220ca·4d03194).
// 규칙: 먼저 온 신호 100% 진입(F 프리장 확인은 09:30 개장가) → F선행일만 창1 반대 시 전량 전환 →
//   스탑 SOXX -2%(SOXL/SOXS 3x ≈ -6%) → 동의일(F확인시각 ≥ 창1시각, 동시각 포함)만 1박(다음 세션 시가 청산),
//   그 외 종가(MOC) 청산. 창1 선행일의 F 반대는 낮 행동 없음 — 1박 금지 문지기만 (a24f012 부품 분해).
// 취침 컷오프 (c32f232): F 동의 90%가 ET 10:29(한국 23:29)까지 확인 — 23:30 KST 취침 지침 문자로 마감.
// ⚠문자 시간 정책 (사용자 지시 2026-08-03 밤): 한국 00:00~07:00 문자(SMS) 금지 — 모니터링·기록은 지속,
//   이 창의 이벤트는 이메일만 + 아침(07:00~, 실제 첫 크론 08:00경) 요약 문자 1건으로 합산 발송.
// 일정: newModel.cmpFrom부터 기록·결산 / applyFrom부터 지침 문자 (하닉·삼전 신모델과 공용 게이트).
// 채점: uspredict_v2_scores — 수정안(p)·역진입판(pRe) 병행 (a24f012 권고: 이견 46일 잡음이라 병행 검증).

import YahooFinance from "yahoo-finance2";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "@/lib/predict/config";
import { runFisher } from "@/lib/predict/models/fisher";
import type { MinuteBar, PredictDailyBar } from "@/lib/predict/types";
import { fetchJudgeDaily } from "./predictStream";
import { etNow } from "./data";
import { US_SIGNAL_CONFIG } from "./config";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const SY = US_SIGNAL_CONFIG.usPredict.symbols; // SOXX / SOXL / SOXS / 3x

export const SOXX_ET_OPEN = 570, SOXX_ET_CLOSE = 960, SOXX_ET_PRE = 420;
export const SOXX_STOP_PCT = 2.0; // SOXX 기준 (3x ETF ≈ -6%)

export type SoxxBar = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
export type SoxxJ = { i: number; t: number; dir: 1 | -1; px: number };

const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const bmid = (b: SoxxBar) => (b.open + b.close) / 2;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
// ET 분 → 한국시간 표기 (서머타임 자동 — 현재 시각의 실제 오프셋 사용)
const etToKstLabel = (etMin: number, offsetMin: number) => {
  const k = (etMin + offsetMin + 1440) % 1440;
  return `${fmtT(etMin)} ET(한국 ${fmtT(k)})`;
};

// 눈금 — 백테스트 unitArrL과 동일 (직전 30봉 평균폭 × 0.5, 초기 구간은 10일 일봉폭 폴백)
export function soxxUnitArr(bars: SoxxBar[], fallback: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : fallback;
    return Math.max(u * 0.5, 1e-9);
  });
}

function to5m(bars: SoxxBar[]): SoxxBar[] {
  const map = new Map<number, SoxxBar>();
  for (const b of bars) {
    const k = Math.floor(b.etMin / 5) * 5;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...map.values()].sort((a, b) => a.etMin - b.etMin);
}

// 하루 판정 — 창1(정규장 1분 6봉·tan1.0) + F(07:00~ 5분봉 피셔 첫 전환, 시각 = 확인봉 종료 분)
export function judgeSoxxDay(date: string, raw: SoxxBar[], hist: PredictDailyBar[], r10: number): { c1: SoxxJ | null; fJ: SoxxJ | null } {
  const unit = soxxUnitArr(raw, r10);
  const win = PREDICT_CONFIG.newModel.soxxV2.win - 1; // 6봉 = 5칸
  const tan = PREDICT_CONFIG.newModel.soxxV2.tan;
  let c1: SoxxJ | null = null;
  for (let t = win; t < raw.length && !c1; t++) {
    if (raw[t].etMin < SOXX_ET_OPEN) continue; // 09:30 게이트 (프리장 기여 사실상 0 — 8475009)
    for (const dir of [1, -1] as const) {
      if ((bmid(raw[t]) - bmid(raw[t - win])) * dir >= tan * unit[t - win] * win) { c1 = { i: t, t: raw[t].etMin, dir, px: raw[t].close }; break; }
    }
  }
  let fJ: SoxxJ | null = null;
  const b5 = to5m(raw);
  if (b5.length >= 5) {
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null },
      { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1 });
    const trs = fOut.transitions ?? [];
    if (trs.length) {
      const k5 = b5.findIndex((b) => b.time === trs[0].time);
      if (k5 >= 0) {
        const endMin = b5[k5].etMin + 4;
        let i1 = raw.findIndex((b) => b.etMin >= endMin);
        if (i1 < 0) i1 = raw.length - 1;
        fJ = { i: i1, t: raw[i1].etMin, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px };
      }
    }
  }
  return { c1, fJ };
}

export type SoxxScore = {
  p: number; pRe: number; cut: boolean; kind: "cw" | "f" | "none";
  ovn: boolean; base: number | null; dir: 1 | -1 | null; // 1박 확정용 (다음 세션 시가로 p 재계산)
};

// 하루 채점 — 수정안(p)·역진입판(pRe). nextOpen이 null이면 1박 자격일도 일단 종가로 계산(pend).
export function scoreSoxxDay(raw: SoxxBar[], c1: SoxxJ | null, fJ: SoxxJ | null, close: number, nextOpen: number | null): SoxxScore {
  const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
  if ((!c1 && !fJ) || !reg.length) return { p: 0, pRe: 0, cut: false, kind: "none", ovn: false, base: null, dir: null };
  let cut = false;
  const tranche = (j: SoxxJ, exitPx: number, forceI?: number, forcePx?: number): { pnl: number; base: number } => {
    let i0 = j.i, px = j.px;
    if (raw[j.i].etMin < SOXX_ET_OPEN) { i0 = raw.findIndex((b) => b.etMin >= SOXX_ET_OPEN); px = reg[0].open; }
    if (i0 < 0 || (forceI !== undefined && forceI <= i0)) return { pnl: 0, base: px };
    const s = SOXX_STOP_PCT / 100;
    const lim = forceI ?? raw.length;
    for (let k = i0 + 1; k < lim; k++) {
      if (raw[k].etMin < SOXX_ET_OPEN) continue;
      if (j.dir === 1 ? raw[k].low <= px * (1 - s) : raw[k].high >= px * (1 + s)) { cut = true; return { pnl: -SOXX_STOP_PCT, base: px }; }
    }
    return { pnl: (((forceI !== undefined ? (forcePx ?? close) : exitPx) - px) / px) * 100 * j.dir, base: px };
  };
  const fFirst = fJ && (!c1 || fJ.t < c1.t);
  if (fFirst && fJ) {
    // F 선행일 E1 — 수정안·역진입판 동일 (전환은 이 케이스의 확정 규칙)
    const oppC = c1 && c1.dir !== fJ.dir ? c1 : null;
    const ovnOk = !oppC;
    const exitPx = ovnOk && nextOpen !== null ? nextOpen : close;
    const a = tranche(fJ, exitPx, oppC?.i, oppC?.px);
    const b = oppC ? tranche(oppC, close) : null;
    const p = a.pnl + (b?.pnl ?? 0);
    const lastBase = b ? b.base : a.base;
    const lastDir = oppC ? oppC.dir : fJ.dir;
    return { p, pRe: p, cut, kind: "f", ovn: ovnOk && !cut, base: lastBase, dir: lastDir };
  }
  if (!c1) return { p: 0, pRe: 0, cut: false, kind: "none", ovn: false, base: null, dir: null };
  // 창1 선행일 — 수정안: F 반대여도 낮 보유 유지(스탑만), 1박 자격 = 비이견(동의+무판정 — F확인 ≥ 창1·
  // 동시각 포함 기준). "동의만"으로 좁히면 -2.5%p (4d220ca 기준 +78.2의 정의 = 비이견, 사용자 확인
  // c8c84f5 "비이견 전부 1박 유지"). 실무 취침 문자는 안전하게 동의 확인일만 무행동 1박(c32f232) —
  // 무판정일(3/245)은 MOC 매도되므로 채점 확정치와 미세 괴리 가능(Δ 미미, 페이퍼 대조로 감시).
  const fOpp = fJ && fJ.dir !== c1.dir ? fJ : null;
  const ovnOk = !fOpp;
  const exitPx = ovnOk && nextOpen !== null ? nextOpen : close;
  const a = tranche(c1, exitPx);
  const p = a.pnl;
  const cutMain = cut;
  // 역진입판 (병행 채점 대조): F 반대 시 청산 + F 방향 100% 역진입, 양 레그 종가·1박 자격 동일(비이견)
  cut = false;
  const aRe = tranche(c1, exitPx, fOpp?.i, fOpp?.px);
  const pRe = aRe.pnl + (fOpp ? tranche(fOpp, close).pnl : 0);
  cut = cutMain;
  return { p, pRe, cut: cutMain, kind: "cw", ovn: ovnOk && !cutMain, base: a.base, dir: c1.dir };
}

// ── 라이브 스트림 ──────────────────────────────────────────────────────────

async function fetchSoxx1m(dateEt: string): Promise<SoxxBar[]> {
  const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const out: SoxxBar[] = [];
  try {
    const p1 = new Date(`${dateEt}T00:00:00-04:00`);
    const r = await yf.chart(SY.judge, { period1: p1, period2: new Date(p1.getTime() + 2 * 86400e3), interval: "1m", includePrePost: true });
    for (const q of r.quotes ?? []) {
      if (q.close == null || q.open == null || q.high == null || q.low == null) continue;
      const d = q.date instanceof Date ? q.date : new Date(q.date);
      const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
      if (`${p.year}-${p.month}-${p.day}` !== dateEt) continue;
      const etMin = parseInt(p.hour === "24" ? "0" : p.hour, 10) * 60 + parseInt(p.minute, 10);
      if (etMin < SOXX_ET_PRE || etMin >= SOXX_ET_CLOSE) continue;
      out.push({ etMin, time: fmtT(etMin), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 });
    }
  } catch { /* 야후 실패 — 빈 배열 (이번 호출 생략) */ }
  return out.sort((a, b) => a.etMin - b.etMin);
}

type St = {
  date: string; // ET 세션일
  entryT?: string; entryDir?: "up" | "down"; entryPx?: number; entryKind?: "cw" | "f";
  confT?: string; oppT?: string; revT?: string; revPx?: number; stopT?: string;
  bedDone?: boolean; eodDone?: boolean;
  // 1박 보유 (다음 세션 시가 청산 대기). notify=false는 취침(23:30 KST) 후 늦은 동의 —
  // 실무는 이미 MOC 매도 상태라 청산 문자 생략, 채점만 사양(1박)대로 확정 (컷오프 Δ≈0 실측 c32f232)
  ovn?: { date: string; dir: 1 | -1; px: number; notify?: boolean } | null;
  pendingAm?: string[]; // 00:00~07:00 KST 이벤트 — 아침 요약 문자용
};
type ScoreRow = { date: string; p: number; pRe: number; cut: boolean; kind: "cw" | "f" | "none"; ovn: boolean; pend?: boolean; base?: number; dir?: 1 | -1 };
const DIR_KO = { up: `상승(${SY.leverage} 3x)`, down: `하락(${SY.inverse} 3x)` } as const;

export async function runSoxxV2Monitor(): Promise<void> {
  try {
    const NM = PREDICT_CONFIG.newModel;
    const { date: todayEt, minuteOfDay: etMin } = etNow();
    if (todayEt < NM.cmpFrom) return;
    const kst = new Date(Date.now() + 9 * 3600e3);
    const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const kstOffset = ((kstMin - etMin) + 1440) % 1440; // ET→KST 분 오프셋 (서머타임 자동)
    const live = NM.applyFrom !== "" && todayEt >= NM.applyFrom;
    const quiet = kstMin < 7 * 60; // 한국 00:00~07:00 — SMS 금지 (사용자 지시 8/3 밤)

    const admin = createAdminClient();
    const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "uspredict_v2_state").maybeSingle();
    const prevRaw = (stRow?.value ?? null) as St | null;
    let st: St = prevRaw ?? { date: todayEt };
    let changed = false;
    const save = async () => { await admin.from("ops_settings").upsert({ key: "uspredict_v2_state", value: st, updated_at: new Date().toISOString() }, { onConflict: "key" }); };
    const send = async (key: string, severity: "low" | "medium" | "high", text: string, amLine?: string): Promise<void> => {
      try {
        await dispatchToChannels("signal", todayEt, { key, severity, text, smsSubject: "SOXX 신모델", suppressSms: quiet }, undefined, undefined, { dedupHours: 16 });
        if (quiet && amLine) { st.pendingAm = [...(st.pendingAm ?? []), amLine]; changed = true; }
      } catch { /* 발송 실패 무시 */ }
    };

    // ⓪ 아침 요약 — 밤사이(00~07 KST) 억제된 이벤트를 07:00 이후 첫 크론(평일 08:00경)에서 1건으로
    if (kstMin >= 7 * 60 && kstMin < 12 * 60 && (st.pendingAm?.length ?? 0) > 0) {
      const lines = st.pendingAm!.join("\n");
      st.pendingAm = [];
      changed = true;
      await send("uspredict_v2_am", "medium", `[SOXX 신모델] 밤사이 요약\n${lines}\n----\n00~07시(한국) 문자 금지 시간의 이벤트 합산 통지 (모니터링은 계속 — 사용자 지시 8/3). 상세는 이메일 참조.`);
      await save();
    }

    // 세션 작업 창: ET 평일 09:25~16:10 (크론 커버 22:25~05:05 KST와 일치 — F 프리장 확인은 09:25 감지 시 개장가 지침)
    const etDow = new Date(`${todayEt}T12:00:00Z`).getUTCDay();
    if (etDow < 1 || etDow > 5 || etMin < 565 || etMin > 970) { if (changed) await save(); return; }

    const dailyBars = await fetchJudgeDaily(140);
    const hist = dailyBars.filter((b) => b.date < todayEt).slice(-60);
    if (hist.length < 11) { if (changed) await save(); return; }
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const raw = await fetchSoxx1m(todayEt);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    // 커버리지 가드 — 결손 데이터 오판정 방지 (정규장 경과분의 60% 미만이면 생략)
    const expectReg = Math.min(etMin, SOXX_ET_CLOSE) - SOXX_ET_OPEN - 1;
    if (expectReg > 10 && reg.length < expectReg * 0.6) { if (changed) await save(); return; }

    // 세션 롤오버 — 1박 보유·아침 요약 잔여만 이월
    if (st.date !== todayEt) {
      st = { date: todayEt, ovn: st.ovn ?? null, pendingAm: st.pendingAm ?? [] };
      changed = true;
    }

    // 시범 시작 안내 (applyFrom 첫 세션 09:25~09:40 ET)
    if (live && todayEt === NM.applyFrom && etMin <= 580) {
      await send("uspredict_v2_start", "medium",
        `[SOXX 신모델] 오늘 세션부터 시범 시행\n▶SOXX 매매는 이 문자 기준 — 창1(1분 6봉 모멘텀) 또는 F(피셔) 중 먼저 온 신호로 진입\n▶상방 ${SY.leverage}·하방 ${SY.inverse} (3x) · 스탑 SOXX -2%(ETF -6%)\n▶한국 00~07시엔 문자 없음 — 아침 요약으로 합산 (모니터링은 계속)\n----\n근거 245일: 통합 +114.4%p·최악일 -4.1%(SOXX). 동의일만 1박(다음 세션 시가 청산), 이견·무판정일은 종가(MOC) 청산. 취침(23:30) 지침 문자로 마감.`, undefined);
    }

    // ① 1박 청산 — 전 세션 이월분을 개장 시가로 (22:30 KST — 정상 발송 시간)
    if (st.ovn && reg.length > 0 && etMin >= SOXX_ET_OPEN) {
      const open = reg[0].open;
      const gain = ((open - st.ovn.px) / st.ovn.px) * 100 * st.ovn.dir;
      const nm = st.ovn.dir === 1 ? SY.leverage : SY.inverse;
      try {
        const { data: scRow } = await admin.from("ops_settings").select("value").eq("key", "uspredict_v2_scores").maybeSingle();
        const arr = Array.isArray(scRow?.value) ? (scRow!.value as ScoreRow[]) : [];
        const row = arr.find((s) => s.date === st.ovn!.date && s.pend);
        if (row && row.base && row.dir) {
          const ovnP = ((open - row.base) / row.base) * 100 * row.dir;
          row.p = Math.round(ovnP * 100) / 100;
          row.pRe = Math.round(ovnP * 100) / 100; // 동의일 — 두 판 동일
          row.pend = false;
          await admin.from("ops_settings").upsert({ key: "uspredict_v2_scores", value: arr.slice(-120), updated_at: new Date().toISOString() }, { onConflict: "key" });
        }
      } catch { /* 채점 확정 실패 무시 */ }
      const notifyExit = st.ovn.notify !== false;
      st.ovn = null;
      changed = true;
      if (live && notifyExit) await send("uspredict_v2_ovn_exit", "high",
        `[SOXX 신모델] 1박 청산 시각\n▶① 보유 중인 ${nm} 전량 지금 시장가 매도 (개장 직후)\n▶② 오늘 신호는 별도 문자로 — 매도와 무관하게 대기\n무응답=매도\n----\n전 세션 동의일 1박 종료: 시가 ${open.toFixed(2)} 기준 SOXX ${pct(gain)} (3x ≈ ${pct(gain * 3)}). 1박 규칙 실측: 공통일 +55.1→+75.2%p 개선분의 원천.`,
        `1박 청산 ${etToKstLabel(reg[0].etMin, kstOffset)} SOXX ${pct(gain)}`);
    }

    // ② 판정
    const { c1, fJ } = judgeSoxxDay(todayEt, raw, hist, r10);
    const fFirst = fJ && (!c1 || fJ.t < c1.t);
    const first = fFirst ? fJ : c1;
    const lastPx = raw.length ? raw[raw.length - 1].close : null;

    // ②a 진입 — 먼저 온 신호 100% (F 프리장 확인은 09:30 개장가)
    if (first && !st.entryT) {
      const isPre = raw[first.i].etMin < SOXX_ET_OPEN;
      const entryPx = isPre ? (reg[0]?.open ?? first.px) : first.px;
      st.entryT = fmtT(first.t); st.entryDir = first.dir === 1 ? "up" : "down"; st.entryPx = entryPx; st.entryKind = fFirst ? "f" : "cw";
      changed = true;
      if (live) {
        const nm = first.dir === 1 ? SY.leverage : SY.inverse;
        const stopPx = first.dir === 1 ? entryPx * (1 - SOXX_STOP_PCT / 100) : entryPx * (1 + SOXX_STOP_PCT / 100);
        const lag = etMin - first.t;
        const lagNote = lag >= 30 ? `\n⚠지연 통지(판정 ${st.entryT} ET, ${lag}분 경과) — 진입 금지, 다음 문자 대기` : "";
        await send(`uspredict_v2_entry_${st.entryT.replace(":", "")}`, "high",
          `[SOXX 신모델] ${DIR_KO[st.entryDir]} 진입\n▶① ${nm}를 계좌 배정액의 100% ${isPre && etMin < SOXX_ET_OPEN ? "22:30(한국) 개장가로 매수 예약" : "지금 즉시 매수"} (초과 금지)\n▶② 자동감시 설정: SOXX ${stopPx.toFixed(2)} 이탈(-2%) = ETF 약 -6%에 자동매도\n▶③ 다음 행동은 문자가 지시 — 동의 확인 시 1박, 이견 시 취침 전 MOC 매도 예약${lagNote}\n무응답=진입\n----\n${etToKstLabel(first.t, kstOffset)} ${fFirst ? "F(피셔) 선행 확인" : "창1(6봉 모멘텀) 판정"} @${first.px.toFixed(2)}. 통합 사양 245일 +114.4%p·컷은 예정 비용(-2%).`,
          `진입 ${st.entryT} ET ${DIR_KO[st.entryDir]}`);
      }
    }

    // ②b F선행일 — 창1 반대: 전량 전환 / 창1 동의: 1박 자격
    if (st.entryT && st.entryKind === "f" && fJ && c1 && !st.revT && !st.confT) {
      if (c1.dir !== fJ.dir) {
        st.revT = fmtT(c1.t); st.revPx = c1.px;
        changed = true;
        if (live) {
          const oldNm = fJ.dir === 1 ? SY.leverage : SY.inverse;
          const newNm = c1.dir === 1 ? SY.leverage : SY.inverse;
          const stopPx = c1.dir === 1 ? c1.px * (1 - SOXX_STOP_PCT / 100) : c1.px * (1 + SOXX_STOP_PCT / 100);
          await send(`uspredict_v2_rev_${st.revT.replace(":", "")}`, "high",
            `[SOXX 신모델] 전환 — 창1이 반대 판정\n▶① 보유 ${oldNm} 전량 즉시 매도 (스탑으로 이미 매도됐다면 ②만)\n▶② ${newNm}를 계좌 배정액의 100% 즉시 매수 (초과 금지)\n▶③ 새 자동감시: SOXX ${stopPx.toFixed(2)} 이탈(-2%) · 오늘 1박 금지 — 취침 전 MOC 매도 예약\n무응답=전환\n----\n${etToKstLabel(c1.t, kstOffset)} 창1 @${c1.px.toFixed(2)} — F 선행일 59일 실측: 나중 신호 심판(E1)이 +36.2%p로 우승(E0 +8.7). 반대 판정일은 1박 금지.`,
            `전환 ${st.revT} ET`);
        }
      } else {
        st.confT = fmtT(c1.t);
        changed = true;
        if (live) await send(`uspredict_v2_conf_${st.confT.replace(":", "")}`, "low",
          `[SOXX 신모델] 검증 통과 — 창1 동의 (1박 자격)\n▶행동 없음 — 보유 유지 (매도 금지)\n▶오늘 밤 청산 안 함: 취침 시 무행동 1박, 내일 22:30(한국) 시가 매도\n▶자동감시(-2%)는 그대로 유지\n무응답=보유\n----\n${etToKstLabel(c1.t, kstOffset)} 창1 동의. 동의일 1박 실측: +55.1→+75.2%p (오버나이트 갭이 변동의 절반 — 3276ae7).`,
          `동의 확인 ${st.confT} ET — 1박 자격`);
      }
    }

    // ②c 창1 선행일 — F 동의: 1박 자격 / F 이견: 보유 유지·1박 금지 (수정안 — 낮 행동 없음)
    if (st.entryT && st.entryKind === "cw" && c1 && fJ && fJ.t >= c1.t && !st.confT && !st.oppT) {
      if (fJ.dir === c1.dir) {
        st.confT = fmtT(fJ.t);
        changed = true;
        if (live) await send(`uspredict_v2_conf_${st.confT.replace(":", "")}`, "low",
          `[SOXX 신모델] 검증 통과 — F 동의 (1박 자격)\n▶행동 없음 — 보유 유지 (매도 금지)\n▶오늘 밤 청산 안 함: 취침 시 무행동 1박, 내일 22:30(한국) 시가 매도\n▶자동감시(-2%)는 그대로 유지\n무응답=보유\n----\n${etToKstLabel(fJ.t, kstOffset)} F 동의(동시각 포함 기준). 수익 엔진 = 동의일 113일 당일 +88.0·1박 +105.5%p (c8c84f5).`,
          `동의 확인 ${st.confT} ET — 1박 자격`);
      } else {
        st.oppT = fmtT(fJ.t);
        changed = true;
        if (live) await send(`uspredict_v2_opp_${st.oppT.replace(":", "")}`, "medium",
          `[SOXX 신모델] F 이견 — 보유는 유지, 1박만 금지\n▶① 지금 매도하지 않습니다 — 보유·자동감시(-2%) 유지\n▶② 오늘 1박 금지: 취침 전 MOC(종가) 매도 예약 걸고 취침\n무응답=보유 후 종가 청산\n----\n${etToKstLabel(fJ.t, kstOffset)} F 반대 확인. SOXX 실측(a24f012): 이견일 낮 청산·역진입은 잡음 손해(Δ-3.2/-2.4) — F 반대의 가치는 1박 금지 문지기(최악 -7.7→-4.1). 삼전과 반대 구조.`,
          `F 이견 ${st.oppT} ET — 1박 금지`);
      }
    }

    // 프리장 F 확인일 진입가 보정 — 실제 진입은 09:30 개장가 (백테스트 tranche와 동일 기준)
    if (st.entryT && st.entryKind === "f" && st.entryPx && reg.length > 0) {
      const eMin = parseInt(st.entryT.slice(0, 2), 10) * 60 + parseInt(st.entryT.slice(3, 5), 10);
      if (eMin < SOXX_ET_OPEN && st.entryPx !== reg[0].open) { st.entryPx = reg[0].open; changed = true; }
    }

    // ②d 스탑 감시 — 현재 레그 (창1선행·F선행 공용, 전환 후엔 전환 레그)
    if (st.entryT && st.entryPx && !st.stopT && lastPx !== null) {
      const legDir: 1 | -1 = st.revT ? (c1?.dir ?? 1) : st.entryDir === "up" ? 1 : -1;
      const legPx = st.revT ? (st.revPx ?? st.entryPx) : st.entryPx;
      const legT = st.revT ?? st.entryT;
      const i0 = raw.findIndex((b) => b.time === legT || b.etMin >= parseInt(legT.slice(0, 2), 10) * 60 + parseInt(legT.slice(3, 5), 10));
      if (i0 >= 0) {
        const s = SOXX_STOP_PCT / 100;
        for (let k = i0 + 1; k < raw.length; k++) {
          if (raw[k].etMin < SOXX_ET_OPEN) continue;
          if (legDir === 1 ? raw[k].low <= legPx * (1 - s) : raw[k].high >= legPx * (1 + s)) {
            st.stopT = raw[k].time;
            changed = true;
            if (live) await send(`uspredict_v2_stop_${st.stopT.replace(":", "")}`, "medium",
              `[SOXX 신모델] 스탑 도달\n▶자동매도 체결 확인만 — 오늘 다시 매수하지 않습니다 (1박도 없음)\n무응답=현행 유지\n----\n${etToKstLabel(raw[k].etMin, kstOffset)} 진입가 대비 SOXX -2%(ETF -6%). 컷일 21/245(8.6%) — 예정 비용.`,
              `스탑 ${st.stopT} ET`);
            break;
          }
        }
      }
    }

    // ③ 취침 지침 (23:30~23:59 KST — F 동의 90%가 23:29까지 확인되는 실측에 맞춘 마감 통지)
    if (live && !st.bedDone && kstMin >= 23 * 60 + 30 && st.entryT) {
      st.bedDone = true;
      changed = true;
      const ovnOk = !!st.confT && !st.stopT;
      const holding = !st.stopT;
      const gain = lastPx !== null && st.entryPx ? ((lastPx - (st.revPx ?? st.entryPx)) / (st.revPx ?? st.entryPx)) * 100 * (st.revT ? (c1?.dir ?? 1) : st.entryDir === "up" ? 1 : -1) : null;
      await send("uspredict_v2_bed", "medium",
        ovnOk
          ? `[SOXX 신모델] 취침 지침 — 무행동 1박\n▶① 아무것도 하지 않고 취침 (매도 예약 걸지 않음)\n▶② 자동감시(-2%)만 유지 — 주간거래 포함 24시간 감시 가능 종목\n▶③ 내일 22:30(한국) 개장 시가 매도 — 문자로 다시 지시\n무응답=1박\n----\n동의일 1박 규칙. 현재 미실현 SOXX ${gain !== null ? pct(gain) : "—"}. 취침 컷오프 실측: 23:00~01:00 어디서 끊어도 손실 없음(c32f232).`
          : holding
            ? `[SOXX 신모델] 취침 지침 — 오늘은 종가 청산\n▶① 취침 전 MOC(종가) 매도 예약 설정\n▶② 자동감시(-2%)는 예약과 별개로 유지\n무응답=MOC 예약 필요 (이견·무판정일 1박 금지)\n----\n${st.oppT ? "F 이견일" : "F 무판정일"} — 1박 자격 없음. 현재 미실현 SOXX ${gain !== null ? pct(gain) : "—"}.`
            : `[SOXX 신모델] 취침 지침 — 보유 없음\n▶행동 없음 (스탑으로 종료된 날)\n----\n오늘 매매 종료.`,
        undefined);
    }

    // ④ 결산 (16:01 ET 이후 1회 = 한국 05:01 — 문자 억제 창이라 이메일+아침 요약으로 전달)
    if (!st.eodDone && etMin >= 961 && reg.length > 0) {
      const close = reg[reg.length - 1].close;
      const sc = scoreSoxxDay(raw, c1, fJ, close, null);
      st.eodDone = true;
      if (sc.ovn && sc.base && sc.dir) {
        // 취침(10:30 ET = 23:30 KST) 이전 동의 = 무행동 1박 상태 → 다음 세션 청산 문자 발송.
        // 그 후 동의(실측 ~10%)는 실무상 MOC 매도됨 — 문자 생략, 채점만 1박 확정.
        const confMin = st.confT ? parseInt(st.confT.slice(0, 2), 10) * 60 + parseInt(st.confT.slice(3, 5), 10) : null;
        st.ovn = { date: todayEt, dir: sc.dir, px: sc.base, notify: confMin !== null && confMin <= 630 };
      }
      changed = true;
      try {
        const { data: scRow } = await admin.from("ops_settings").select("value").eq("key", "uspredict_v2_scores").maybeSingle();
        const arr = (Array.isArray(scRow?.value) ? (scRow!.value as ScoreRow[]) : []).filter((s) => s.date !== todayEt);
        arr.push({ date: todayEt, p: Math.round(sc.p * 100) / 100, pRe: Math.round(sc.pRe * 100) / 100, cut: sc.cut, kind: sc.kind, ovn: sc.ovn, ...(sc.ovn ? { pend: true, base: sc.base ?? undefined, dir: sc.dir ?? undefined } : {}) });
        const kept = arr.slice(-120);
        await admin.from("ops_settings").upsert({ key: "uspredict_v2_scores", value: kept, updated_at: new Date().toISOString() }, { onConflict: "key" });
        const sum = (f: (s: ScoreRow) => number) => kept.reduce((a, s) => a + f(s), 0);
        const phase = live ? "시범" : "검증(페이퍼)";
        await send("uspredict_v2_eod", "low",
          `[SOXX 신모델 결산] ${phase} — 오늘 수정안 ${pct(sc.p)} · 역진입판 ${pct(sc.pRe)}${st.entryT ? ` (진입 ${st.entryT}${st.revT ? `·전환 ${st.revT}` : ""}${st.stopT ? `·스탑 ${st.stopT}` : ""}${sc.ovn ? "·1박 중" : ""})` : " (판정 없음)"}\n----\n누적 ${kept.length}일: 수정안 ${pct(sum((s) => s.p))} · 역진입판 ${pct(sum((s) => s.pRe))}. 백테스트 궤도 일당 +0.47%(SOXX·3x 환산 +1.4%). 1박 자격일은 다음 세션 시가로 확정치 갱신. 산식: 스탑 -2%·수수료 미차감(편도 0.07%).`,
          `결산 수정안 ${pct(sc.p)}${sc.ovn ? " (1박 중)" : ""}`);
      } catch { /* 채점 실패는 상태 저장 무관 */ }
    }

    if (changed || !prevRaw) await save();
  } catch { /* SOXX 신모델 스트림 실패는 본 흐름을 막지 않는다 */ }
}
