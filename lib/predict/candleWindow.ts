// 하닉 6봉 창판정 페이퍼 스트림 (사용자 승인 2026-07-31 "두가지 적용해줘. 문자 보내줘").
// 분봉 형태(6봉 윈도우) 판정 — scripts/candle-window-judge.ts(ff7cad1) 227일 실측 근거:
//   고정눈금(직전 ≤30봉 평균 고저폭×0.5 = 1봉당 45°) · 진입 = 일 최초 풀판정 · 스탑 본주 -2.5%.
//   개별 봉 조건은 원창 6봉(사용자 확정 7/31): 종가보유 130건 평균 +0.64%·승률 54%·컷률 25%·합 +83.4%p /
//   전환청산 +0.47%·컷률 16%·+60.5%p (피셔F 231건 +72.2%p 대비 절반 진입).
//   삼전은 전 눈금 적자로 제외. 10시 게이트는 수익 반감으로 기각.
// 규칙(상승, 하락은 대칭 — 사용자 스펙 7/30 밤 + 교정 7/31):
//   ① 6봉 체인: 비교봉 시가 ≥ 기준봉 몸통(시가~종가)의 2/3 지점. 위반 봉 skip(최대 2)·우측 7·8번봉 보충.
//   ② 체인 인접봉 몸통중간 연결 기울기 ≥40°가 5경우 중 4 이상, |기울기| ≤10° 0개.
//   ③ 저점이 이전 봉 고저중간 아래 ≤1회 ④ 몸통 <20%폭 ≤1개·음봉 ≤1개 (skip 포함).
//   유지·방향없음은 판정 유지(액션 없음) — 청산 이벤트는 반대 풀판정(전환)·스탑·종가뿐.
// 문자·기록 전용 (실투자 판정은 기존 피셔 문자 불변) — 두 청산 기준 병행 60일 채점 후 승격 검토.
// 공식 청산 기준 = 전환청산 (사용자 채택 2026-08-01: 창 선행 레그 실측 이익 동률·컷률 24→14%,
// tmp-q2q3 실측 — 종가보유는 대조군으로 계속 기록).
// 문자 키 predict_cw_* — sms_pause 허용목록 밖(정보성이라 일시정지 시 조용히 멈춤이 맞음).

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict } from "./data";
import { avgRange, isHighVolDay } from "./indicators";
import { fetchDayMinutes, fetchNxtPremarket, fetchTodayMinutes } from "./kisMinute";
import { runFisher } from "./models/fisher";
import type { MinuteBar } from "./types";

const CODE = PREDICT_CONFIG.symbol; // 000660 하닉 본주
const STOP_PCT = 2.5; // 본주 기준 (config.stops.fisher.hxEtfPct 5 = 본주 2.5와 동일 근거)
const D = 180 / Math.PI;
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const hlmid = (b: MinuteBar) => (b.high + b.low) / 2;

type Dir = "up" | "down";
type Tr = { i: number; to: Dir; px: number };

// 각도 눈금: 직전 ≤30봉 평균 고저폭 × 0.5 = 1봉당 45° (백테스트 '고정눈금 0.5폭'과 동일)
// (export는 scripts/의 parity 검증·후속 실측용)
export function unitArr(bars: MinuteBar[], r10: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : r10 / 100;
    return Math.max(u * 0.5, 1e-9);
  });
}

// ① 체인 구성: 시가 조건으로 skip(≤2)·우측 보충
function buildChain(bars: MinuteBar[], i: number, dir: 1 | -1): { chain: number[]; used: number[] } | null {
  let poolLen = 6;
  if (i + poolLen > bars.length) return null;
  const chain = [i];
  const skipped: number[] = [];
  let j = i + 1;
  while (chain.length < 6) {
    if (j >= i + poolLen) return null;
    const base = bars[chain[chain.length - 1]], cand = bars[j];
    const bLo = Math.min(base.open, base.close), bHi = Math.max(base.open, base.close);
    const ok = dir === 1 ? cand.open >= bLo + (2 / 3) * (bHi - bLo) : cand.open <= bLo + (1 / 3) * (bHi - bLo);
    if (ok) chain.push(j);
    else {
      skipped.push(j);
      if (skipped.length > 2) return null;
      if (poolLen < 8 && i + poolLen < bars.length) poolLen++;
    }
    j++;
  }
  return { chain, used: [...chain, ...skipped] };
}

// ②~④ 검증 — 성공 시 판정 완성 봉 인덱스(체인 마지막) 반환
function judgeAt(bars: MinuteBar[], i: number, dir: 1 | -1, unit: number[]): number | null {
  const bc = buildChain(bars, i, dir);
  if (!bc) return null;
  const { chain } = bc;
  let ge40 = 0, flat = 0, midBreak = 0;
  for (let p = 0; p < 5; p++) {
    const a = chain[p], b = chain[p + 1];
    const ang = Math.atan((dir * (bmid(bars[b]) - bmid(bars[a]))) / unit[a]) * D;
    if (ang >= 40) ge40++;
    if (Math.abs(ang) <= 10) flat++;
    const m = hlmid(bars[a]);
    if (dir === 1 ? bars[b].low < m : bars[b].high > m) midBreak++;
  }
  if (ge40 < 4 || flat > 0 || midBreak > 1) return null;
  // 개별 봉 조건은 원창 6봉(skip 포함·추가봉 제외) — 사용자 확정 2026-07-31 (실측 +76.8→+83.4%p, 질 동일)
  let thin = 0, wrongColor = 0;
  for (let k = i; k < i + 6; k++) {
    const rng = bars[k].high - bars[k].low;
    const body = Math.abs(bars[k].close - bars[k].open);
    if (rng <= 0 || body < 0.2 * rng) thin++;
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrongColor++;
  }
  if (thin > 1 || wrongColor > 1) return null;
  return chain[5];
}

