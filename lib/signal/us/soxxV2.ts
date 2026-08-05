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

// ETF 환산 스탑가 힌트 (사용자 지시 8/5 밤 "문자대로 할 테니 정량·명확하게") — 발송 시점 ETF 시세로
// SOXX 스탑 거리(×3)를 환산한 근사 가격. 시세 실패 시 빈 문자열 (본문 % 기준은 항상 존재).
async function etfStopHint(ticker: string, soxxNow: number, soxxStop: number): Promise<string> {
  try {
    const q = await yf.quote(ticker);
    const px = q.regularMarketPrice ?? q.preMarketPrice ?? q.postMarketPrice;
    if (!px || !soxxNow) return "";
    const etfStop = px * (1 - 3 * Math.abs(soxxNow - soxxStop) / soxxNow);
    return ` = ${ticker} 약 $${etfStop.toFixed(2)}`;
  } catch { return ""; }
}

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

// 하루 판정 — 창1(정규장 1분 6봉·tan1.0) + F(07:00~ 5분봉 피셔 첫 전환, 시각 = 확인봉 종료 분).
// rebox: 프리장(07시) OR을 정규장에 그대로 쓰는 문제(사용자 지적 8/4 — 진폭 괴리)의 교정 —
// 09:30~45 박스 완성 후 앵커만 교체·상태 승계 (하닉·삼전 채택 방식). 245일 +114.4→+117.8%p·
// 최악/컷 불변·F 판정 변화 15일 (scripts/soxx-f-rebox-sweep.ts. 10:00 재박스 +116.2 열위).
// ⚠07시 창 자체는 유지 — 04~07시는 박봉·역예측(models.ts ET_PRE_START 실측), 정규장 새 창은 -2.5 붕괴.
export function judgeSoxxDay(date: string, raw: SoxxBar[], hist: PredictDailyBar[], r10: number, rebox?: { reboxHHMM: string; reboxMinutes: number } | null): { c1: SoxxJ | null; fJ: SoxxJ | null } {
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
      { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1, ...(rebox ?? {}) });
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
  protT: number | null; // 이익 보호 청산 발동 시각 (etMin) — protect=true일 때만
};

// 하루 채점 — 수정안(p)·역진입판(pRe). nextOpen이 null이면 1박 자격일도 일단 종가로 계산(pend).
// protect: 인버스 진입 레그 한정 이익 보호 청산 (config.newModel.soxxV2.protect — 8/4 채택, 스윕 +130.9).
// preEntry: F 프리장 확인 시 확인가 즉시 진입·스탑은 정규장부터 (사용자 지시 8/5 "프리장 직접 매수" —
// soxx-pre-entry-sweep 246일: 개장가 대기 +130.9 → 확인가 진입+정규장 스탑 +141.6·컷 32·최악 불변.
// 프리장 스탑 포함은 +126.3 열위 — 프리장 구간은 스탑 없음이 사양).
export function scoreSoxxDay(raw: SoxxBar[], c1: SoxxJ | null, fJ: SoxxJ | null, close: number, nextOpen: number | null, protect = false, preEntry = false): SoxxScore {
  const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
  if ((!c1 && !fJ) || !reg.length) return { p: 0, pRe: 0, cut: false, kind: "none", ovn: false, base: null, dir: null, protT: null };
  const PR = PREDICT_CONFIG.newModel.soxxV2.protect;
  let cut = false;
  let protT: number | null = null;
  let protectOn = protect; // pRe(역진입판 대조)는 보호 없이 계산 — 패스별 토글
  const tranche = (j: SoxxJ, exitPx: number, forceI?: number, forcePx?: number): { pnl: number; base: number } => {
    let i0 = j.i, px = j.px;
    if (!preEntry && raw[j.i].etMin < SOXX_ET_OPEN) { i0 = raw.findIndex((b) => b.etMin >= SOXX_ET_OPEN); px = reg[0].open; }
    if (i0 < 0 || (forceI !== undefined && forceI <= i0)) return { pnl: 0, base: px };
    const s = SOXX_STOP_PCT / 100;
    const lim = forceI ?? raw.length;
    let ext = px; // 유리 극값 (보호 규칙용)
    for (let k = i0 + 1; k < lim; k++) {
      const b = raw[k];
      if (b.etMin < SOXX_ET_OPEN) continue;
      if (j.dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) { cut = true; return { pnl: -SOXX_STOP_PCT, base: px }; }
      if (protectOn && j.dir === -1) {
        ext = Math.min(ext, b.low);
        const armGain = ((px - ext) / px) * 100;
        if (b.etMin <= PR.untilEt && armGain >= PR.arm) {
          const retr = ((b.close - ext) / px) * 100;
          if (retr >= PR.trail) { protT = b.etMin; return { pnl: ((px - b.close) / px) * 100, base: px }; }
        }
      }
    }
    return { pnl: (((forceI !== undefined ? (forcePx ?? close) : exitPx) - px) / px) * 100 * j.dir, base: px };
  };
  const fFirst = fJ && (!c1 || fJ.t < c1.t);
  if (fFirst && fJ) {
    // F 선행일 E1 — 보호 제외 시 수정안·역진입판 동일 (전환은 이 케이스의 확정 규칙)
    const oppC = c1 && c1.dir !== fJ.dir ? c1 : null;
    const ovnOk = !oppC;
    const exitPx = ovnOk && nextOpen !== null ? nextOpen : close;
    const a = tranche(fJ, exitPx, oppC?.i, oppC?.px);
    const b = oppC ? tranche(oppC, close) : null;
    const p = a.pnl + (b?.pnl ?? 0);
    const cutMain = cut;
    const protMain = protT;
    // pRe = 보호 없는 판 (대조)
    cut = false; protT = null; protectOn = false;
    const aN = tranche(fJ, exitPx, oppC?.i, oppC?.px);
    const pRe = aN.pnl + (oppC ? tranche(oppC, close).pnl : 0);
    cut = cutMain; protT = protMain;
    const lastBase = b ? b.base : a.base;
    const lastDir = oppC ? oppC.dir : fJ.dir;
    return { p, pRe, cut: cutMain, kind: "f", ovn: ovnOk && !cutMain && protT === null, base: lastBase, dir: lastDir, protT };
  }
  if (!c1) return { p: 0, pRe: 0, cut: false, kind: "none", ovn: false, base: null, dir: null, protT: null };
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
  const protMain = protT;
  // 역진입판 (병행 채점 대조): F 반대 시 청산 + F 방향 100% 역진입, 양 레그 종가·1박 자격 동일(비이견)·보호 없음
  cut = false; protT = null; protectOn = false;
  const aRe = tranche(c1, exitPx, fOpp?.i, fOpp?.px);
  const pRe = aRe.pnl + (fOpp ? tranche(fOpp, close).pnl : 0);
  cut = cutMain; protT = protMain;
  return { p, pRe, cut: cutMain, kind: "cw", ovn: ovnOk && !cutMain && protT === null, base: a.base, dir: c1.dir, protT };
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
      if (etMin < 240 || etMin >= SOXX_ET_CLOSE) continue; // 04:00부터 수집 (프리장 브리핑용 — 판정 입력은 호출부에서 07:00~로 재필터)
      out.push({ etMin, time: fmtT(etMin), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 });
    }
  } catch { /* 야후 실패 — 빈 배열 (이번 호출 생략) */ }
  return out.sort((a, b) => a.etMin - b.etMin);
}

