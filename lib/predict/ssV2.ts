// 삼전 신모델(v2) 스트림 — 창(4봉 누적 순전진) 정찰 + 피셔F 반대 확인 시 전량 전환 (사용자 확정 2026-08-02 밤
// "최근 가장 좋은 모델로 적용, 수요일까지 검증 후 하닉처럼 목요일부터 시범(문자발송)").
// 근거 실측 (232일, scripts/ss-cw4-*·ss-cw-hanik-*): 창1.0 단독 +82.0 · v2 +101.2%p(최악일 -3.0·컷일 99) ·
//   1.2판 +100.8. 이견일(74일)은 나중 신호(F)가 옳다 — 역진입 회수 +18.2%p. 형태·하닉참조·사다리 이식은 전부 기각.
// 규칙: 창 첫판정 100% 진입(스탑 본주 -1.5%=ETF -3%) → F가 반대 첫확인 시 전량 청산+반대 100% 역진입(스탑 동일)
//   → 종가 전량 청산. F 선행일(실측 0~1%)은 관망. 창 전환·재확인은 무시(전환청산 -3.5 실측 — 노이즈).
// 일정: newModel.cmpFrom(8/3)부터 기록+결산 문자(검증) · newModel.applyFrom(8/6)부터 진입/전환/스탑 문자(시범).
// 채점 predict_ssv2_scores(1.0·1.2 병행, 120일) — 60일 페이퍼 궤도(일당 +0.44%) 대조 후 승격 판단.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict } from "./data";
import { avgRange } from "./indicators";
import { fetchDayMinutes, fetchNxtPremarket, fetchTodayMinutes } from "./kisMinute";
import { runFisher, type FisherCfg } from "./models/fisher";
import { unitArr, settleOvn, ovnWeight, ovnStopPct, ovnStopLine, OVN_FULL_BY, type OvnRow } from "./candleWindow";
import type { MinuteBar } from "./types";

const CODE = "005930";
const STOP_PCT = 1.5; // 본주 (ETF 2x -3%)
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

type Dir = 1 | -1;
type CwJ = { i: number; t: number; dir: Dir; px: number };

// n봉 누적 순전진 스트림 (scripts/ss-cw4-pure-advance·ss-cw-winsize-sweep와 동일 산식 — 눈금 = unitArr)
// 주 기준 6봉 (사용자 확정 8/2 밤 3차: "6봉 시범·4/5봉 채점 모니터링" — v2 +105.4·컷일 88·첫판정 09:00)
export function cumStream(bars: MinuteBar[], unit: number[], tanA: number, win = 4): { i: number; to: "up" | "down"; px: number }[] {
  const out: { i: number; to: "up" | "down"; px: number }[] = [];
  const w = win - 1;
  let st: "none" | "up" | "down" = "none";
  for (let t = w; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      if ((bmid(bars[t]) - bmid(bars[t - w])) * dir >= tanA * unit[t - w] * w) { judged = dir === 1 ? "up" : "down"; break; }
    }
    if (!judged) continue;
    if (st === "none" || judged !== st) { st = judged; out.push({ i: t, to: st, px: bars[t].close }); }
  }
  return out;
}

function tranche(bars: MinuteBar[], close: number, i0: number, dir: Dir, px: number, size: number, forceI?: number, forcePx?: number): { pnl: number; cut: boolean; cutI: number | null } {
  if (size <= 0) return { pnl: 0, cut: false, cutI: null };
  const s = STOP_PCT / 100;
  const lim = forceI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return { pnl: -STOP_PCT * size, cut: true, cutI: k };
  }
  const px2 = forceI !== undefined ? (forcePx ?? close) : close;
  return { pnl: ((px2 - px) / px) * 100 * dir * size, cut: false, cutI: null };
}