// 상태 기계: 첫 풀판정 → 유지, 반대 풀판정에서만 전환 (백테스트 '전환=풀판정' 스트림과 동일)
export function candleJudgeStream(bars: MinuteBar[], unit: number[]): Tr[] {
  const out: Tr[] = [];
  let st: "none" | Dir = "none";
  for (let t = 5; t < bars.length; t++) {
    let judgedDir: Dir | null = null;
    for (const dir of [1, -1] as const) {
      for (const start of [t - 7, t - 6, t - 5]) {
        if (start < 0) continue;
        if (judgeAt(bars, start, dir, unit) === t) { judgedDir = dir === 1 ? "up" : "down"; break; }
      }
      if (judgedDir) break;
    }
    if (!judgedDir) continue;
    if (st === "none" || judgedDir !== st) { st = judgedDir; out.push({ i: t, to: st, px: bars[t].close }); }
  }
  return out;
}

type CwState = {
  date: string;
  dir?: Dir; entryT?: string; entryPx?: number;
  cutT?: string; cutPx?: number;
  flipT?: string; flipPx?: number;
  eodDone?: boolean;
  ladderDone?: boolean;
  ovnDone?: boolean;
  ovnPreT?: string;
};

// ── 국장 1박(오버나이트) 페이퍼 채점 (사용자 확정 2026-08-08) ──────────────────────────
// 자격: 창1 첫판정 방향 == 피셔F 첫판정 방향 (확인 시각 무관 · 무판정일·이견일 제외) + 당일 컷 아님.
//   근거 217일(scripts/kr-overnight-consent.ts): 하닉 68일 +220.0%p·삼전 125일 +182.9%p.
//   '비이견(무판정 포함)' 정의 대비 하닉 +27.3%p — 무판정일은 국장에 1~3일뿐이라 실익 없음.
// 비중: 창1 확인 ≤10:00 그리고 갭 4%+ 아닌 날 = 100%, 나머지 = 50% (사용자 확정 8/8).
//   근거 scripts/kr-overnight-size-split.ts: 9개 후보축 중 두 종목에서 방향이 일관된 둘만 채택
//   (창1 늦은 날 일당 +2.05→+0.73 / 갭일 하닉 +1.34·삼전 -1.21). 일괄 50% 대비 하닉 +23.5·삼전 +48.5%p,
//   최악일은 하닉 -7.96→-4.74. '갭일 전면 쉼'은 종목별로 부호가 갈려(하닉 +32.2·삼전 -33.8) 기각.
// 채점은 원값(100% 환산)과 비중 반영값을 함께 기록 — 비중을 바꿔도 과거 채점이 흔들리지 않는다.
export type OvnRow = {
  date: string; dir: 1 | -1; px: number; w: number; t1: string; gap: boolean;
  raw?: number; wtd?: number; openPx?: number; sDate?: string;
};
export const OVN_FULL_BY = 600; // 창1 확인 ≤10:00이면 100% 후보
export function ovnWeight(t1Min: number, gapBig: boolean): number {
  return t1Min <= OVN_FULL_BY && !gapBig ? 1 : 0.5;
}
// 밤 구간 재난선 폭(본주 %) — 최근 3일 평균 일중폭 × 0.75.
// ⚠규칙이 아니라 통계 외 붕괴 차단용. 밤 스탑을 규칙으로 넣은 변형은 전부 열위로 기각됐고(갭이 스탑을
// 무력화), 밤 경로 분봉이 없어 폭 자체는 검증 불가 — SOXX 재난선(낮 -2% → 밤 -5%)과 같은 성격이다.
// 실측 위치 확인(scripts/kr-overnight-residual.ts): 평균 폭 하닉 본주 4.23%(ETF 8.5%)·삼전 3.22%(6.4%)로
// 낮 스탑(2.5·1.5%)보다 넓고 '낮 스탑×2 재난선'(5.0·3.0%)과 같은 구간 — 변동성에 적응하는 쪽을 채택.
export function ovnStopPct(hist: { high: number; low: number; close: number }[]): number {
  const last3 = hist.slice(-3);
  if (!last3.length) return 0;
  return (last3.reduce((a, b) => a + ((b.high - b.low) / b.close) * 100, 0) / last3.length) * 0.75;
}
// 1박 스탑 안내 문구 — 보유 ETF 기준 %와 본주 이탈가·이탈 방향을 모두 명시 (사용자 지시 2026-08-08
// "인버스인 날은 본주 기준인지 인버스 기준인지 명확히"). 하닉·삼전 실매매 ETF는 모두 2배수.
export function ovnStopLine(close: number, dir: 1 | -1, stopPct: number): string {
  const stopPx = dir === 1 ? close * (1 - stopPct / 100) : close * (1 + stopPct / 100);
  const side = dir === 1 ? "아래로" : "위로";
  return `보유 ETF −${(stopPct * 2).toFixed(1)}% (= 본주 ${Math.round(stopPx).toLocaleString()}원 ${side} 이탈 시 자동매도, 종가 대비 ${stopPct.toFixed(2)}%)`;
}
type CwScore = { date: string; dir: Dir; entryT: string; entryPx: number; holdPnl: number; flipPnl: number; cut: boolean; flip: boolean; ladderPnl?: number; ladderCut?: boolean };

// ── 가상 4단 사다리 채점 (사용자 확정 2026-08-01 — 결산 문자 병기, 60일 실전 채점 후 승격 판단) ──
// 규칙: F 30%(방어일 15%) → F+5분 진행성(≥0.1×r10) 70% → 전진 0.3×r10 또는 창 동의 100% /
// 창 선행 즉시 100% / 이견 전량 청산 + 창 방향 즉시 100% 재진입 (사용자 확정 8/1 2차 — V/U 포착
// +9.2%p·승률 69%, 30분·50%·진행성 조건은 전부 ≈0이라 폐기) / F반대(창선행) 청산(4일 전패) /
// 창 레그 청산은 레짐 분기 (사용자 확정 8/1 2차): 고변동 예상일(isHighVolDay, 전일까지 일봉) = 전환청산,
// 저변동 예상일 = 전환 무시·종가보유 (+18.1%p — 저변동일 전환 신호는 가짜 다수. 당일폭 반영은 추세
// 크기와 오염돼 열위 실측·기각) / 스탑 -2.5%·종가 청산. 서킷브레이커: 직전 3거래일 컷 ≥2 → 정찰 절반.
// 실측: ladder3-sweep·circuit-breaker-sweep·vol-regime-sweep. F는 프리장 게이트(09:00) 반영.
export function fisherFirstKr(bars: MinuteBar[], r10: number): { t: number; i: number; dir: 1 | -1; px: number } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = hhmmToMin("10:30"), from9 = hhmmToMin("09:00");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const t = hhmmToMin(b.time);
    const em = t < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (t < from9) continue; // 프리장 확인 금지 (라이브 confirmFromKr 미러)
    if (up >= 4) return { t, i, dir: 1, px: b.close };
    if (dn >= 4) return { t, i, dir: -1, px: b.close };
  }
  return null;
}