type St = {
  date: string; // ET 세션일
  entryT?: string; entryDir?: "up" | "down"; entryPx?: number; entryKind?: "cw" | "f";
  confT?: string; oppT?: string; revT?: string; revPx?: number; stopT?: string;
  protT?: string; // 이익 보호 청산 (인버스 한정 — 8/4 채택)
  preBriefDone?: boolean; // 프리장 개시 브리핑 (17:30 KST — 8/5 지시)
  bedDone?: boolean; eodDone?: boolean;
  // 1박 보유 (다음 세션 시가 청산 대기). notify=false는 취침(23:30 KST) 후 늦은 동의 —
  // 실무는 이미 MOC 매도 상태라 청산 문자 생략, 채점만 사양(1박)대로 확정 (컷오프 Δ≈0 실측 c32f232)
  ovn?: { date: string; dir: 1 | -1; px: number; notify?: boolean } | null;
  ovnChk?: string[]; // 1박 세션 전환 체크포인트 발송 기록 (사용자 지시 8/6 새벽 "장 바뀌는 순간 재점검")
  pendingAm?: string[]; // 00:00~07:00 KST 이벤트 — 아침 요약 문자용
};
// p·pRe = rebox판(주기준) 수정안·역진입판 / pV0 = 무rebox 대조 (사용자 지적 8/4 후 rebox 채택 —
// 60일 페이퍼로 rebox 우위(+3.4) 라이브 재현 확인용). pend*는 1박일 다음 세션 시가 확정용.
type ScoreRow = {
  date: string; p: number; pRe: number; pV0: number; pNP?: number; cut: boolean; kind: "cw" | "f" | "none"; ovn: boolean;
  pend?: boolean; base?: number; dir?: 1 | -1; pendV0?: boolean; baseV0?: number; dirV0?: 1 | -1;
};
const DIR_KO = { up: `상승(${SY.leverage} 3x)`, down: `하락(${SY.inverse} 3x)` } as const;