// 백테스트(ss-cw4-hier-cases v2)와 동일 채점 — 페이퍼 궤도 대조용
export function simV2(bars: MinuteBar[], r10: number, close: number, tanA: number, fJ: CwJ | null, win = 4): { pnl: number; cut: boolean } {
  const unit = unitArr(bars, r10);
  const trs = cumStream(bars, unit, tanA, win);
  const cw: CwJ | null = trs.length ? { i: trs[0].i, t: hhmmToMin(bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px } : null;
  let pnl = 0, cut = false;
  const add = (r: { pnl: number; cut: boolean }) => { pnl += r.pnl; cut = cut || r.cut; };
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (fFirst && fJ) {
    const opp = cw && cw.dir !== fJ.dir;
    add(tranche(bars, close, fJ.i, fJ.dir, fJ.px, 0.3, opp ? cw!.i : undefined, opp ? cw!.px : undefined));
    if (cw && cw.dir === fJ.dir) add(tranche(bars, close, cw.i, fJ.dir, cw.px, 0.7));
    if (opp && cw) add(tranche(bars, close, cw.i, cw.dir, cw.px, 1.0));
  } else if (cw) {
    const fOpp = fJ && fJ.dir !== cw.dir ? fJ : null;
    add(tranche(bars, close, cw.i, cw.dir, cw.px, 1.0, fOpp?.i, fOpp?.px));
    if (fOpp) add(tranche(bars, close, fOpp.i, fOpp.dir, fOpp.px, 1.0));
  }
  return { pnl, cut };
}

// 신모델 검증자 F의 cfg — 삼전 라이브 F + 0930 rebox (사용자 제안 8/2 밤 "10시 이후 축적 OR" →
// rebox 단독 스윕(ss-f-rebox-sweep)에서 09:30~45박스@09:45가 최적: F 단독 +61.9→+79.9·v2 +105.4→+112.8.
// 10:00 전환은 심판 지연으로 v2 -5.2 열위. 하닉 F·M 시범과 동일 박스 — 시스템 일관).
export function ssv2FisherCfg(): FisherCfg {
  return {
    offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio, confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes,
    strongBreakRatio: PREDICT_CONFIG.ssStrongBreakRatio, reversalMinutes: PREDICT_CONFIG.streamReversalMinutes,
    earlyVolMult: PREDICT_CONFIG.earlyVol.mult, earlyVolUntil: PREDICT_CONFIG.earlyVol.until,
    confirmFromHHMM: PREDICT_CONFIG.confirmFromKr,
    ...PREDICT_CONFIG.newModel.rebox,
  };
}

type St = {
  date: string;
  entryT?: string; entryDir?: "up" | "down"; entryPx?: number;
  stop1T?: string; confT?: string; revT?: string; revPx?: number; stop2T?: string;
  eodDone?: boolean;
  ovnDone?: boolean;
  ovnPreT?: string;
};
type Score = { date: string; p: number; p5: number; p4: number; p12: number; cut: boolean; note?: string };
const DIR_KO = { up: "상승(레버 방향)", down: "하락(인버 방향)" } as const;

export async function runSsV2Monitor(): Promise<void> {
  try {
    const NM = PREDICT_CONFIG.newModel;
    const kst = kstNow();
    const today = kst.toISOString().slice(0, 10);
    if (today < NM.cmpFrom) return; // 8/3 이전 대기
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (dow < 1 || dow > 5) return;
    const minuteOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (minuteOfDay < hhmmToMin("08:12") || minuteOfDay > hhmmToMin("15:44")) return;
    const live = NM.applyFrom !== "" && today >= NM.applyFrom; // 문자 시범 (8/6~) — 이전엔 기록·결산만

    const ymd = today.replace(/-/g, "");
    const daily = await fetchDailyPredict(CODE, 140);
    const hist = daily.filter((b) => b.date < today).slice(-120);
    const r10 = avgRange(hist, 10);
    if (hist.length < 30 || r10 === null) return;
    const [pre, krxRaw] = await Promise.all([
      fetchNxtPremarket(CODE, ymd),
      fetchDayMinutes(CODE, ymd, "153000").then((b) => b ?? fetchTodayMinutes(CODE, "153000")),
    ]);
    // 전일 봉·미완성 봉 차단 (8/5 하이닉스 유령 스탑 실사고와 동일 취약점 — candleWindow 주석 참조)
    const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const krx = (krxRaw ?? []).filter((b) => b.time < nowHHMM);
    // 커버리지 가드 (candleWindow와 동일 — 결손 호출로 오판정 방지)
    const expectKrx = Math.min(minuteOfDay, hhmmToMin("15:30")) - 9 * 60 - 1;
    if (expectKrx > 10 && krx.length < expectKrx * 0.8) return;
    if (minuteOfDay >= hhmmToMin("09:05") && krx.length > 10 && (pre?.length ?? 0) < 40) return;
    const bars = [...(pre ?? []).filter((b) => b.time < nowHHMM), ...krx];
    if (bars.length < 8) return;

    const unit = unitArr(bars, r10);
    const trs = cumStream(bars, unit, NM.ssV2.tan, NM.ssV2.win);
    const cw: CwJ | null = trs.length ? { i: trs[0].i, t: hhmmToMin(bars[trs[0].i].time), dir: (trs[0].to === "up" ? 1 : -1) as Dir, px: trs[0].px } : null;
    const fTrs = bars.length >= 20 ? (runFisher({ date: today, dailyHistory: hist, openPx: bars[0].open, morning: bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fTrs.length ? bars.findIndex((b) => b.time === fTrs[0].time) : -1;
    const fJ: CwJ | null = fTrs.length && fIdx >= 0 ? { i: fIdx, t: hhmmToMin(fTrs[0].time), dir: (fTrs[0].to === "up" ? 1 : -1) as Dir, px: fTrs[0].px } : null;
    const fFirstDay = fJ && cw && fJ.t < cw.t; // F 선행 희귀일 — 관망

    const admin = createAdminClient();
    const { data: stRow } = await admin.from("ops_settings").select("value").eq("key", "predict_ssv2_state").maybeSingle();
    const prevRaw = (stRow?.value ?? null) as St | null;
    const st: St = prevRaw && prevRaw.date === today ? { ...prevRaw } : { date: today };
    let changed = false;
    const send = async (key: string, severity: "low" | "medium" | "high", text: string): Promise<void> => {
      try { await dispatchToChannels("signal", today, { key, severity, text, smsSubject: "삼전 신모델" }); } catch { /* 발송 실패 무시 */ }
    };
    // 대형 갭일 (1박 비중 축소 축 — 삼전 갭 4%+ 28일 1박 일당 -1.21%, scripts/kr-overnight-size-split.ts)
    const prevClose = hist[hist.length - 1]?.close ?? 0;
    const gapBig = krx.length > 0 && prevClose > 0 && Math.abs(((krx[0].open - prevClose) / prevClose) * 100) >= 4;

    // ⓪ 전 거래일 1박분 정산 (오늘 정규장 시가로 청산 — 사용자 확정 8/8)
    if (minuteOfDay >= hhmmToMin("09:01") && krx.length > 0) {
      await settleOvn(admin, "predict_ssv2_ovn", "삼성전자", today, krx[0].open, send);
    }

    // 시범 시작 안내 (applyFrom 첫날 1회)
    if (live && today === NM.applyFrom && minuteOfDay <= hhmmToMin("09:30")) {
      await send("predict_ssv2_start", "medium",
        `[예측·삼전 신모델] 오늘부터 시범 시행\n▶삼전 매매는 이 문자 기준 — 창(${NM.ssV2.win}봉 모멘텀) 판정 진입 → 피셔F 반대 확인 시 전량 전환\n▶중단하려면 회신 — 별도 오더 없으면 계속(사용자 지시 8/2)\n----\n8/3~5 페이퍼 검증 후 예정 시행. 근거 232일: 5봉 v2(F 0930 박스판) +115.4%p (6봉 +112.8은 대조 채점 — 사용자 전환 8/5). 스탑 ETF -3%(본주 -1.5%)·당일청산. 창 전환 신호는 무시(실측 노이즈) — 전환은 F 반대 확인만.`);
    }

    if (cw && !fFirstDay) {
      // ① 진입: 창 첫판정
      if (!st.entryT) {
        st.entryT = bars[cw.i].time; st.entryDir = cw.dir === 1 ? "up" : "down"; st.entryPx = cw.px;
        changed = true;
        if (live) {
          const lag = minuteOfDay - cw.t;
          const nm = cw.dir === 1 ? "삼전 레버리지 ETF" : "삼전 인버스 ETF";
          const when = cw.t < hhmmToMin("09:00") ? "09:00 개장 직후 개장가로 매수 (프리장 판정)" : "지금 즉시 매수";
          const lagNote = lag >= 30 ? `\n⚠지연 통지(확인 ${st.entryT}, ${lag}분 경과) — 위 ①② 실행 금지, 다음 문자 대기` : "";
          const stopPx = cw.dir === 1 ? cw.px * (1 - STOP_PCT / 100) : cw.px * (1 + STOP_PCT / 100);
          await send(`predict_ssv2_entry_${st.entryT.replace(":", "")}`, "high",
            `[예측·삼전 신모델] ${DIR_KO[st.entryDir]} 진입\n▶① ${nm}를 계좌 배정액의 100%로 ${when} (초과 금지)\n▶② 매수 직후 자동스탑설정 설정: ETF -3% = 본주 ${Math.round(stopPx).toLocaleString()}원 이탈 시 자동매도\n▶③ 이후 행동은 문자가 지시: F 동의 → 보유 확인 / F 반대 → 전환. 매도는 15:30 종가${lagNote}\n무응답=진입\n----\n${st.entryT} ${cw.px.toLocaleString()}원 — 직전 ${NM.ssV2.win}봉 누적 전진이 평소 흔들림 기준 초과(모멘텀 판정). 시범: 232일 +115.4%p(5봉 rebox판).`);
        }
      }
      // ② 정찰 레그 스탑
      if (st.entryT && st.entryPx && !st.stop1T && !st.revT) {
        const eI = bars.findIndex((b) => b.time === st.entryT);
        if (eI >= 0) {
          const r = tranche(bars, krx.length ? krx[krx.length - 1].close : cw.px, eI, cw.dir, st.entryPx, 1);
          if (r.cutI !== null) {
            st.stop1T = bars[r.cutI].time;
            changed = true;
            if (live) await send(`predict_ssv2_stop_${st.stop1T.replace(":", "")}`, "medium",
              `[예측·삼전 신모델] 스탑 도달\n▶자동매도 체결됐는지 HTS에서 확인만 하세요 — 오늘 다시 매수하지 않습니다\n▶예외: 이후 '전환' 문자가 오면 그 문자의 ② 지침대로만 행동\n무응답=현행 유지\n----\n${st.stop1T} 진입가 대비 본주 -${STOP_PCT}%(ETF -3%). 컷은 이 모델의 예정 비용(이틀 1회꼴).`);
          }
        }
      }
      // ②-b F 동의 확인 → 보유 지속 통지 (사용자 지시 8/2 밤 — 침묵 대신 검증 통과 문자)
      if (st.entryT && fJ && fJ.dir === cw.dir && fJ.t > cw.t && !st.confT) {
        st.confT = bars[fJ.i].time;
        changed = true;
        if (live) await send(`predict_ssv2_conf_${st.confT.replace(":", "")}`, "low",
          `[예측·삼전 신모델] 검증 통과 — 피셔F 동의\n▶행동 없음 — 보유한 ETF를 그대로 둡니다 (매도 금지)\n▶매도 시각: 오늘 15:30 종가 (그 전에 자동스탑설정 -3% 닿으면 거기서 종료)\n무응답=보유\n----\n${st.confT} 피셔F가 같은 방향 확인 — 오늘은 전환 문자가 더 오지 않습니다. 공통일 실측: 129일 +207.5%p(이 모델 수익원의 전부).`);
      }

      // ③ F 반대 확인 → 전량 전환 (역진입)
      if (st.entryT && fJ && fJ.dir !== cw.dir && fJ.t > cw.t && !st.revT) {
        st.revT = bars[fJ.i].time; st.revPx = fJ.px;
        changed = true;
        if (live) {
          const lag = minuteOfDay - fJ.t;
          const oldNm = fJ.dir === 1 ? "인버스" : "레버리지";
          const newNm = fJ.dir === 1 ? "삼전 레버리지 ETF" : "삼전 인버스 ETF";
          const lagNote = lag >= 30 ? `\n⚠지연 통지(확인 ${st.revT}, ${lag}분 경과) — 위 ①~③ 실행 금지, 관망` : "";
          await send(`predict_ssv2_rev_${st.revT.replace(":", "")}`, "high",
            `[예측·삼전 신모델] 전환 — 피셔F 반대 확인\n▶① 보유 중인 ${oldNm} ETF 전량 즉시 매도 (이미 스탑으로 매도됐다면 ②로)\n▶② 곧바로 ${newNm}를 계좌 배정액의 100% 매수 (초과 금지)\n▶③ 새 자동스탑설정 설정: 매수가 기준 ETF -3%. 매도는 15:30 종가${lagNote}\n무응답=전환\n----\n${st.revT} ${fJ.px.toLocaleString()}원 — 신중한 피셔F가 반대를 확인. 이견일 74일 실측: 창 방향 전패·F 방향 +18.2%p 회수.`);
        }
      }
      // ④ 역진입 레그 스탑
      if (st.revT && st.revPx && fJ && !st.stop2T) {
        const rI = bars.findIndex((b) => b.time === st.revT);
        if (rI >= 0) {
          const r = tranche(bars, krx.length ? krx[krx.length - 1].close : st.revPx, rI, fJ.dir, st.revPx, 1);
          if (r.cutI !== null) {
            st.stop2T = bars[r.cutI].time;
            changed = true;
            if (live) await send(`predict_ssv2_stop2_${st.stop2T.replace(":", "")}`, "medium",
              `[예측·삼전 신모델] 전환 레그 스탑\n▶자동매도 체결됐는지 HTS에서 확인만 하세요 — 오늘 매매는 여기서 종료(추가 매수 없음)\n무응답=현행 유지\n----\n${st.stop2T} 전환가 대비 본주 -${STOP_PCT}%(ETF -3%). 최악일 유형(-3.0%: 양쪽 스탑) — 232일 중 드묾.`);
          }
        }
      }
    }

    // ④-b 15:20 1박 사전 통지 (사용자 지시 2026-08-08 — candleWindow.ts ⑤-b와 동일 취지·근거)
    if (!st.ovnPreT && st.entryT && minuteOfDay >= hhmmToMin("15:15") && minuteOfDay <= hhmmToMin("15:19") && krx.length > 0) {
      st.ovnPreT = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
      changed = true;
      try {
        const bothStopped = !!st.stop1T && !!st.stop2T;
        const ok = !!cw && !fFirstDay && !!fJ && fJ.dir === cw.dir && !bothStopped;
        const px = krx[krx.length - 1].close;
        const d: Dir = cw ? cw.dir : 1;
        const w = cw ? ovnWeight(cw.t, gapBig) : 0;
        // 지침 문자는 ssOvnAdvise 게이트 (8/8 사용자 확정 — 삼전 1박은 채점만, 근거는 config 주석)
        if (live && NM.ssOvnAdvise) await send("predict_ssv2_ovnpre", "medium", ok
          ? `[예측·삼성전자 신모델 1박] 오늘 밤 1박 예정 — 종가에 비중 ${w * 100}% 맞추세요\n▶① 15:30 종가 기준 배정액의 ${w * 100}%를 ${d === 1 ? "레버리지" : "인버스"} ETF로 보유 (부족하면 종가 매수·초과면 매도)\n▶② 스탑설정: ${ovnStopLine(px, d, ovnStopPct(hist))}\n▶③ 내일 09:00 시가 전량 매도\n무응답=1박 유지\n----\n창·피셔F 동의일. 15:31 결산 문자로 최종 확정합니다(막판 스탑 시 취소).`
          : `[예측·삼성전자 신모델 1박] 오늘은 1박 없음 — 15:30 종가에 전량 매도\n▶보유분 전량 종가 매도 (밤 보유 없음)\n무응답=종가 매도\n----\n${!cw ? "창 판정 없음" : fFirstDay ? "F 선행 관망일" : bothStopped ? "양쪽 레그 스탑 종료" : "피셔F 무판정 또는 이견 — 동의일 아님"}. 1박은 창·F가 같은 방향인 날만. 드물게 15:15 이후 판정이 성립하면 15:31 결산 문자로 다시 안내합니다(217일 중 1일).`);
      } catch { /* 사전 통지 실패는 본 흐름 무관 */ }
    }

    // ⑤ 결산 (15:31 이후 1회, cmpFrom부터): 1.0·1.2 병행 채점 + 문자
    if (!st.eodDone && minuteOfDay >= hhmmToMin("15:31") && krx.length > 0) {
      const close = krx[krx.length - 1].close;
      const rMain = simV2(bars, r10, close, NM.ssV2.tan, fJ, NM.ssV2.win); // 주 기준 5봉 (8/5 사용자 지시)
      const r5 = simV2(bars, r10, close, NM.ssV2.tan, fJ, 6); // ⚠p5 저장칸은 8/5부터 '6봉 대조' 값 (필드명 유지 — 이력 호환)
      const r4 = simV2(bars, r10, close, NM.ssV2.tan, fJ, 4);
      const r12v = simV2(bars, r10, close, NM.ssV2.tanAlt, fJ, NM.ssV2.win);
      st.eodDone = true;
      changed = true;

      // ⑥ 국장 1박 자격·비중 (사용자 확정 2026-08-08 — 정의·근거는 candleWindow.ts OvnRow 주석 참조).
      // 자격 = 창 첫판정 방향 == 피셔F 첫판정 방향(F 선행일 제외 — 그날은 진입 자체가 없다) · 당일 컷 아님.
      let ovnLine = "";
      if (!st.ovnDone && cw && !fFirstDay && fJ && fJ.dir === cw.dir && rMain.pnl > -2.4) {
        st.ovnDone = true;
        try {
          const t1 = bars[cw.i].time;
          const w = ovnWeight(cw.t, gapBig);
          const stopPct = ovnStopPct(hist);
          const { data: oRow } = await admin.from("ops_settings").select("value").eq("key", "predict_ssv2_ovn").maybeSingle();
          const arr = (Array.isArray(oRow?.value) ? (oRow!.value as OvnRow[]) : []).filter((r) => r.date !== today);
          arr.push({ date: today, dir: cw.dir, px: close, w, t1, gap: gapBig });
          await admin.from("ops_settings").upsert({ key: "predict_ssv2_ovn", value: arr.slice(-120), updated_at: new Date().toISOString() }, { onConflict: "key" });
          const done = arr.filter((r) => r.raw !== undefined);
          ovnLine = ` 1박${NM.ssOvnAdvise ? "" : "(채점 전용 — 지침 중단)"}: 오늘 자격(비중 ${w * 100}%) — 내일 시가 확정 · 누적 ${done.length}일 비중반영 ${pct(done.reduce((a, r) => a + (r.wtd ?? 0), 0))}(원값 ${pct(done.reduce((a, r) => a + (r.raw ?? 0), 0))}).`;
          if (NM.ssOvnAdvise) await send("predict_ssv2_ovn", "medium",
            `[예측·삼성전자 신모델 1박] 오늘 밤 1박 유지, 다음날 09:00 시가매도\n▶① 종가 기준 배정액의 ${w * 100}%를 ${cw.dir === 1 ? "레버리지" : "인버스"} ETF로 보유 (남은 게 적으면 종가에 채우고, 많으면 줄입니다)\n▶② 스탑설정: ${ovnStopLine(close, cw.dir, stopPct)}\n▶③ 내일 09:00 시가에 전량 매도\n무응답=1박 유지\n----\n자격: 창 첫판정(${t1} ${DIR_KO[cw.dir === 1 ? "up" : "down"]})과 피셔F가 같은 방향 = 동의일. 비중 ${w === 1 ? "100%(조기 확인·비갭)" : `50%(${cw.t > OVN_FULL_BY ? "창 확인 10시 이후" : ""}${cw.t > OVN_FULL_BY && gapBig ? "·" : ""}${gapBig ? "갭 4%+ 시작일" : ""})`}. 스탑은 규칙이 아니라 밤 재난선(최근 3일 평균 일중폭×0.75) — ⚠갭이 스탑 밖에서 시작하면 미체결이고 그 경우 09:00 시가 청산으로 처리합니다. 근거 217일 +182.9%p(비중 반영 +198.5).`);
        } catch { /* 1박 판정 실패는 본 흐름 무관 */ }
      }

      try {
        const { data: scRow } = await admin.from("ops_settings").select("value").eq("key", "predict_ssv2_scores").maybeSingle();
        const arr = (Array.isArray(scRow?.value) ? (scRow!.value as Score[]) : []).filter((s) => s.date !== today);
        arr.push({ date: today, p: Math.round(rMain.pnl * 100) / 100, p5: Math.round(r5.pnl * 100) / 100, p4: Math.round(r4.pnl * 100) / 100, p12: Math.round(r12v.pnl * 100) / 100, cut: rMain.cut, ...(fFirstDay ? { note: "F선행 관망" } : {}) });
        const kept = arr.slice(-120);
        await admin.from("ops_settings").upsert({ key: "predict_ssv2_scores", value: kept, updated_at: new Date().toISOString() }, { onConflict: "key" });
        const sum = (f: (s: Score) => number) => kept.reduce((a, s) => a + f(s), 0);
        const phase = live ? "시범" : "검증(페이퍼)";
        await send("predict_ssv2_eod", "low",
          `[예측·삼전 신모델 결산] ${phase} — 오늘 ${NM.ssV2.win}봉(주기준) ${pct(rMain.pnl)} · 6봉(대조) ${pct(r5.pnl)} · 4봉 ${pct(r4.pnl)}${st.entryT ? ` (진입 ${st.entryT}${st.revT ? `·전환 ${st.revT}` : ""}${st.stop1T ? `·스탑 ${st.stop1T}` : ""})` : fFirstDay ? " (F선행 — 관망일)" : " (판정 없음)"}\n----\n누적 ${kept.length}일: 주기준 ${pct(sum((s) => s.p))} · 대조칸 ${pct(sum((s) => s.p5))} · 4봉 ${pct(sum((s) => s.p4))} · 1.2판 ${pct(sum((s) => s.p12))} (주기준 8/5까지 6봉·이후 5봉 — 사용자 전환 지시). 백테스트 rebox판: 5봉 +115.4·6봉 +112.8 — 60일 채점이 최종 판정. 산식: 창 판정가 기준·스탑 -1.5%·종가청산.${ovnLine}`);
      } catch { /* 채점 실패는 상태 저장 무관 */ }
    }

    if (changed || !prevRaw || prevRaw.date !== today) {
      await admin.from("ops_settings").upsert({ key: "predict_ssv2_state", value: st, updated_at: new Date().toISOString() }, { onConflict: "key" });
    }
  } catch { /* 신모델 스트림 실패는 본 흐름을 막지 않는다 */ }
}
