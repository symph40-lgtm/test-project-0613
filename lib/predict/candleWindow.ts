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
};
type CwScore = { date: string; dir: Dir; entryT: string; entryPx: number; holdPnl: number; flipPnl: number; cut: boolean; flip: boolean; ladderPnl?: number; ladderCut?: boolean };

// ── 가상 4단 사다리 채점 (사용자 확정 2026-08-01 — 결산 문자 병기, 60일 실전 채점 후 승격 판단) ──
// 규칙: F 30%(방어일 15%) → F+5분 진행성(≥0.1×r10) 70% → 전진 0.3×r10 또는 창 동의 100% /
// 창 선행 즉시 100% / 이견 전량 청산 + 창 방향 즉시 100% 재진입 (사용자 확정 8/1 2차 — V/U 포착
// +9.2%p·승률 69%, 30분·50%·진행성 조건은 전부 ≈0이라 폐기) / F반대(창선행) 청산(4일 전패) /
// 창 레그 청산은 레짐 분기 (사용자 확정 8/1 2차): 고변동 예상일(isHighVolDay, 전일까지 일봉) = 전환청산,
// 저변동 예상일 = 전환 무시·종가보유 (+18.1%p — 저변동일 전환 신호는 가짜 다수. 당일폭 반영은 추세
// 크기와 오염돼 열위 실측·기각) / 스탑 -2.5%·종가 청산. 서킷브레이커: 직전 3거래일 컷 ≥2 → 정찰 절반.
// 실측: ladder3-sweep·circuit-breaker-sweep·vol-regime-sweep. F는 프리장 게이트(09:00) 반영.
function fisherFirstKr(bars: MinuteBar[], r10: number): { t: number; i: number; dir: 1 | -1; px: number } | null {
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

export function simLadder(bars: MinuteBar[], r10: number, close: number, trs: Tr[], defense: boolean, highVol: boolean): { pnl: number; cut: boolean } {
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
  const fJ = fisherFirstKr(bars, r10);
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
    const krx = krxRaw ?? [];
    // 커버리지 가드 (checkpointStream 이식 — 결손 호출로 오판정 방지)
    const expectKrx = Math.min(minuteOfDay, hhmmToMin("15:30")) - 9 * 60 - 1;
    if (expectKrx > 10 && krx.length < expectKrx * 0.8) return;
    if (minuteOfDay >= hhmmToMin("09:05") && krx.length > 10 && (pre?.length ?? 0) < 40) return;
    const bars = [...(pre ?? []), ...krx];
    if (bars.length < 8) return;

    const trs = candleJudgeStream(bars, unitArr(bars, r10));
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

    // 갭 경보 문자 (사용자 지시 8/1 "갭에 따른 이익·컷과 비중 지침을 같이 안내") — 개장 직후 1일 1회
    if (gapBig && minuteOfDay >= hhmmToMin("09:01") && minuteOfDay <= hhmmToMin("09:20")) {
      const g = gapPct.toFixed(1);
      const big7 = Math.abs(gapPct) >= 7;
      await send("predict_gap_hx", big7 ? "high" : "medium",
        big7
          ? `[예측·하닉 갭경보] ▶오늘 전 계층 정찰 비중 절반(1단계 20→10%)·증액 신중. 무응답=비중 절반 | 근거: 시가 갭 ${g}% — |갭|≥7% 21일 실측: 이익 합 0·컷일 38%(평시 17%). 판정이 늦어서가 아니라 맞아도 이어지지 않는 유형(갭 위 출발이라 추세 연료 소진). 사다리 채점 자동 반영.`
          : `[예측·하닉 갭주의] ▶오늘 정찰 비중 절반(1단계 20→10%). 무응답=비중 절반 | 근거: 시가 갭 ${g}% — 갭 4~7% 36일 실측: 일당 +0.26%·컷일 33% (평시 +0.47·17%). 참고: 갭 2~4%는 최고 구간(+0.99)이라 4% 미만은 정상 비중. 사다리 채점 자동 반영.`);
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
        `[예측·하닉 창판정] ${DIR_KO[st.dir]} 판정 — ${st.entryT} ${e.px.toLocaleString()}원, 6봉 형태 조건 충족 ${paperNote}.${lagNote} 스탑 본주 ${Math.round(stopPx).toLocaleString()}원(-${STOP_PCT}%). 청산 기준(레짐 분기): ${hv ? "★전환청산 — 고변동 예상일(반대 판정 시 청산)" : "★종가보유 — 저변동 예상일(전환 신호 무시)"} · 다른 기준은 대조 기록. 무응답=관찰만.`);
    }

    // ⑤ 가상 4단 사다리 일일 채점 (사용자 확정 2026-08-01) — 창판정 유무와 무관하게 매 거래일 기록.
    // 8/3~8/5 데이터 분석 기간을 거쳐 8/6 시범 시행 예정 — 그때까지는 기록·결산 병기만.
    type LadRow = { date: string; pnl: number; cut: boolean; def?: boolean };
    let ladToday: LadRow | null = null;
    let ladSum = 0, ladN = 0;
    if (!st.ladderDone && minuteOfDay >= hhmmToMin("15:31") && krx.length > 0) {
      try {
        const { data: lRow } = await admin.from("ops_settings").select("value").eq("key", "predict_cw_ladder").maybeSingle();
        const arr = (Array.isArray(lRow?.value) ? (lRow!.value as LadRow[]) : []).filter((r) => r.date !== today);
        // 정찰 절반 = 서킷브레이커(K=3·M=2) 또는 대형 갭일(|갭|≥4%) — 사용자 확정 8/1
        const defense = arr.slice(-3).filter((r) => r.cut).length >= 2 || gapBig;
        const lad = simLadder(bars, r10, krx[krx.length - 1].close, trs, defense, hv);
        ladToday = { date: today, pnl: Math.round(lad.pnl * 100) / 100, cut: lad.cut, def: defense };
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
            `[예측·하닉 창판정] 스탑 도달 — ${b.time} 진입가 대비 -${STOP_PCT}% ${paperNote}. ${beforeFlip ? "두 기준(종가보유·전환청산) 모두 이 시점 -2.5%로 기록." : "종가보유 기준 -2.5% 기록 (전환청산 기준은 이미 전환 시점에 확정)."} 무응답=관찰만.`);
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
            `[예측·하닉 창판정] 추세 전환 — ${st.flipT} 반대 방향(${DIR_KO[flip.to]}) 풀판정 ${paperNote}.${hv ? "" : " 저변동 예상일 — 공식 기준은 전환 무시·보유 지속."} 전환청산 기준 ${pct(flipPnl)}${cutBefore ? "(선행 스탑)" : ` (진입 ${st.entryPx.toLocaleString()} → ${flip.px.toLocaleString()}원)`}. 종가보유 기준은 계속 보유 중. 무응답=관찰만.`);
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
            `[예측·하닉 창판정 결산] ${DIR_KO[st.dir]} ${st.entryT} 진입 ${st.entryPx.toLocaleString()}원 — ★${hv ? "전환청산" : "종가보유"}(공식·${hv ? "고" : "저"}변동일) ${pct(hv ? flipPnl : holdPnl)}${hv ? (st.flipT ? `(${st.flipT} 전환)` : "(전환 없음=종가)") : st.cutT ? "(스탑)" : ""} · ${hv ? "종가보유" : "전환청산"}(대조) ${pct(hv ? holdPnl : flipPnl)} ${paperNote}. 누적 ${n}일: 전환청산 ${pct(sum((s) => s.flipPnl))} · 종가보유 ${pct(sum((s) => s.holdPnl))}.${ladToday ? ` 가상 4단사다리(X0.3·서킷K3M2${ladToday.def ? "·방어일" : ""}): 오늘 ${pct(ladToday.pnl)} · 누적 ${ladN}일 ${pct(ladSum)}.` : ""}`);
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