export async function runSoxxV2Monitor(): Promise<void> {
  try {
    const NM = PREDICT_CONFIG.newModel;
    const { date: todayEt, minuteOfDay: etMin } = etNow();
    if (todayEt < NM.cmpFrom) return;
    const kst = new Date(Date.now() + 9 * 3600e3);
    const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const kstOffset = ((kstMin - etMin) + 1440) % 1440; // ET→KST 분 오프셋 (서머타임 자동)
    const applyFrom = NM.soxxApplyFrom !== "" ? NM.soxxApplyFrom : NM.applyFrom; // SOXX 조기 시작 (8/4)
    const live = applyFrom !== "" && todayEt >= applyFrom;
    const quiet = kstMin < 7 * 60; // 한국 00:00~07:00 — SMS 금지 (사용자 지시 8/3 밤)

    const admin = createAdminClient();
    const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "uspredict_v2_state").maybeSingle();
    const prevRaw = (stRow?.value ?? null) as St | null;
    let st: St = prevRaw ?? { date: todayEt };
    let changed = false;
    const save = async () => { await admin.from("ops_settings").upsert({ key: "uspredict_v2_state", value: st, updated_at: new Date().toISOString() }, { onConflict: "key" }); };
    // forceSms: 00~07 금지창 예외 (사용자 명시 지시 8/6 — 세션 전환 10분 전 경보는 04:50에도 SMS)
    const send = async (key: string, severity: "low" | "medium" | "high", text: string, amLine?: string, forceSms = false): Promise<void> => {
      try {
        await dispatchToChannels("signal", todayEt, { key, severity, text, smsSubject: "SOXX 신모델", suppressSms: quiet && !forceSms }, undefined, undefined, { dedupHours: 16 });
        if (quiet && !forceSms && amLine) { st.pendingAm = [...(st.pendingAm ?? []), amLine]; changed = true; }
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

    // ⓪c 세션 전환 10분 전 경보 (사용자 지시 8/6 "장이 바뀌기 10분 전에 문자 — 블루오션·프리·정규·애프터".
    // 배경 가설: 급등(+5%) 상태에서 세션 전환 시 하락 취약 — 8/4 밤·8/5 프리장 실사례. 가설은 BAQ 분봉
    // 축적 후 실측 검증 예정, 그 전까지 정보+재량 선택지 제공). 포지션(1박 또는 당일 보유) 있을 때만.
    // 04:50은 00~07 금지창이지만 명시 지시로 SMS 예외(forceSms).
    const intradayHolding = !!st.entryT && !st.stopT && !st.protT && !st.eodDone;
    if ((st.ovn || intradayHolding) && live) {
      const kstDate = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const CHK: [number, number, string, string, boolean][] = [
        [4 * 60 + 50, 4 * 60 + 59, "0450", "10분 후 05:00 정규장 마감·애프터 개시", true],
        [8 * 60 + 50, 8 * 60 + 59, "0850", "10분 후 09:00 블루오션(한국 낮) 개시", false],
        [16 * 60 + 50, 16 * 60 + 59, "1650", "10분 후 17:00 프리장 개시", false],
        [22 * 60 + 20, 22 * 60 + 29, "2220", "10분 후 22:30 정규장 개장", false],
      ];
      const hit = CHK.find(([a, b]) => kstMin >= a && kstMin <= b);
      const code = hit ? `${kstDate}-${hit[2]}` : null;
      if (hit && code && !(st.ovnChk ?? []).includes(code)) {
        try {
          const q = await yf.quote(SY.judge);
          const px = q.postMarketPrice ?? q.preMarketPrice ?? q.regularMarketPrice;
          const prevC = q.regularMarketPreviousClose ?? null;
          if (px) {
            // 레그별 분리 표기 (8/5 밤 실사고 교정: 어제 1박 SOXL + 오늘 신규 SOXS 병존 구간에서
            // "보유 SOXL 유지" 한 줄만 나가 SOXS 지침과 모순처럼 읽힘 — 두 레그를 각각 명시)
            const legs: string[] = [];
            let gMax = -Infinity;
            if (st.ovn) {
              const nmO = st.ovn.dir === 1 ? SY.leverage : SY.inverse;
              const gO = ((px - st.ovn.px) / st.ovn.px) * 100 * st.ovn.dir;
              gMax = Math.max(gMax, gO);
              legs.push(`[어제 1박 ${nmO}] 22:30(한국) 개장 시가 전량 매도 예정 — 그때까지 보유 · 재난선 SOXX ${(st.ovn.px * (st.ovn.dir === 1 ? 0.95 : 1.05)).toFixed(2)} (현재 ${pct(gO)})`);
            }
            const intraday = !!st.entryT && !st.stopT && !st.protT;
            if (intraday) {
              // 전환(rev) 레그 방향 = 원 진입의 반대 (이 블록은 판정(c1) 계산 전에 실행됨)
              const dirI: 1 | -1 = st.revT ? (st.entryDir === "up" ? -1 : 1) : st.entryDir === "up" ? 1 : -1;
              const pxI = st.revPx ?? st.entryPx ?? px;
              const nmI = dirI === 1 ? SY.leverage : SY.inverse;
              const gI = ((px - pxI) / pxI) * 100 * dirI;
              gMax = Math.max(gMax, gI);
              const stopI = (pxI * (dirI === 1 ? 0.98 : 1.02)).toFixed(2);
              legs.push(`[오늘 ${nmI}] 보유 유지 (현재 ${pct(gI)}) — ${hit[2] === "2220" ? `개장 직후 자동스탑설정: SOXX ${stopI}(-2%)` : `자동스탑설정 SOXX ${stopI} 유지`}`);
            }
            if (!legs.length) legs.push("보유 없음 — 행동 없음");
            const gC = prevC !== null ? Math.abs(((px - prevC) / prevC) * 100) : null;
            const hot = gMax >= 5; // 급등 상태 — 사용자 관찰 경고
            st.ovnChk = [...(st.ovnChk ?? []), code];
            changed = true;
            await send(`uspredict_v2_chg_${hit[2]}`, hot ? "medium" : "low",
              `[SOXX 신모델] 세션 전환 예고 — ${hit[3]}\n${legs.map((l) => `▶${l}`).join("\n")}\n${hot ? `▶⚠급등 상태(${pct(gMax)})에서 세션 전환 — 관찰상 하락 취약 구간(가설·검증 전). 이익을 지키려면 지금 시장가 매도(재량·기록상 규칙 이탈)\n` : ""}무응답=위 규칙대로\n----\n현재 SOXX ${px.toFixed(2)}${gC !== null ? ` · 전일 종가 대비 ${prevC !== null && px >= prevC ? "+" : "-"}${gC.toFixed(2)}%` : ""}. 전환-하락 가설은 밤 분봉(BAQ) 축적 후 실측 판정 — 그 전까지 시가 청산이 검증 사양(1박 기여 +53.3%p/246일).`,
              `세션 전환 예고 ${hit[2]}`, hit[4]);
            await save();
          }
        } catch { /* 시세 실패 — 다음 분에 재시도 (기록 미저장) */ }
      }
    }

    // 세션 작업 창: ET 평일 04:30~16:10 (사용자 지시 8/5 "17:30부터 모니터" — 04:30 ET=17:30 KST).
    // 04:30~07:00은 프리장 개시 브리핑·시세 관찰만 — 판정(F 창)은 07:00부터 원칙 유지(04~07시 박봉·
    // 역예측 실측, 방향 오판 5/19일). 실시간 수신은 cron-job.org 호출 시작을 17:30 KST로 당겨야 완성.
    const etDow = new Date(`${todayEt}T12:00:00Z`).getUTCDay();
    if (etDow < 1 || etDow > 5 || etMin < 270 || etMin > 970) { if (changed) await save(); return; }

    const dailyBars = await fetchJudgeDaily(140);
    const hist = dailyBars.filter((b) => b.date < todayEt).slice(-60);
    if (hist.length < 11) { if (changed) await save(); return; }
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    // 완성봉만 판정 (8/4 실사고 교정: 22:30:33 크론이 30초짜리 09:30 진행중 봉으로 창1 '하락' 오판 →
    // 가짜 전환 문자. 확정 데이터는 09:34 상승 동의. 백테스트=완성봉 원칙을 라이브에도 강제 —
    // 현재 분(etMin)의 봉은 아직 미완성이라 제외)
    const rawAll = (await fetchSoxx1m(todayEt)).filter((b) => b.etMin < etMin); // 04:00~ (브리핑용)
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE); // 판정 입력은 07:00~ 원칙 유지
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    // 커버리지 가드 — 결손 데이터 오판정 방지 (정규장 경과분의 60% 미만이면 생략)
    const expectReg = Math.min(etMin, SOXX_ET_CLOSE) - SOXX_ET_OPEN - 1;
    if (expectReg > 10 && reg.length < expectReg * 0.6) { if (changed) await save(); return; }

    // 세션 롤오버 — 1박 보유·아침 요약 잔여만 이월
    if (st.date !== todayEt) {
      st = { date: todayEt, ovn: st.ovn ?? null, pendingAm: st.pendingAm ?? [] };
      changed = true;
    }

    // ⓪b 프리장 개시 브리핑 (사용자 지시 8/5 "17:30부터 모니터해줘" — 04:30~07:00 ET는 판정이 없는
    // 저유동 구간이라 상황판·1박 보유 안내만. 판정 문자는 F 창이 열리는 20:00부터)
    if (live && etMin >= 270 && etMin < SOXX_ET_PRE && !st.preBriefDone && rawAll.length > 0) {
      st.preBriefDone = true;
      changed = true;
      const px = rawAll[rawAll.length - 1].close;
      const prevC = hist[hist.length - 1].close;
      const gap = ((px - prevC) / prevC) * 100;
      const ovnG = st.ovn ? ((px - st.ovn.px) / st.ovn.px) * 100 * st.ovn.dir : null;
      const ovnLine = st.ovn ? `\n▶1박 보유 ${st.ovn.dir === 1 ? SY.leverage : SY.inverse}: 현재 ${ovnG !== null ? pct(ovnG) : "—"}(진입가 ${st.ovn.px.toFixed(2)} 대비) — 22:30(한국) 개장 시가 전량 매도 예정 · 재난선 SOXX ${(st.ovn.px * (st.ovn.dir === 1 ? 0.95 : 1.05)).toFixed(2)} 유지` : "";
      await send("uspredict_v2_pre", "low",
        `[SOXX 신모델] 프리장 개시 브리핑\n▶행동 없음 — 모델 판정은 한국 20:00(F 창 개시)부터 문자로 지시${ovnLine}\n무응답=대기\n----\n전일 종가 ${prevC.toFixed(2)} → 프리장 ${px.toFixed(2)} (${pct(gap)}). 04:30~07:00 ET(한국 17:30~20:00)는 저유동 구간 — 판정 무효 실측(방향 오판 5/19일), 시세 참고만.`);
    }

    // 시범 시작 안내 (applyFrom 첫 세션 09:25~09:40 ET)
    if (live && todayEt === applyFrom && etMin <= 580) {
      await send("uspredict_v2_start", "medium",
        `[SOXX 신모델] 오늘 세션부터 시범 시행\n▶SOXX 매매는 이 문자 기준 — 창1(1분 6봉 모멘텀) 또는 F(피셔) 중 먼저 온 신호로 진입\n▶상방 ${SY.leverage}·하방 ${SY.inverse} (3x) · 스탑 SOXX -2%(ETF -6%)\n▶인버스 진입일: 이익 +1% 후 되돌림 0.9%면 '이익 보호 청산' 문자 — 즉시 매도 (8/3 기브백 교정 규칙)\n▶한국 00~07시엔 문자 없음 — 아침 요약으로 합산 (모니터링은 계속)\n----\n근거 246일: 통합(보호 포함) +130.9%p·최악일 -4.08%(SOXX). 비이견일 1박(다음 세션 시가 청산)·이견일 종가(MOC) 청산. 취침(23:30) 지침 문자로 마감.`, undefined);
    }

    // ① 1박 청산 — 전 세션 이월분을 '다음 세션' 개장 시가로 (22:30 KST — 정상 발송 시간).
    // ⚠st.ovn.date < todayEt 필수 (8/5 실사고: EOD가 16:01에 ovn을 세팅하자 16:02 크론이 같은 세션
    // 시가로 즉시 '청산'해버림 — 채점 오확정·새벽 청산 이메일 오발송. 같은 세션에선 절대 발동 금지)
    if (st.ovn && st.ovn.date < todayEt && reg.length > 0 && etMin >= SOXX_ET_OPEN) {
      const open = reg[0].open;
      const gain = ((open - st.ovn.px) / st.ovn.px) * 100 * st.ovn.dir;
      const nm = st.ovn.dir === 1 ? SY.leverage : SY.inverse;
      try {
        const { data: scRow } = await admin.from("ops_settings").select("value").eq("key", "uspredict_v2_scores").maybeSingle();
        const arr = Array.isArray(scRow?.value) ? (scRow!.value as ScoreRow[]) : [];
        const row = arr.find((s) => s.date === st.ovn!.date && (s.pend || s.pendV0));
        if (row) {
          if (row.pend && row.base && row.dir) {
            const ovnP = ((open - row.base) / row.base) * 100 * row.dir;
            row.p = Math.round(ovnP * 100) / 100;
            row.pRe = Math.round(ovnP * 100) / 100; // 비이견일 — 두 판 동일
            row.pend = false;
          }
          if (row.pendV0 && row.baseV0 && row.dirV0) {
            row.pV0 = Math.round(((open - row.baseV0) / row.baseV0) * 100 * row.dirV0 * 100) / 100;
            row.pendV0 = false;
          }
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

    // ② 판정 — 주기준 = 0930 rebox판 (사용자 지적 8/4 "프리장 OR을 정규장에 그대로?" → 스윕 +3.4 우위)
    const { c1, fJ } = judgeSoxxDay(todayEt, raw, hist, r10, NM.rebox);
    const fFirst = fJ && (!c1 || fJ.t < c1.t);
    const first = fFirst ? fJ : c1;
    const lastPx = raw.length ? raw[raw.length - 1].close : null;

    // ②a 진입 — 먼저 온 신호 100% (F 프리장 확인은 09:30 개장가)
    if (first && !st.entryT) {
      const isPre = raw[first.i].etMin < SOXX_ET_OPEN;
      const entryPx = first.px; // 프리장 확인도 확인가 진입 (8/5 채택 — 개장가 대기 대비 +10.7%p)
      st.entryT = fmtT(first.t); st.entryDir = first.dir === 1 ? "up" : "down"; st.entryPx = entryPx; st.entryKind = fFirst ? "f" : "cw";
      changed = true;
      if (live) {
        const nm = first.dir === 1 ? SY.leverage : SY.inverse;
        const stopPx = first.dir === 1 ? entryPx * (1 - SOXX_STOP_PCT / 100) : entryPx * (1 + SOXX_STOP_PCT / 100);
        // 지연은 '실행 가능 시점' 기준 (8/4 실전 교정): F 프리장 확인(예: 07:49)은 진입이 어차피 09:30
        // 개장가라, 크론 시작(09:25 ET=22:25 KST) 감지 통지는 제때임 — 판정 시각 기준으로 재면 96분
        // 오탐지·'진입 금지' 오지시(8/4 밤 실사고). 개장 이후 감지만 진짜 지연.
        const lag = etMin - Math.max(first.t, SOXX_ET_OPEN);
        const lagNote = lag >= 30 ? `\n⚠지연 통지(판정 ${st.entryT} ET, ${lag}분 경과) — 진입 금지, 다음 문자 대기` : "";
        const etfHint = await etfStopHint(nm, entryPx, stopPx);
        const stopLine = isPre
          // 프리장 무스탑 구간의 최대 노출을 계산값으로 명시 (사용자 지시 8/5 밤): 확인→개장 최악 드리프트
          // 실측 SOXX -1.67%(57일, soxx-pre-entry-sweep) → 3x ETF 약 -5.0% — 역사적 최악치이지 보장 아님
          ? `프리장에는 자동스탑설정하지 않음 — 이 구간 실측 최대 손실 ${nm} 기준 약 -5.0%(SOXX -1.67%, 57일 최악치) · 개장(22:30) 후 자동스탑설정: SOXX ${stopPx.toFixed(2)} 이탈(-2%)${etfHint}`
          : `자동스탑설정 설정: SOXX ${stopPx.toFixed(2)} 이탈(-2%)${etfHint} (매수가 대비 ETF -6%)에 전량 자동매도`;
        await send(`uspredict_v2_entry_${st.entryT.replace(":", "")}`, "high",
          `[SOXX 신모델] ${DIR_KO[st.entryDir]} 진입\n▶① ${nm}를 계좌 배정액의 100% 지금 즉시 매수${isPre ? " (프리장 직접 매수)" : ""} (초과 금지)\n▶② ${stopLine}\n▶③ 다음 행동은 문자가 지시 — 동의 확인 시 1박, 이견 시 취침 전 MOC 매도 예약${lagNote}\n무응답=진입\n----\n${etToKstLabel(first.t, kstOffset)} ${fFirst ? "F(피셔) 선행 확인" : "창1(6봉 모멘텀) 판정"} @${first.px.toFixed(2)}. 통합 사양 246일 +141.6%p·컷은 예정 비용(-2%).`,
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
            `[SOXX 신모델] 전환 — 창1이 반대 판정\n▶① 보유 ${oldNm} 전량 즉시 매도 (스탑으로 이미 매도됐다면 ②만)\n▶② ${newNm}를 계좌 배정액의 100% 즉시 매수 (초과 금지)\n▶③ 새 자동스탑설정: SOXX ${stopPx.toFixed(2)} 이탈(-2%) · 오늘 1박 금지 — 취침 전 MOC 매도 예약\n무응답=전환\n----\n${etToKstLabel(c1.t, kstOffset)} 창1 @${c1.px.toFixed(2)} — F 선행일 59일 실측: 나중 신호 심판(E1)이 +36.2%p로 우승(E0 +8.7). 반대 판정일은 1박 금지.`,
            `전환 ${st.revT} ET`);
        }
      } else {
        st.confT = fmtT(c1.t);
        changed = true;
        if (live) await send(`uspredict_v2_conf_${st.confT.replace(":", "")}`, "low",
          `[SOXX 신모델] 검증 통과 — 창1 동의 (1박 자격)\n▶행동 없음 — 보유 유지 (매도 금지)\n▶오늘 밤 청산 안 함: 취침 시 무행동 1박, 내일 22:30(한국) 시가 매도\n▶자동스탑설정: 낮 -2% → 마감(05:00) 전 재난선 SOXX ${st.entryPx ? (st.entryPx * (fJ.dir === 1 ? 0.95 : 1.05)).toFixed(2) : "-5%"}(진입가 -5%, 3x -15%)로 변경 — 밤 통상 변동 미발동\n무응답=보유\n----\n${etToKstLabel(c1.t, kstOffset)} 창1 동의. 동의일 1박 실측: +55.1→+75.2%p (오버나이트 갭이 변동의 절반 — 3276ae7). 밤 재난선 근거: 백테스트는 밤 스탑 없이 시가 청산(최악 -4.08%) — 낮 폭을 밤에 두면 애프터 급락·회복 경로에 컷(8/5 실사고).`,
          `동의 확인 ${st.confT} ET — 1박 자격`);
      }
    }

    // ②c 창1 선행일 — F 동의: 1박 자격 / F 이견: 보유 유지·1박 금지 (수정안 — 낮 행동 없음)
    if (st.entryT && st.entryKind === "cw" && c1 && fJ && fJ.t >= c1.t && !st.confT && !st.oppT) {
      if (fJ.dir === c1.dir) {
        st.confT = fmtT(fJ.t);
        changed = true;
        if (live) await send(`uspredict_v2_conf_${st.confT.replace(":", "")}`, "low",
          `[SOXX 신모델] 검증 통과 — F 동의 (1박 자격)\n▶행동 없음 — 보유 유지 (매도 금지)\n▶오늘 밤 청산 안 함: 취침 시 무행동 1박, 내일 22:30(한국) 시가 매도\n▶자동스탑설정: 낮 -2% → 마감(05:00) 전 재난선 SOXX ${st.entryPx ? (st.entryPx * (c1.dir === 1 ? 0.95 : 1.05)).toFixed(2) : "-5%"}(진입가 -5%, 3x -15%)로 변경 — 밤 통상 변동 미발동\n무응답=보유\n----\n${etToKstLabel(fJ.t, kstOffset)} F 동의(동시각 포함 기준). 수익 엔진 = 동의일 113일 당일 +88.0·1박 +105.5%p (c8c84f5).`,
          `동의 확인 ${st.confT} ET — 1박 자격`);
      } else {
        st.oppT = fmtT(fJ.t);
        changed = true;
        if (live) await send(`uspredict_v2_opp_${st.oppT.replace(":", "")}`, "medium",
          `[SOXX 신모델] F 이견 — 보유는 유지, 1박만 금지\n▶① 지금 매도하지 않습니다 — 보유·자동스탑설정(-2%) 유지\n▶② 오늘 1박 금지: 취침 전 보유 전량 MOC(종가) 매도 예약 — 접수 마감 한국 04:40(정규장 마감 20분 전)\n무응답=보유 후 종가 청산\n----\n${etToKstLabel(fJ.t, kstOffset)} F 반대 확인. SOXX 실측(a24f012): 이견일 낮 청산·역진입은 잡음 손해(Δ-3.2/-2.4) — F 반대의 가치는 1박 금지 문지기(최악 -7.7→-4.1). 삼전과 반대 구조.`,
          `F 이견 ${st.oppT} ET — 1박 금지`);
      }
    }

    // ②d 스탑·이익 보호 감시 — 현재 레그 (창1선행·F선행 공용, 전환 후엔 전환 레그).
    // 보호(8/4 채택): 인버스 레그 한정 — 미실현 +arm% 무장 후 유리 극값에서 trail% 되돌림 시 청산(~10:30 ET)
    if (st.entryT && st.entryPx && !st.stopT && !st.protT && lastPx !== null) {
      const legDir: 1 | -1 = st.revT ? (c1?.dir ?? 1) : st.entryDir === "up" ? 1 : -1;
      const legPx = st.revT ? (st.revPx ?? st.entryPx) : st.entryPx;
      const legT = st.revT ?? st.entryT;
      const PR = NM.soxxV2.protect;
      const i0 = raw.findIndex((b) => b.time === legT || b.etMin >= parseInt(legT.slice(0, 2), 10) * 60 + parseInt(legT.slice(3, 5), 10));
      if (i0 >= 0) {
        const s = SOXX_STOP_PCT / 100;
        let ext = legPx;
        for (let k = i0 + 1; k < raw.length; k++) {
          const b = raw[k];
          if (b.etMin < SOXX_ET_OPEN) continue;
          if (legDir === 1 ? b.low <= legPx * (1 - s) : b.high >= legPx * (1 + s)) {
            st.stopT = b.time;
            changed = true;
            if (live) await send(`uspredict_v2_stop_${st.stopT.replace(":", "")}`, "medium",
              `[SOXX 신모델] 스탑 도달\n▶자동매도 체결 확인만 — 오늘 다시 매수하지 않습니다 (1박도 없음)\n무응답=현행 유지\n----\n${etToKstLabel(b.etMin, kstOffset)} 진입가 대비 SOXX -2%(ETF -6%). 컷일 33/246(13%) — 예정 비용.`,
              `스탑 ${st.stopT} ET`);
            break;
          }
          if (legDir === -1) {
            ext = Math.min(ext, b.low);
            const armGain = ((legPx - ext) / legPx) * 100;
            if (b.etMin <= PR.untilEt && armGain >= PR.arm) {
              const retr = ((b.close - ext) / legPx) * 100;
              if (retr >= PR.trail) {
                st.protT = b.time;
                changed = true;
                const gain = ((legPx - b.close) / legPx) * 100;
                if (live) await send(`uspredict_v2_prot_${st.protT.replace(":", "")}`, "high",
                  `[SOXX 신모델] 이익 보호 청산 — 인버스 되돌림\n▶① 보유 ${SY.inverse} 전량 지금 즉시 매도\n▶② 오늘 재매수·1박 없음 — 이후 '전환' 문자가 오면 그 지침만 예외\n무응답=매도\n----\n${etToKstLabel(b.etMin, kstOffset)} 저점(${ext.toFixed(2)}) 대비 +${PR.trail}% 반등 — 확보 이익 SOXX ${pct(gain)}(3x ≈ ${pct(gain * 3)}). 인버스 진입일 이익 반납이 기브백의 79%(26/33일) — 보호 실측 +130.9%p(기준 +116.5). 상승 진입일엔 미적용(보유 우위).`,
                  `이익 보호 청산 ${st.protT} ET SOXX ${pct(gain)}`);
                break;
              }
            }
          }
        }
      }
    }

    // ③ 취침 지침 (23:30~23:59 KST — F 동의 90%가 23:29까지 확인되는 실측에 맞춘 마감 통지)
    if (live && !st.bedDone && kstMin >= 23 * 60 + 30 && st.entryT) {
      st.bedDone = true;
      changed = true;
      const ovnOk = !!st.confT && !st.stopT && !st.protT;
      const holding = !st.stopT && !st.protT;
      const legDirBed: 1 | -1 = st.revT ? (c1?.dir ?? 1) : st.entryDir === "up" ? 1 : -1;
      const nmBed = legDirBed === 1 ? SY.leverage : SY.inverse; // 보유 종목명 명시 (사용자 지적 8/4 밤 — 표기 없어 혼란)
      const gain = lastPx !== null && st.entryPx ? ((lastPx - (st.revPx ?? st.entryPx)) / (st.revPx ?? st.entryPx)) * 100 * legDirBed : null;
      await send("uspredict_v2_bed", "medium",
        ovnOk
          ? `[SOXX 신모델] 취침 지침 — ${nmBed} 무행동 1박\n▶① 보유 ${nmBed} 그대로 두고 취침 (매도 예약 걸지 않음)\n▶② 자동스탑설정을 재난선 SOXX ${st.entryPx ? ((st.revPx ?? st.entryPx) * (legDirBed === 1 ? 0.95 : 1.05)).toFixed(2) : ""}(진입가 -5%, 3x -15%)로 변경 후 취침 (주간거래 포함) — 낮 폭(-2%)은 애프터 급락·회복 경로에 컷(8/5 실사고)\n▶③ 내일 22:30(한국) 개장 시가 전량 매도 — 문자로 다시 지시\n무응답=1박\n----\n동의일 1박 규칙. 현재 미실현 SOXX ${gain !== null ? pct(gain) : "—"}. 밤 스탑 없는 시가 청산이 백테스트 사양(최악 -4.08%) — 재난선은 통계 밖 붕괴 차단용.`
          : holding
            ? `[SOXX 신모델] 취침 지침 — 오늘은 ${nmBed} 종가 청산\n▶① 취침 전 보유 ${nmBed} 전량 MOC(종가) 매도 예약 (새로 사는 것 아님) — 접수 마감 한국 04:40\n▶② 자동스탑설정(-2%)는 예약과 별개로 유지\n무응답=MOC 예약 필요 (이견·무판정일 1박 금지)\n----\n${st.oppT ? "F 이견일" : st.revT ? "전환일(이견)" : "F 무판정일"} — 1박 자격 없음. 현재 미실현 SOXX ${gain !== null ? pct(gain) : "—"}.`
            : `[SOXX 신모델] 취침 지침 — 보유 없음\n▶행동 없음 (${st.protT ? "이익 보호 청산" : "스탑"}으로 종료된 날)\n----\n오늘 매매 종료.`,
        undefined);
    }

    // ④ 결산 (16:01 ET 이후 1회 = 한국 05:01 — 문자 억제 창이라 이메일+아침 요약으로 전달)
    if (!st.eodDone && etMin >= 961 && reg.length > 0) {
      const close = reg[reg.length - 1].close;
      const sc = scoreSoxxDay(raw, c1, fJ, close, null, true, true); // 주기준 = rebox + 인버 보호 + 프리장 확인가 진입 (8/5 채택)
      const scNP = scoreSoxxDay(raw, c1, fJ, close, null, false); // 보호 없음 대조
      // 무rebox 대조판 (rebox 채택 8/4 — 라이브 페이퍼로 +3.4 우위 재현 확인용, 보호 없음)
      const jV0 = judgeSoxxDay(todayEt, raw, hist, r10, null);
      const scV0 = scoreSoxxDay(raw, jV0.c1, jV0.fJ, close, null);
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
        arr.push({
          date: todayEt, p: Math.round(sc.p * 100) / 100, pRe: Math.round(sc.pRe * 100) / 100,
          pV0: Math.round(scV0.p * 100) / 100, pNP: Math.round(scNP.p * 100) / 100, cut: sc.cut, kind: sc.kind, ovn: sc.ovn,
          ...(sc.ovn ? { pend: true, base: sc.base ?? undefined, dir: sc.dir ?? undefined } : {}),
          ...(scV0.ovn ? { pendV0: true, baseV0: scV0.base ?? undefined, dirV0: scV0.dir ?? undefined } : {}),
        });
        const kept = arr.slice(-120);
        await admin.from("ops_settings").upsert({ key: "uspredict_v2_scores", value: kept, updated_at: new Date().toISOString() }, { onConflict: "key" });
        const sum = (f: (s: ScoreRow) => number) => kept.reduce((a, s) => a + f(s), 0);
        const phase = live ? "시범" : "검증(페이퍼)";
        await send("uspredict_v2_eod", "low",
          `[SOXX 신모델 결산] ${phase} — 오늘 ${pct(sc.p)}${sc.protT !== null ? "(이익 보호 발동)" : ""} · 보호없음 ${pct(scNP.p)} · 역진입판 ${pct(sc.pRe)} · 무rebox ${pct(scV0.p)}${st.entryT ? ` (진입 ${st.entryT}${st.revT ? `·전환 ${st.revT}` : ""}${st.stopT ? `·스탑 ${st.stopT}` : ""}${st.protT ? `·보호 ${st.protT}` : ""}${sc.ovn ? "·1박 중" : ""})` : " (판정 없음)"}\n----\n누적 ${kept.length}일: 주기준(보호) ${pct(sum((s) => s.p))} · 보호없음 ${pct(sum((s) => s.pNP ?? s.p))} · 역진입판 ${pct(sum((s) => s.pRe))} · 무rebox ${pct(sum((s) => s.pV0 ?? s.p))}. 백테스트 궤도 일당 +0.53%(SOXX·3x 환산 +1.6%). 1박 자격일은 다음 세션 시가로 확정치 갱신. 산식: 스탑 -2%·수수료 미차감(편도 0.07%).`,
          `결산 수정안 ${pct(sc.p)}${sc.ovn ? " (1박 중)" : ""}`);
      } catch { /* 채점 실패는 상태 저장 무관 */ }
    }

    if (changed || !prevRaw) await save();
  } catch { /* SOXX 신모델 스트림 실패는 본 흐름을 막지 않는다 */ }
}
