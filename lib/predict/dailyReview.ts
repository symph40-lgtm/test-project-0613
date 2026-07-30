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

// 라이브 현행 상수로 F/M/본 확인 이벤트 재구성 (전이 시각 = 확인 시각)
function confirmsOf(code: string, today: string, hist: PredictDailyBar[], pre: MinuteBar[] | null, reg: MinuteBar[]): Conf[] {
  const isHx = code === "000660";
  const sb = isHx ? PREDICT_CONFIG.earlyStrongBreakRatio : PREDICT_CONFIG.ssStrongBreakRatio;
  const cont = [...(pre ?? []), ...reg];
  const out: Conf[] = [];
  // 상태기계 전이 나열 — runFisher는 최종 상태만 주므로 컷 시각별 재판정으로 전이 추출
  const walk = (bars: MinuteBar[], tier: "F" | "M" | "본", opts: Parameters<typeof runFisher>[1]) => {
    let prev: "none" | "leverage" | "inverse" = "none";
    for (let i = 16; i <= bars.length; i++) {
      const o = runFisher({ date: today, dailyHistory: hist, openPx: bars[0].open, morning: bars.slice(0, i), prevDayMinutes: null }, opts);
      if (o.verdict !== prev && o.verdict !== "none") {
        out.push({ tier, time: bars[i - 1].time, px: bars[i - 1].close, dir: o.verdict === "leverage" ? "up" : "down" });
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
  return out.sort((a, b) => tMin(a.time) - tMin(b.time));
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
      if (!tr.length) { blocks.push(`■${name}: ±3% 추세 없음(횡보일)`); continue; }
      const confs = confirmsOf(code, today, hist, pre, reg);
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
