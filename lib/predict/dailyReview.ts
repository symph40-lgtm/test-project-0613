// 매일 추세 리뷰 (사용자 지시 2026-07-30 — "추세가 나타난 경우: 시작·끝 시간, 변동 비율,
// 실제 진입 알림 시간, 반전 알림 시간, 피셔 판정 내용, 소진율, 컷 제외 실제 이익").
// 장 마감 후 1회(15:42~16:10 창, 1일 1회 키) — 하닉·삼전 각각, 라이브 현행 상수로 재계산.
// 소진율 = 알림 시점에 추세가 몇 % 진행됐나 / 잔여수익 = 알림가→추세 끝 (스탑컷 무시 — 신호 자체의 가치).

import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict } from "./data";
import { avgRange, isHighVolDay } from "./indicators";
import { fetchDayMinutes, fetchNxtPremarket, fetchTodayMinutes } from "./kisMinute";
import { runFisher } from "./models/fisher";
import type { MinuteBar, PredictDailyBar } from "./types";

const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const f1 = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);

type Conf = { tier: "F" | "M" | "본"; time: string; px: number; dir: "up" | "down" };

// 지그재그 스윙 (2.5% 문턱) 중 |변동| ≥ 3%만 '추세'로 채택
function trends(reg: MinuteBar[]): { sT: string; eT: string; sPx: number; ePx: number; pct: number }[] {
  const pts: { t: string; px: number }[] = [];
  let dir: 1 | -1 = 1, ext = reg[0].close, extT = reg[0].time;
  for (const b of reg) {
    if (dir === 1) {
      if (b.close > ext) { ext = b.close; extT = b.time; }
      else if (((ext - b.close) / ext) * 100 >= 2.5) { pts.push({ t: extT, px: ext }); dir = -1; ext = b.close; extT = b.time; }
    } else {
      if (b.close < ext) { ext = b.close; extT = b.time; }
      else if (((b.close - ext) / ext) * 100 >= 2.5) { pts.push({ t: extT, px: ext }); dir = 1; ext = b.close; extT = b.time; }
    }
  }
  pts.push({ t: extT, px: ext });
  const out: { sT: string; eT: string; sPx: number; ePx: number; pct: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const pct = (pts[i].px / pts[i - 1].px - 1) * 100;
    if (Math.abs(pct) >= 3) out.push({ sT: pts[i - 1].t, eT: pts[i].t, sPx: pts[i - 1].px, ePx: pts[i].px, pct });
  }
  // 문자 길이 제한 — 변동 큰 순 상위 4개를 고른 뒤 시간순 표시 (첫 구현이 시간순 앞 4개를 골라
  // 대추세가 잘리던 결함 교정, 2026-07-30)
  return out
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 4)
    .sort((a, b) => tMin(a.sT) - tMin(b.sT));
}

// 라이브 현행 상수로 F/M/본 확인 이벤트 재구성 (전이 시각 = 확인 시각) — 계층별 목록도 반환
type TierConfs = { merged: Conf[]; byTier: Record<"F" | "M" | "본", Conf[]> };
function confirmsOf(code: string, today: string, hist: PredictDailyBar[], pre: MinuteBar[] | null, reg: MinuteBar[]): TierConfs {
  const isHx = code === "000660";
  const sb = isHx ? PREDICT_CONFIG.earlyStrongBreakRatio : PREDICT_CONFIG.ssStrongBreakRatio;
  const cont = [...(pre ?? []), ...reg];
  const byTier: TierConfs["byTier"] = { F: [], M: [], "본": [] };
  // 상태기계 전이 나열 — runFisher는 최종 상태만 주므로 컷 시각별 재판정으로 전이 추출
  const walk = (bars: MinuteBar[], tier: "F" | "M" | "본", opts: Parameters<typeof runFisher>[1]) => {
    let prev: "none" | "leverage" | "inverse" = "none";
    for (let i = 16; i <= bars.length; i++) {
      const o = runFisher({ date: today, dailyHistory: hist, openPx: bars[0].open, morning: bars.slice(0, i), prevDayMinutes: null }, opts);
      if (o.verdict !== prev && o.verdict !== "none") {
        byTier[tier].push({ tier, time: bars[i - 1].time, px: bars[i - 1].close, dir: o.verdict === "leverage" ? "up" : "down" });
      }
      if (o.verdict !== "none") prev = o.verdict;
    }
  };
  const EV = PREDICT_CONFIG.earlyVol;
  walk(cont, "F", { offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes, strongBreakRatio: sb, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, earlyVolMult: EV.mult, earlyVolUntil: EV.until });
  walk(cont, "M", { offsetRangeRatio: 0.10, confirmMinutes: 8, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, earlyVolMult: EV.mMult, earlyVolUntil: EV.until });
  const trailCfg = isHx ? PREDICT_CONFIG.hxTrail : PREDICT_CONFIG.ssTrail;
  const useTrail = isHx || isHighVolDay(hist);
  walk(reg, "본", { strongBreakRatio: isHx ? PREDICT_CONFIG.lateStrongBreakRatio : sb, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes, ...(useTrail ? { trailRangeRatio: trailCfg.rangeRatio, trailConfirmMinutes: trailCfg.confirmMinutes } : {}) });
  return { merged: [...byTier.F, ...byTier.M, ...byTier["본"]].sort((a, b) => tMin(a.time) - tMin(b.time)), byTier };
}