// fJOverride: F 첫 판정 주입 (0930 OR 스윕 등 변형 실측용 — 미지정 시 내부 미러로 계산, 라이브 동작 불변)
export function simLadder(bars: MinuteBar[], r10: number, close: number, trs: Tr[], defense: boolean, highVol: boolean, fJOverride?: { t: number; i: number; dir: 1 | -1; px: number } | null): { pnl: number; cut: boolean } {
  let cut = false;
  const tr = (i0: number, dir: 1 | -1, px: number, size: number, forceI?: number, forcePx?: number): number => {
    if (size <= 0) return 0;
    const s = STOP_PCT / 100;
    const lim = forceI ?? bars.length;
    for (let k = i0 + 1; k < lim; k++) {
      const b = bars[k];
      if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) { cut = true; return -STOP_PCT * size; }
    }
    const px2 = forceI !== undefined ? (forcePx ?? close) : close;
    return ((px2 - px) / px) * 100 * dir * size;
  };
  const cw = trs.length ? { t: hhmmToMin(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const cwFlip = trs.length ? trs.find((x) => x.i > trs[0].i && x.to !== trs[0].to) ?? null : null;
  const fJ = fJOverride !== undefined ? fJOverride : fisherFirstKr(bars, r10);
  let pnl = 0;
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    const oppI = opp ? cw!.i : undefined, oppPx = opp ? cw!.px : undefined;
    const scout = tr(fJ.i, fJ.dir, fJ.px, 0.3, oppI, oppPx);
    pnl += defense ? scout * 0.5 : scout; // 서킷브레이커: 정찰 절반 (실측과 동일한 산식)
    let held = 0.3;
    const evs: { i: number; target: number; px: number }[] = [];
    if (fJ.i + 5 < bars.length && (bars[fJ.i + 5].close - fJ.px) * fJ.dir >= 0.1 * r10) evs.push({ i: fJ.i + 5, target: 0.7, px: bars[fJ.i + 5].close });
    for (let k = fJ.i + 1; k < bars.length; k++) {
      if ((bars[k].close - fJ.px) * fJ.dir >= 0.3 * r10) { evs.push({ i: k, target: 1.0, px: bars[k].close }); break; }
    }
    if (cw && cw.dir === fJ.dir) evs.push({ i: cw.i, target: 1.0, px: cw.px });
    evs.sort((a, b) => a.i - b.i);
    for (const ev of evs) {
      if (oppI !== undefined && ev.i >= oppI) break;
      const add = ev.target - held;
      if (add <= 0) continue;
      pnl += tr(ev.i, fJ.dir, ev.px, add, oppI, oppPx);
      held = ev.target;
    }
    if (opp && cw) {
      // 이견: 창 방향 즉시 100% 재진입 (사용자 확정 8/1 2차) — 재진입 레그 청산은 레짐 분기
      const rEnd = highVol ? cwFlip : null;
      pnl += tr(cw.i, cw.dir, cw.px, 1.0, rEnd?.i, rEnd?.px);
    }
  } else if (cw) {
    // 창 선행 100% — 레짐 분기: 고변동일만 전환청산, 저변동일 보유. F 반대 청산은 공통.
    const fOppLate = fJ && fJ.dir !== cw.dir ? fJ : null;
    const flipEx = highVol ? cwFlip : null;
    let endI: number | undefined, endPx: number | undefined;
    if (flipEx && (!fOppLate || flipEx.i <= fOppLate.i)) { endI = flipEx.i; endPx = flipEx.px; }
    else if (fOppLate) { endI = fOppLate.i; endPx = fOppLate.px; }
    pnl += tr(cw.i, cw.dir, cw.px, 1.0, endI, endPx);
  }
  return { pnl, cut };
}

const DIR_KO: Record<Dir, string> = { up: "상승(레버 방향)", down: "하락(인버 방향)" };
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

