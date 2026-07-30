// 하닉 6봉 창판정 페이퍼 스트림 (사용자 승인 2026-07-31 "두가지 적용해줘. 문자 보내줘").
// 분봉 형태(6봉 윈도우) 판정 — scripts/candle-window-judge.ts(ff7cad1) 227일 실측 근거:
//   고정눈금(직전 ≤30봉 평균 고저폭×0.5 = 1봉당 45°) · 진입 = 일 최초 풀판정 · 스탑 본주 -2.5%.
//   종가보유 110건 평균 +0.70%·승률 54%·컷률 25%·합 +76.8%p / 전환청산 +0.54%·컷률 17%·+59.0%p
//   (피셔F 231건 +72.2%p 대비 절반 진입). 삼전은 전 눈금 적자로 제외. 10시 게이트는 수익 반감으로 기각.
// 규칙(상승, 하락은 대칭 — 사용자 스펙 7/30 밤 + 교정 7/31):
//   ① 6봉 체인: 비교봉 시가 ≥ 기준봉 몸통(시가~종가)의 2/3 지점. 위반 봉 skip(최대 2)·우측 7·8번봉 보충.
//   ② 체인 인접봉 몸통중간 연결 기울기 ≥40°가 5경우 중 4 이상, |기울기| ≤10° 0개.
//   ③ 저점이 이전 봉 고저중간 아래 ≤1회 ④ 몸통 <20%폭 ≤1개·음봉 ≤1개 (skip 포함).
//   유지·방향없음은 판정 유지(액션 없음) — 청산 이벤트는 반대 풀판정(전환)·스탑·종가뿐.
// 문자·기록 전용 (실투자 판정은 기존 피셔 문자 불변) — 두 청산 기준 병행 60일 채점 후 승격 검토.
// 문자 키 predict_cw_* — sms_pause 허용목록 밖(정보성이라 일시정지 시 조용히 멈춤이 맞음).

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict } from "./data";
import { avgRange } from "./indicators";
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
  const { chain, used } = bc;
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
  let thin = 0, wrongColor = 0;
  for (const k of used) {
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
};
type CwScore = { date: string; dir: Dir; entryT: string; entryPx: number; holdPnl: number; flipPnl: number; cut: boolean; flip: boolean };

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

    // ① 진입: 일 최초 풀판정
    if (!st.entryT && trs.length) {
      const e = trs[0];
      st.dir = e.to; st.entryT = bars[e.i].time; st.entryPx = e.px;
      changed = true;
      const lag = minuteOfDay - hhmmToMin(st.entryT);
      const stopPx = st.dir === "up" ? e.px * (1 - STOP_PCT / 100) : e.px * (1 + STOP_PCT / 100);
      const lagNote = lag >= 30 ? ` ⚠지연 통지(${lag}분 경과) — 추격 기준가 아님.` : "";
      await send(`predict_cw_entry_${st.entryT.replace(":", "")}`, "medium",
        `[예측·하닉 창판정] ${DIR_KO[st.dir]} 판정 — ${st.entryT} ${e.px.toLocaleString()}원, 6봉 형태 조건 충족 ${paperNote}.${lagNote} 스탑 본주 ${Math.round(stopPx).toLocaleString()}원(-${STOP_PCT}%). 이후 두 기준 병행 기록: ①종가 보유(실측 평균 +0.70%) ②반대 판정 시 청산(컷률 17%). 무응답=관찰만.`);
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
            `[예측·하닉 창판정] 추세 전환 — ${st.flipT} 반대 방향(${DIR_KO[flip.to]}) 풀판정 ${paperNote}. 전환청산 기준 확정 ${pct(flipPnl)}${cutBefore ? "(선행 스탑)" : ` (진입 ${st.entryPx.toLocaleString()} → ${flip.px.toLocaleString()}원)`}. 종가보유 기준은 계속 보유 중. 무응답=관찰만.`);
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
            `[예측·하닉 창판정 결산] ${DIR_KO[st.dir]} ${st.entryT} 진입 ${st.entryPx.toLocaleString()}원 — 종가보유 ${pct(holdPnl)}${st.cutT ? "(스탑)" : ""} · 전환청산 ${pct(flipPnl)}${st.flipT ? `(${st.flipT} 전환)` : "(전환 없음=종가)"} ${paperNote}. 누적 ${n}일: 종가보유 ${pct(sum((s) => s.holdPnl))} · 전환청산 ${pct(sum((s) => s.flipPnl))}.`);
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