// 계층별 당일 손익 복기 — 실전 스탑(하닉 본주 -2.5%·삼전 -1.5%), 다음 전이 또는 마감 청산
function tierPnl(bars: MinuteBar[], legs: Conf[], close: number, stopPct: number): { p: number; cuts: number } {
  const r = { p: 0, cuts: 0 };
  const s = stopPct / 100;
  for (let i = 0; i < legs.length; i++) {
    const e = legs[i], endT = i + 1 < legs.length ? tMin(legs[i + 1].time) : Infinity;
    let x: number | null = null;
    for (const b of bars) {
      const tm = tMin(b.time);
      if (tm <= tMin(e.time)) continue;
      if (tm >= endT) break;
      if (e.dir === "up" && b.low <= e.px * (1 - s)) { x = -stopPct; r.cuts++; break; }
      if (e.dir === "down" && b.high >= e.px * (1 + s)) { x = -stopPct; r.cuts++; break; }
    }
    if (x === null) {
      const px2 = i + 1 < legs.length ? legs[i + 1].px : close;
      x = ((px2 - e.px) / e.px) * 100 * (e.dir === "up" ? 1 : -1);
    }
    r.p += x;
  }
  return r;
}

// 왕복 강도 — ±1.2% 지그재그 스윙 개수 (오늘이 얼마나 톱니였나)
function swingCount(reg: MinuteBar[]): number {
  let dir: 1 | -1 = 1, ext = reg[0].close, n = 0;
  for (const b of reg) {
    if (dir === 1) {
      if (b.close > ext) ext = b.close;
      else if (((ext - b.close) / ext) * 100 >= 1.2) { n++; dir = -1; ext = b.close; }
    } else {
      if (b.close < ext) ext = b.close;
      else if (((b.close - ext) / ext) * 100 >= 1.2) { n++; dir = 1; ext = b.close; }
    }
  }
  return n;
}