// 하닉 1박 자격에 쓰는 F 방향 (시행판 = 강돌파 0.1 + 0930 rebox).
// 사다리 내부 미러(fisherFirstKr·rebox 없음)와 달리 스윕 정의와 자격일·성적이 완전 일치한다
// (scripts/kr-overnight-fcfg-check.ts: 68일·+192.2%p 동일 / 미러판은 66일·+186.9).
export function hxOvnFisherDir(bars: MinuteBar[], hist: { date: string; open: number; high: number; low: number; close: number; volume: number }[], today: string): 0 | 1 | -1 {
  const C = PREDICT_CONFIG;
  const tr = runFisher({ date: today, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, {
    offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes,
    strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes,
    earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until,
    confirmFromHHMM: C.confirmFromKr, ...C.newModel.rebox,
  }).transitions ?? [];
  return tr.length ? (tr[0].to === "up" ? 1 : -1) : 0;
}

// 전 거래일 1박분 정산 (오늘 정규장 시가로 청산) — 하닉·삼전 공용. 실패는 삼켜 본 흐름에 무영향.
export async function settleOvn(
  admin: ReturnType<typeof createAdminClient>,
  key: string, label: string, today: string, openPx: number,
  send: (k: string, sev: "low" | "medium" | "high", text: string) => Promise<void>,
): Promise<void> {
  try {
    const { data } = await admin.from("ops_settings").select("value").eq("key", key).maybeSingle();
    const arr = (Array.isArray(data?.value) ? (data!.value as OvnRow[]) : []);
    const pend = arr.find((r) => r.raw === undefined && r.date < today);
    if (!pend || !(openPx > 0)) return;
    pend.raw = Math.round(((openPx - pend.px) / pend.px) * 100 * pend.dir * 100) / 100;
    pend.wtd = Math.round(pend.raw * pend.w * 100) / 100;
    pend.openPx = openPx;
    pend.sDate = today;
    const kept = arr.slice(-120);
    await admin.from("ops_settings").upsert({ key, value: kept, updated_at: new Date().toISOString() }, { onConflict: "key" });
    const done = kept.filter((r) => r.raw !== undefined);
    const sum = (f: (r: OvnRow) => number) => done.reduce((a, r) => a + f(r), 0);
    await send(`${key}_settle_${pend.date.replace(/-/g, "")}`, "medium",
      `[예측·${label} 1박 청산] 시가 청산 ${pct(pend.wtd)} (비중 ${pend.w * 100}% 반영 · 원값 ${pct(pend.raw)})\n▶09:00 시가에 전량 매도 — 어젯밤 1박분 종료\n▶오늘 신규 판정은 별도 문자로\n무응답=시가 매도\n----\n${pend.date} 종가 ${pend.px.toLocaleString()}원 → 오늘 시가 ${openPx.toLocaleString()}원. 1박 누적 ${done.length}일: 비중반영 ${pct(sum((r) => r.wtd ?? 0))} · 원값(전부 100% 환산) ${pct(sum((r) => r.raw ?? 0))}.`);
  } catch { /* 1박 정산 실패는 본 흐름 무관 */ }
}

// runPredictService 말미에서 매분 호출 — 실패는 삼켜 기존 스트림에 무영향
export async function runCandleWindowMonitor(): Promise<void> {
  try {
    const kst = kstNow();
    const today = kst.toISOString().slice(0, 10);
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (dow < 1 || dow > 5) return;
    const minuteOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (minuteOfDay < hhmmToMin("08:12") || minuteOfDay > hhmmToMin("15:44")) return;

    const ymd = today.replace(/-/g, "");
    const daily = await fetchDailyPredict(CODE, 140);
    const hist = daily.filter((b) => b.date < today).slice(-120);
    const r10 = avgRange(hist, 10);
    if (hist.length < 30 || r10 === null) return;
    const [pre, krxRaw] = await Promise.all([
      fetchNxtPremarket(CODE, ymd),
      fetchDayMinutes(CODE, ymd, "153000").then((b) => b ?? fetchTodayMinutes(CODE, "153000")),
    ]);
    // 전일 봉·미완성 봉 차단 (8/5 실사고: 08:30 크론에 KIS 당일 분봉 폴백이 전일 09:01~ 봉을 반환 →
    // 어제 가격으로 유령 스탑 문자. 현재 시각 이후 타임스탬프 봉 = 오늘 것일 수 없음 → 전부 제거,
    // 현재 분 봉은 미완성이라 제외 — SOXX 완성봉 원칙(de6093d)과 동일)
    const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const krx = (krxRaw ?? []).filter((b) => b.time < nowHHMM);
    // 커버리지 가드 (checkpointStream 이식 — 결손 호출로 오판정 방지)
    const expectKrx = Math.min(minuteOfDay, hhmmToMin("15:30")) - 9 * 60 - 1;
    if (expectKrx > 10 && krx.length < expectKrx * 0.8) return;
    if (minuteOfDay >= hhmmToMin("09:05") && krx.length > 10 && (pre?.length ?? 0) < 40) return;
    const bars = [...(pre ?? []).filter((b) => b.time < nowHHMM), ...krx];
    if (bars.length < 8) return;

    // 눈금 스케일 1.2 (사용자 채택 8/6 — 7월 재도출 nm-july-param-sweep: 7월 +0.7→+6.4·전체 -0.5 비훼손.
    // 판정·사다리·0930판 모두 스케일판 기준, 현행 1.0판은 사다리 대조 채점(p10)으로 병기)
    const unitScaled = unitArr(bars, r10).map((u) => u * PREDICT_CONFIG.newModel.cwUnitScale);
    const trs = candleJudgeStream(bars, unitScaled);
    const hv = isHighVolDay(hist); // 레짐 분기 (전일까지 일봉 — 사용자 확정 8/1: 저변동일 종가보유·고변동일 전환청산)
    // 대형 갭일 (사용자 채택 8/1 — tmp-gap-day 실측): 시가 |갭| ≥4%면 정찰 절반. ≥7%는 이익 0·컷 38% 구간.
    const prevClose = hist[hist.length - 1]?.close ?? 0;
    const gapPct = krx.length && prevClose > 0 ? ((krx[0].open - prevClose) / prevClose) * 100 : 0;
    const gapBig = Math.abs(gapPct) >= 4;
    const admin = createAdminClient();
    const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "predict_cw_state").maybeSingle();
    const prevRaw = (stRow?.value ?? null) as CwState | null;
    const st: CwState = prevRaw && prevRaw.date === today ? { ...prevRaw } : { date: today };
    let changed = false;
    const send = async (key: string, severity: "low" | "medium" | "high", text: string): Promise<void> => {
      try {
        await dispatchToChannels("signal", today, { key, severity, text, smsSubject: "하닉 창판정" });
      } catch { /* 발송 실패 무시 */ }
    };
    const paperNote = "(페이퍼 60일 채점 중 — 실투자 판정은 기존 피셔 문자)";

    // ⓪ 전 거래일 1박분 정산 (오늘 정규장 시가로 청산 — 사용자 확정 8/8)
    if (minuteOfDay >= hhmmToMin("09:01") && krx.length > 0) {
      await settleOvn(admin, "predict_cw_ovn", "하이닉스", today, krx[0].open, send);
    }

    // 갭 경보 문자 (사용자 지시 8/1 "갭에 따른 이익·컷과 비중 지침을 같이 안내") — 개장 직후 1일 1회
    if (gapBig && minuteOfDay >= hhmmToMin("09:01") && minuteOfDay <= hhmmToMin("09:20")) {
      const g = gapPct.toFixed(1);
      const big7 = Math.abs(gapPct) >= 7;
      await send("predict_gap_hx", big7 ? "high" : "medium",
        // 상단=액션만·하단=부연 (사용자 지시 2026-08-01 2차)
        big7
          ? `[예측·하닉 갭경보]\n▶오늘 정찰 비중 절반: 1단계 20→10%\n▶증액(2·3단계) 신중\n무응답=비중 절반\n----\n시가 갭 ${g}%. |갭|≥7% 날 21일 실측: 이익 합 0·컷일 38%(평시 17%) — 판정이 맞아도 이어지지 않는 유형(갭 위 출발, 추세 연료 소진). 사다리 채점 자동 반영.`
          : `[예측·하닉 갭주의]\n▶오늘 정찰 비중 절반: 1단계 20→10%\n무응답=비중 절반\n----\n시가 갭 ${g}%. 갭 4~7% 날 36일 실측: 일당 +0.26%·컷일 33%(평시 +0.47·17%). 갭 2~4%는 최고 수익 구간(+0.99)이라 4% 미만은 정상 비중. 사다리 채점 자동 반영.`);
    }

    // ① 진입: 일 최초 풀판정
    if (!st.entryT && trs.length) {
      const e = trs[0];
      st.dir = e.to; st.entryT = bars[e.i].time; st.entryPx = e.px;
      changed = true;
      const lag = minuteOfDay - hhmmToMin(st.entryT);
      const stopPx = st.dir === "up" ? e.px * (1 - STOP_PCT / 100) : e.px * (1 + STOP_PCT / 100);
      const lagNote = lag >= 30 ? ` ⚠지연 통지(${lag}분 경과) — 추격 기준가 아님.` : "";
      await send(`predict_cw_entry_${st.entryT.replace(":", "")}`, "medium",
        `[예측·하닉 창판정] ${DIR_KO[st.dir]} 판정\n▶페이퍼 관찰만(실투자 지침 아님) — ${st.entryT} ${e.px.toLocaleString()}원·스탑 ${Math.round(stopPx).toLocaleString()}원(-${STOP_PCT}%)\n무응답=관찰만\n----\n6봉 형태 조건 충족.${lagNote} 오늘 청산 기준(레짐): ${hv ? "★전환청산(고변동 예상일 — 반대 판정 시 청산)" : "★종가보유(저변동 예상일 — 전환 신호 무시)"}, 다른 기준은 대조 기록. ${paperNote}`);
    }

    // ⑤ 가상 4단 사다리 일일 채점 (사용자 확정 2026-08-01) — 창판정 유무와 무관하게 매 거래일 기록.
    // 8/3~8/5 데이터 분석 기간을 거쳐 8/6 시범 시행 예정 — 그때까지는 기록·결산 병기만.
    type LadRow = { date: string; pnl: number; cut: boolean; def?: boolean; p10?: number };
    let ladToday: LadRow | null = null;
    let ladSum = 0, ladN = 0;
    if (!st.ladderDone && minuteOfDay >= hhmmToMin("15:31") && krx.length > 0) {
      try {
        const { data: lRow } = await admin.from("ops_settings").select("value").eq("key", "predict_cw_ladder").maybeSingle();
        const arr = (Array.isArray(lRow?.value) ? (lRow!.value as LadRow[]) : []).filter((r) => r.date !== today);
        // 정찰 절반 = 서킷브레이커(K=3·M=2) 또는 대형 갭일(|갭|≥4%) — 사용자 확정 8/1
        const defense = arr.slice(-3).filter((r) => r.cut).length >= 2 || gapBig;
        const lad = simLadder(bars, r10, krx[krx.length - 1].close, trs, defense, hv);
        // 대조: 현행 눈금 1.0판 (채택 파라미터의 라이브 재현 검증용 — 60일 채점이 판정)
        const trs10 = candleJudgeStream(bars, unitArr(bars, r10));
        const lad10 = simLadder(bars, r10, krx[krx.length - 1].close, trs10, defense, hv);
        ladToday = { date: today, pnl: Math.round(lad.pnl * 100) / 100, cut: lad.cut, def: defense, p10: Math.round(lad10.pnl * 100) / 100 };
        arr.push(ladToday);
        const kept = arr.slice(-120);
        ladSum = kept.reduce((a, r) => a + r.pnl, 0);
        ladN = kept.length;
        await admin.from("ops_settings").upsert(
          { key: "predict_cw_ladder", value: kept, updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );
        st.ladderDone = true;
        changed = true;
      } catch { /* 사다리 채점 실패는 본 흐름 무관 */ }
    }

    // ⑥ 국장 1박 자격·비중 판정 (사용자 확정 2026-08-08) — 사다리 채점과 같은 실행에서 1일 1회.
    // 자격 = 창1 첫판정 방향 == 피셔F(시행판 0930 rebox) 첫판정 방향 · 당일 컷 아님.
    // ⚠F 상수는 시행판(강돌파 0.1)과 스윕(0.075)이 자격일 68일·성적 +192.2%p로 완전 동일 — 실측 확인
    //   (scripts/kr-overnight-fcfg-check.ts). 사다리 내부 미러(rebox 없음)만 66일·+186.9로 갈려 미채택.
    // ⑤-b 15:15 1박 사전 통지 (사용자 지시 2026-08-08 "1박 필요 없으면 정규장 종가에 팔 수 있게 일찍",
    // 시각 확정 "15:20부터 시간외 종가 거래로 빠지니까 15:15에"):
    // 자격 요소(창·F 첫판정 방향, 창 확인 시각, 갭)는 실측상 전 자격일이 15:15 이전에 확정된다
    // (scripts/kr-overnight-residual.ts: 15:15 이후 확정 0일 · 15:00 이후 하닉 1·삼전 2일) —
    // 그래서 종가 전에 '유지 / 종가 전량 매도'를 지시할 수 있다. 애프터장(NXT) 청산은 사양 밖
    // (백테스트는 정규장 종가 기준·저유동). 15:31 결산이 최종 확정·기록.
    if (!st.ovnPreT && st.entryT && minuteOfDay >= hhmmToMin("15:15") && minuteOfDay <= hhmmToMin("15:19") && krx.length > 0) {
      st.ovnPreT = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
      changed = true;
      try {
        const cwDir: 1 | -1 = trs.length ? (trs[0].to === "up" ? 1 : -1) : 1;
        const ok = trs.length > 0 && hxOvnFisherDir(bars, hist, today) === cwDir && !st.cutT;
        const px = krx[krx.length - 1].close;
        const w = trs.length ? ovnWeight(hhmmToMin(bars[trs[0].i].time), gapBig) : 0;
        await send("predict_cw_ovnpre", "medium", ok
          ? `[예측·하이닉스] 오늘 밤 1박 예정 — 종가에 비중 ${w * 100}% 맞추세요\n▶① 15:30 종가 기준 배정액의 ${w * 100}%를 ${cwDir === 1 ? "레버리지" : "인버스"} ETF로 보유 (부족하면 종가 매수·초과면 매도)\n▶② 스탑설정: ${ovnStopLine(px, cwDir, ovnStopPct(hist))}\n▶③ 내일 09:00 시가 전량 매도\n무응답=1박 유지\n----\n창·피셔F 동의일. 15:31 결산 문자로 최종 확정합니다(막판 스탑 시 취소). ${paperNote}`
          : `[예측·하이닉스] 오늘은 1박 없음 — 15:30 종가에 전량 매도\n▶보유분 전량 종가 매도 (밤 보유 없음)\n무응답=종가 매도\n----\n${!trs.length ? "창 판정 없음" : st.cutT ? "오늘 스탑 종료" : "피셔F 무판정 또는 이견 — 동의일 아님"}. 1박은 창·F가 같은 방향인 날만. 드물게 15:15 이후 판정이 성립하면 15:31 결산 문자로 다시 안내합니다(217일 중 하닉 0일·삼전 1일). ${paperNote}`);
      } catch { /* 사전 통지 실패는 본 흐름 무관 */ }
    }

    let ovnLine = ""; // 결산 문자에 병기할 1박 열
    if (!st.ovnDone && ladToday && trs.length && minuteOfDay >= hhmmToMin("15:31") && krx.length > 0) {
      st.ovnDone = true;
      changed = true;
      try {
        const cwDir: 1 | -1 = trs[0].to === "up" ? 1 : -1;
        const fDir = hxOvnFisherDir(bars, hist, today);
        const close = krx[krx.length - 1].close;
        const qualify = fDir === cwDir && ladToday.pnl > -2.4;
        if (qualify) {
          const t1 = bars[trs[0].i].time;
          const w = ovnWeight(hhmmToMin(t1), gapBig);
          const stopPct = ovnStopPct(hist);
          const { data: oRow } = await admin.from("ops_settings").select("value").eq("key", "predict_cw_ovn").maybeSingle();
          const arr = (Array.isArray(oRow?.value) ? (oRow!.value as OvnRow[]) : []).filter((r) => r.date !== today);
          arr.push({ date: today, dir: cwDir, px: close, w, t1, gap: gapBig });
          await admin.from("ops_settings").upsert({ key: "predict_cw_ovn", value: arr.slice(-120), updated_at: new Date().toISOString() }, { onConflict: "key" });
          const done = arr.filter((r) => r.raw !== undefined);
          ovnLine = ` 1박: 오늘 자격(비중 ${w * 100}%) — 내일 시가 확정 · 누적 ${done.length}일 비중반영 ${pct(done.reduce((a, r) => a + (r.wtd ?? 0), 0))}(원값 ${pct(done.reduce((a, r) => a + (r.raw ?? 0), 0))}).`;
          await send("predict_cw_ovn", "medium",
            `[예측·하이닉스] 오늘 밤 1박 유지, 다음날 09:00 시가매도\n▶① 종가 기준 배정액의 ${w * 100}%를 ${cwDir === 1 ? "레버리지" : "인버스"} ETF로 보유 (남은 게 적으면 종가에 채우고, 많으면 줄입니다)\n▶② 스탑설정: ${ovnStopLine(close, cwDir, stopPct)}\n▶③ 내일 09:00 시가에 전량 매도\n무응답=1박 유지\n----\n자격: 창 첫판정(${t1} ${DIR_KO[trs[0].to]})과 피셔F가 같은 방향 = 동의일. 비중 ${w === 1 ? "100%(조기 확인·비갭)" : `50%(${hhmmToMin(t1) > OVN_FULL_BY ? "창 확인 10시 이후" : ""}${hhmmToMin(t1) > OVN_FULL_BY && gapBig ? "·" : ""}${gapBig ? "갭 4%+ 시작일" : ""})`}. 스탑은 규칙이 아니라 밤 재난선(최근 3일 평균 일중폭×0.75) — ⚠갭이 스탑 밖에서 시작하면 미체결이고 그 경우 09:00 시가 청산으로 처리합니다. 근거 217일 +220.0%p(비중 반영 +192.2). ${paperNote}`);
        }
      } catch { /* 1박 판정 실패는 본 흐름 무관 */ }
    }

    // 신모델 vs 현행 비교 성능 문자 (사용자 지시 2026-08-01 밤 — 8/3~5 실전 테스트 기간, 장마감 1회):
    // 신사다리(오늘 채점분)·0930판 사다리(F만 rebox 주입) vs 현행 계층 지침(F/M/본 각자 레그 손익
    // 20/30/50 가중 — 계층 구조는 각 계층이 자기 신호로 진입·전환하므로 가중합이 곧 계층 성적).
    // ladToday가 있는 실행에서만 = 하루 1회. 실패는 본 흐름 무관.
    if (ladToday && today >= PREDICT_CONFIG.newModel.cmpFrom && today <= PREDICT_CONFIG.newModel.cmpTo) {
      try {
        const C = PREDICT_CONFIG;
        const close = krx[krx.length - 1].close;
        const mkIn = (b: MinuteBar[]) => ({ date: today, dailyHistory: hist, openPx: b[0].open, morning: b, prevDayMinutes: null });
        const fCfg = { offsetRangeRatio: C.earlyOffsetRatio, confirmMinutes: C.earlyConfirmMinutes, strongBreakRatio: C.earlyStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr };
        const fT = runFisher(mkIn(bars), fCfg).transitions ?? [];
        const mT = runFisher(mkIn(bars), { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: C.streamReversalMinutes, earlyVolMult: C.earlyVol.mMult, earlyVolUntil: C.earlyVol.until, confirmFromHHMM: C.confirmFromKr }).transitions ?? [];
        const bT = krx.length >= 20 ? runFisher(mkIn(krx), { strongBreakRatio: C.lateStrongBreakRatio, reversalMinutes: C.streamReversalMinutes, trailRangeRatio: C.hxTrail.rangeRatio, trailConfirmMinutes: C.hxTrail.confirmMinutes }).transitions ?? [] : [];
        // 레그 회계 (stop-width-sweep 관례): 전이=진입/전환, 컷 -2.5%(앵커=확인가), 잔여 종가
        const leg = (bb: MinuteBar[], tl: { time: string; to: Dir; px: number }[]): number => {
          const idx = new Map<string, number>();
          bb.forEach((x, i) => { if (!idx.has(x.time)) idx.set(x.time, i); });
          const s = STOP_PCT / 100;
          let p = 0;
          for (let k = 0; k < tl.length; k++) {
            const t = tl[k];
            const i0 = idx.get(t.time);
            if (i0 === undefined) continue;
            const endI = k + 1 < tl.length ? idx.get(tl[k + 1].time) ?? bb.length : bb.length;
            const dir = t.to === "up" ? 1 : -1;
            let cutHit = false;
            for (let i = i0 + 1; i < endI; i++) {
              if (dir === 1 ? bb[i].low <= t.px * (1 - s) : bb[i].high >= t.px * (1 + s)) { cutHit = true; break; }
            }
            p += cutHit ? -STOP_PCT : (((k + 1 < tl.length ? tl[k + 1].px : close) - t.px) / t.px) * 100 * dir;
          }
          return p;
        };
        const hier = 0.2 * leg(bars, fT) + 0.3 * leg(bars, mT) + 0.5 * leg(krx, bT);
        // 0930판 사다리: F 첫판정만 rebox 스트림으로 교체 (창판정·레짐·방어 동일)
        const f93 = runFisher(mkIn(bars), { ...fCfg, ...C.newModel.rebox }).transitions ?? [];
        const idx93 = new Map<string, number>();
        bars.forEach((x, i) => { if (!idx93.has(x.time)) idx93.set(x.time, i); });
        const fj93 = f93.length && idx93.has(f93[0].time)
          ? { t: hhmmToMin(f93[0].time), i: idx93.get(f93[0].time)!, dir: (f93[0].to === "up" ? 1 : -1) as 1 | -1, px: f93[0].px }
          : null;
        const lad93 = simLadder(bars, r10, close, trs, ladToday.def === true, hv, fj93);
        type CmpRow = { date: string; lad: number; l93: number; hier: number };
        const { data: cRow } = await admin.from("ops_settings").select("value").eq("key", "predict_nm_cmp").maybeSingle();
        const cArr = (Array.isArray(cRow?.value) ? (cRow!.value as CmpRow[]) : []).filter((r) => r.date !== today);
        cArr.push({ date: today, lad: ladToday.pnl, l93: Math.round(lad93.pnl * 100) / 100, hier: Math.round(hier * 100) / 100 });
        await admin.from("ops_settings").upsert(
          { key: "predict_nm_cmp", value: cArr.slice(-30), updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );
        const sum = (f: (r: CmpRow) => number) => cArr.reduce((a, r) => a + f(r), 0);
        // 마지막 테스트일(8/5)엔 내일 시범 시작 예고 + go/no-go 기준 동봉 (사용자 확정 8/1 밤:
        // "효과가 예상대로 나오면 목요일부터" — 3일 손익은 표본이 작아 참고, 기준은 무사고·재현 정합)
        const lastDay = today >= PREDICT_CONFIG.newModel.cmpTo;
        await send("predict_nm_cmp", lastDay ? "medium" : "low",
          // 문자에는 실시행판(0930)만 표기 (사용자 지시 8/5 밤 "내일 시행되는 판만 적어줘 — 앞의 것은 헷갈려,
          // 모니터는 하고") — 구사다리·현행계층은 predict_nm_cmp 기록으로만 추적 (웹 /newmodel·결산 대조용)
          `[예측·하닉 신모델] 시행판(0930 사다리) 오늘 ${pct(lad93.pnl)}\n${lastDay ? "▶내일(8/6) 아침부터 시범 자동 시작 — 중단하려면 회신\n" : ""}무응답=${lastDay ? "예정대로 시범 시작" : "관찰만"}\n----\n시행판 누적 ${cArr.length}일 ${pct(sum((r) => r.l93))} · 백테스트 227일 기대 +122.0%p·컷일 52일(23%). 규칙: F 확인 30% → 진행성 충족 70% → 전진 0.3/창동의 100%·스탑 본주 -2.5%(ETF -5%)·종가청산. 구판·현행계층 성적은 기록으로만 추적 중(웹 신모델 현황 참조).`);
      } catch { /* 비교 문자 실패는 본 흐름 무관 */ }
    }

    // 진입 이후 이벤트 (재계산 기반 — 크론 결번이 있어도 분봉으로 소급 감지)
    if (st.entryT && st.entryPx && st.dir) {
      const sgn = st.dir === "up" ? 1 : -1;
      const entryIdx = bars.findIndex((b) => b.time === st.entryT);
      // ② 스탑: 진입 후 저가/고가가 -2.5% 도달 (전환 뒤라도 종가보유 기준에 적용)
      if (!st.cutT && entryIdx >= 0) {
        const s = STOP_PCT / 100;
        const flipMin = st.flipT ? hhmmToMin(st.flipT) : null;
        for (let i = entryIdx + 1; i < bars.length; i++) {
          const b = bars[i];
          const hit = st.dir === "up" ? b.low <= st.entryPx * (1 - s) : b.high >= st.entryPx * (1 + s);
          if (!hit) continue;
          st.cutT = b.time; st.cutPx = st.entryPx * (1 - sgn * s);
          changed = true;
          const beforeFlip = flipMin === null || hhmmToMin(b.time) <= flipMin;
          await send(`predict_cw_cut_${b.time.replace(":", "")}`, "medium",
            `[예측·하닉 창판정] 스탑 도달\n▶기록만(페이퍼) — 재진입 없음(확정규칙)\n무응답=관찰만\n----\n${b.time} 진입가 대비 -${STOP_PCT}%. ${beforeFlip ? "두 기준(종가보유·전환청산) 모두 이 시점 -2.5%로 기록." : "종가보유 기준 -2.5% 기록(전환청산 기준은 이미 전환 시점에 확정)."} ${paperNote}`);
          break;
        }
      }
      // ③ 전환: 첫 반대 풀판정 — 전환청산 기준 확정, 종가보유는 유지
      if (!st.flipT) {
        const flip = trs.find((t) => t.i > (entryIdx >= 0 ? entryIdx : -1) && t.to !== st.dir);
        if (flip) {
          st.flipT = bars[flip.i].time; st.flipPx = flip.px;
          changed = true;
          const cutBefore = st.cutT !== undefined && hhmmToMin(st.cutT) < hhmmToMin(st.flipT);
          const flipPnl = cutBefore ? -STOP_PCT : ((flip.px - st.entryPx) / st.entryPx) * 100 * sgn;
          await send(`predict_cw_flip_${st.flipT.replace(":", "")}`, "medium",
            `[예측·하닉 창판정] 추세 전환 발생\n${hv ? "▶전환청산 기준: 이 시점 청산 확정 (고변동 예상일)" : "▶공식 기준(저변동 예상일): 전환 무시·보유 지속"}\n▶반대 방향 재진입 금지(확정규칙 — 창 전환 후 재진입 -22.5%p 실측)\n무응답=관찰만\n----\n${st.flipT} 반대 방향(${DIR_KO[flip.to]}) 풀판정. 전환청산 기준 ${pct(flipPnl)}${cutBefore ? "(선행 스탑)" : ` (진입 ${st.entryPx.toLocaleString()} → ${flip.px.toLocaleString()}원)`}, 종가보유 기준은 계속 보유 중. ${paperNote}`);
        }
      }
      // ④ 마감 결산 (15:31 이후 1회): 두 기준 성적 확정·기록
      if (!st.eodDone && minuteOfDay >= hhmmToMin("15:31") && krx.length > 0) {
        const close = krx[krx.length - 1].close;
        const holdPnl = st.cutT ? -STOP_PCT : ((close - st.entryPx) / st.entryPx) * 100 * sgn;
        const cutBeforeFlip = st.cutT !== undefined && (!st.flipT || hhmmToMin(st.cutT) <= hhmmToMin(st.flipT));
        const flipPnl = st.flipT && st.flipPx !== undefined && !cutBeforeFlip
          ? ((st.flipPx - st.entryPx) / st.entryPx) * 100 * sgn
          : cutBeforeFlip ? -STOP_PCT : holdPnl;
        st.eodDone = true;
        changed = true;
        const score: CwScore = {
          date: today, dir: st.dir, entryT: st.entryT, entryPx: st.entryPx,
          holdPnl: Math.round(holdPnl * 100) / 100, flipPnl: Math.round(flipPnl * 100) / 100,
          cut: st.cutT !== undefined, flip: st.flipT !== undefined,
        };
        try {
          const { data: scRow } = await admin.from("ops_settings").select("value").eq("key", "predict_cw_scores").maybeSingle();
          const arr = (Array.isArray(scRow?.value) ? (scRow!.value as CwScore[]) : []).filter((s) => s.date !== today);
          arr.push(score);
          const kept = arr.slice(-120);
          await admin.from("ops_settings").upsert(
            { key: "predict_cw_scores", value: kept, updated_at: new Date().toISOString() },
            { onConflict: "key" },
          );
          const n = kept.length;
          const sum = (f: (s: CwScore) => number) => kept.reduce((a, s) => a + f(s), 0);
          await send("predict_cw_eod", "low",
            `[예측·하닉 창판정 결산] 오늘 ★${hv ? "전환청산" : "종가보유"}(공식) ${pct(hv ? flipPnl : holdPnl)}\n▶액션 없음(마감 결산)\n----\n${DIR_KO[st.dir]} ${st.entryT} 진입 ${st.entryPx.toLocaleString()}원. 공식(${hv ? "고" : "저"}변동일 기준) ${pct(hv ? flipPnl : holdPnl)}${hv ? (st.flipT ? `(${st.flipT} 전환)` : "(전환 없음=종가)") : st.cutT ? "(스탑)" : ""} · 대조 ${pct(hv ? holdPnl : flipPnl)}. 누적 ${n}일: 전환청산 ${pct(sum((s) => s.flipPnl))} · 종가보유 ${pct(sum((s) => s.holdPnl))}.${ladToday ? ` 가상 4단사다리(눈금1.2·X0.3·서킷K3M2${ladToday.def ? "·방어일" : ""}): 오늘 ${pct(ladToday.pnl)}(눈금1.0 대조 ${pct(ladToday.p10 ?? ladToday.pnl)}) · 누적 ${ladN}일 ${pct(ladSum)}.` : ""}${ovnLine} ${paperNote}`);
        } catch { /* 채점 실패는 상태 저장에 영향 없음 */ }
      }
    }

    if (changed || !prevRaw || prevRaw.date !== today) {
      await admin.from("ops_settings").upsert(
        { key: "predict_cw_state", value: st, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    }
  } catch { /* 페이퍼 스트림 실패는 본 흐름을 막지 않는다 */ }
}