export async function buildDailyReview(): Promise<string | null> {
  const kst = new Date(Date.now() + 9 * 3600e3);
  const today = kst.toISOString().slice(0, 10);
  const ymd = today.replace(/-/g, "");
  const blocks: string[] = [];
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    try {
      const daily = await fetchDailyPredict(code, 140);
      const hist = daily.filter((b) => b.date < today).slice(-120);
      if (avgRange(hist, 10) === null) continue;
      const pre = await fetchNxtPremarket(code, ymd);
      let reg = await fetchDayMinutes(code, ymd, "153000");
      if (!reg || reg.length < 100) reg = await fetchTodayMinutes(code, "153000");
      if (!reg || reg.length < 100) continue;
      const tr = trends(reg);
      const tc = confirmsOf(code, today, hist, pre, reg);
      const confs = tc.merged;
      // 계층별 손익 복기 + 왕복 강도 (사용자 지시 2026-07-30 2차 — "스윙 구조·소진율·손익 복기도")
      const stopPct = code === "000660" ? 2.5 : 1.5; // 실전 스탑 — ETF -5%/-3%의 본주 환산
      const cont = [...(pre ?? []), ...reg];
      const close = reg[reg.length - 1].close;
      const pF = tierPnl(cont, tc.byTier.F, close, stopPct);
      const pM = tierPnl(cont, tc.byTier.M, close, stopPct);
      const pB = tierPnl(reg, tc.byTier["본"], close, stopPct);
      const sw = swingCount(reg);
      const recap = ` 복기(스탑 -${stopPct}%): F ${f1(pF.p)}%p(컷${pF.cuts})·M ${f1(pM.p)}(컷${pM.cuts})·본 ${f1(pB.p)}(컷${pB.cuts}) | 왕복 ${sw}스윙(±1.2%)`;
      // 해석 라인 (사용자 지시 2026-07-30 — 데이터가 아닌 해석을): 오늘 장 유형 + 어느 계층이
      // 감당했는가를 문장으로. 스윙 분포 기준은 227일 실측(하닉 중앙4·상위10% 13 / 삼전 중앙2·10).
      const [swMed, swP90] = code === "000660" ? [4, 13] : [2, 10];
      const dayType = sw >= swP90
        ? `연중 최상위급 톱니장(왕복 ${sw}스윙, 1년 중앙 ${swMed}) — 빠른층(F·M)이 구조적으로 못 이기는 유형, 본피셔+넓은 스탑의 날`
        : sw > swMed * 1.5
          ? `왕복이 많은 날(${sw}스윙, 중앙 ${swMed}) — 컷 연쇄 주의형`
          : `깨끗한 편(${sw}스윙) — 추세가 나오면 온전히 먹는 유형`;
      const tierMsg = pB.p > 0 && pF.p < 0
        ? " 오늘도 본피셔가 정답 계층 — 빠른층 비중 축소 논거 하루 추가."
        : pF.p > 0 && pF.cuts === 0
          ? " 빠른층이 컷 없이 수익 — 추세 선순환의 날."
          : pF.p < 0 && pB.p < 0
            ? " 전 계층 손실 — 어떤 파라미터로도 피하기 어려운 날(비중 제어가 유일한 방어)."
            : "";
      const insight = ` 해석: ${dayType}.${tierMsg}`;
      if (!tr.length) { blocks.push(`■${name}: ±3% 추세 없음(횡보일)\n${recap}\n${insight}`); continue; }
      const lines: string[] = [`■${name} 추세 ${tr.length}개`];
      tr.forEach((t, i) => {
        const dir = t.pct > 0 ? "up" : "down";
        const dirKo = t.pct > 0 ? "상승" : "하락";
        // 진입 알림 = 추세 구간 내 같은 방향 첫 확인 / 반전 알림 = 추세 끝 이후 첫 반대 확인
        const entry = confs.find((c) => c.dir === dir && tMin(c.time) >= tMin(t.sT) && tMin(c.time) <= tMin(t.eT));
        const revAl = confs.find((c) => c.dir !== dir && tMin(c.time) >= tMin(t.eT));
        let entryStr = "알림 없음(미확인)";
        if (entry) {
          const consumed = Math.round((100 * (entry.px - t.sPx)) / (t.ePx - t.sPx)); // 소진율
          const remain = ((t.ePx - entry.px) / entry.px) * 100 * (dir === "up" ? 1 : -1);
          entryStr = `${entry.tier}${entry.time} ${entry.px.toLocaleString()} 소진${consumed}%·잔여${f1(remain)}%`;
        }
        lines.push(
          `${i + 1}) ${dirKo} ${t.sT}~${t.eT} ${f1(t.pct)}% (${t.sPx.toLocaleString()}→${t.ePx.toLocaleString()})\n` +
          ` 진입알림 ${entryStr} | 반전알림 ${revAl ? `${revAl.tier}${revAl.time}` : "없음"}`,
        );
      });
      lines.push(recap, insight);
      blocks.push(lines.join("\n"));
    } catch { /* 종목 실패 — 건너뜀 */ }
  }
  if (!blocks.length) return null;
  return `[추세 리뷰 ${today.slice(5).replace("-", "/")}]\n${blocks.join("\n")}\n(소진=알림 시점까지 추세 진행률·잔여=알림가→추세끝 수익(컷 무시). 판정 상수는 당일 라이브 기준)`;
}

// 장 마감 후 1회 발송 — runPredictService에서 호출 (실패는 삼킴)
export async function runDailyReview(): Promise<void> {
  try {
    const kst = new Date(Date.now() + 9 * 3600e3);
    const dow = new Date(`${kst.toISOString().slice(0, 10)}T00:00:00Z`).getUTCDay();
    const minuteOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (dow < 1 || dow > 5) return;
    if (minuteOfDay < 15 * 60 + 42 || minuteOfDay > 16 * 60 + 10) return;
    if (!PREDICT_CONFIG.sms.enabled) return;
    const text = await buildDailyReview();
    if (!text) return;
    await dispatchToChannels("signal", kst.toISOString().slice(0, 10), {
      key: "predict_review",
      severity: "low",
      text,
      smsSubject: "추세 리뷰",
    });
  } catch { /* 리뷰 실패는 본 흐름 무관 */ }
}
