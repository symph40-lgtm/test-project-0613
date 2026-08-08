// G1A v0.3 서비스 — 일일 사이클 상태 머신 (스펙 §2). 크론이 어느 시각에 불러도 창구를 보고 알아서 동작.
//   15:05~15:25  T1 스냅샷 (기록 전용, §7)
//   16:30~19:40  T2 감시 루프 (10분 격자, 조기 트리거 §5.1 / 19:40 최종 §5.2)
//   트리거~19:55 반전 감시 (§5.5)
//   09:05~10:30  전일 라벨 채점 (L1'·L1·L2·L3, §3)
// log-only: 자본 없음·문자 없음(리포트 텍스트만 저장). 일정 체계는 SPEC_G1_OPT_loop가 지배.

import { fetchDaily } from "@/lib/predict-daily/data"; // 공용 참조 전례 (캘린더·flow와 동일)
import { fetchDayMinutes, fetchNxtPremarket } from "@/lib/predict/kisMinute";
import { G1A_CONFIG } from "./config";
import {
  fetchCircuitBreaker, fetchDayCharacter, fetchEventTonight, fetchEuropeTone,
  fetchFrnDecel, fetchMacroZ, fetchNxtState, fetchPremarketBasket, fetchTsmcResidual, fetchUsFutDelta,
} from "./data";
import { buildReversalReport, buildT2Report } from "./report";
import { abstainReason, evaluateT2, isExpiryDay, reversalCheck, type AbstainCtx } from "./score";
import { g1aTablesReady, loadDay, loadUnlabeled, upsertDay } from "./store";
import type { G1ARow, G1ASymbol, T2Features, T2State } from "./types";

const SYMBOLS: G1ASymbol[] = ["000660", "005930"];
const W = G1A_CONFIG.windows;

function kst(): { date: string; hhmm: string; hhmmss: string; weekday: number } {
  const d = new Date(Date.now() + 9 * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    hhmm: d.toISOString().slice(11, 16),
    hhmmss: d.toISOString().slice(11, 19),
    weekday: d.getUTCDay(),
  };
}

async function collectT2Features(symbol: G1ASymbol): Promise<T2Features> {
  const [basket, usfut, europe, tsmc, dayChar, frn, macro] = await Promise.all([
    fetchPremarketBasket(symbol), fetchUsFutDelta(), fetchEuropeTone(),
    fetchTsmcResidual(), fetchDayCharacter(symbol), fetchFrnDecel(symbol), fetchMacroZ(),
  ]);
  const nxt = await fetchNxtState(symbol, dayChar.regClose);
  return {
    F21_basket: basket.rBasket, F21_dcpm: basket.dcpm, F21_obs_min: basket.obsMin,
    F22_usfut: usfut, F20_europe: europe.pct, F20_obs_min: europe.obsMin,
    F11p_tsmc_resid: tsmc,
    F01_clv: dayChar.clv, F02_dc1: dayChar.dc1, F04_o1: dayChar.o1, F09_c1: null,
    F08_frn_decel: frn, F05_w1: null, F07_b1_z: null,
    F13_rate_z: macro.rateZ, F14_fx_z: macro.fxZ, F24_news: null,
    r_nxt: nxt.rNxt, nxt_last_px: nxt.lastPx, spread_pct: null, // 호가 API 부재 (config 참조)
  };
}

async function buildAbstainCtx(f: T2Features): Promise<AbstainCtx> {
  const { date, weekday } = kst();
  const [event, cb] = await Promise.all([fetchEventTonight(), fetchCircuitBreaker()]);
  return {
    dateKst: date, weekday, eventTonight: event, impliedMoveRatio: null,
    circuitBreaker: cb, expiryToday: isExpiryDay(date),
  };
}

// ── T1 스냅샷 (§7 — 판정·리포트·자본 없음) ──
async function runT1(date: string): Promise<string[]> {
  const notes: string[] = [];
  for (const symbol of SYMBOLS) {
    const row = (await loadDay(date, symbol)) ?? { date, symbol, t1_snapshot: null, t2: null, labels: null, outcome: null };
    if (row.t1_snapshot) continue;
    const dayChar = await fetchDayCharacter(symbol);
    const frn = await fetchFrnDecel(symbol);
    row.t1_snapshot = {
      taken_at: kst().hhmmss,
      gap_score_virtual: null, // T2 가중 체계는 저녁 피처 전제 — 15:10 가상 점수는 당일 캐릭터만으로 무의미해 미산출 (기록만)
      features: { F01_clv: dayChar.clv, F02_dc1: dayChar.dc1, F04_o1: dayChar.o1, F08_frn_decel: frn },
    };
    await upsertDay(row);
    notes.push(`${symbol} T1 스냅샷`);
  }
  return notes;
}

// ── T2 사이클 (§5) ──
async function runT2(date: string, hhmm: string, hhmmss: string): Promise<string[]> {
  const notes: string[] = [];
  const rows = new Map<G1ASymbol, G1ARow>();
  for (const symbol of SYMBOLS) {
    rows.set(symbol, (await loadDay(date, symbol)) ?? { date, symbol, t1_snapshot: null, t2: null, labels: null, outcome: null });
  }
  for (const symbol of SYMBOLS) {
    const row = rows.get(symbol)!;
    const t2: T2State = row.t2 ?? {
      trigger_type: null, trigger_time: null, entry_px_virtual: null, verdict: null,
      reversal_watch: { fired: false, time: null, action: null }, evals: [], report_r1: null,
    };
    // 10분 격자: 같은 슬롯 중복 평가 방지 (크론이 1~2분 간격이어도 무해)
    const slot = hhmm.slice(0, 4) + String(Math.floor(parseInt(hhmm.slice(3, 5), 10) / W.slotMinutes) * W.slotMinutes).padStart(2, "0");
    const already = t2.evals.some((e) => e.time.startsWith(slot.slice(0, 3)) && e.time.slice(3, 5) >= slot.slice(4));

    if (!t2.trigger_type && hhmm <= W.t2Final) {
      if (already && hhmm < W.t2Final) continue;
      const f = await collectT2Features(symbol);
      const ctx = await buildAbstainCtx(f);
      const isFinal = hhmm >= W.t2Final;
      const other = [...rows.values()].some((r) => r.symbol !== symbol && r.t2?.trigger_type && r.t2.verdict?.direction !== "NEUTRAL");
      const { verdict, blocked } = evaluateT2(symbol, f, ctx, hhmm, isFinal, other);
      t2.evals.push({ time: hhmm, gap_score: verdict.gap_score, blocked_by: blocked });
      if (!blocked && verdict.direction !== "NEUTRAL") {
        t2.trigger_type = isFinal ? "F" : "E";
        t2.trigger_time = hhmmss;
        t2.entry_px_virtual = f.nxt_last_px;
        t2.verdict = verdict;
        t2.report_r1 = buildT2Report(symbol, t2.trigger_type, hhmm, verdict, f, date);
        notes.push(`${symbol} T2-${t2.trigger_type} ${verdict.direction}·${verdict.confidence} (score ${verdict.gap_score})`);
      } else if (isFinal) {
        t2.trigger_type = "F";
        t2.trigger_time = hhmmss;
        t2.verdict = verdict; // NEUTRAL 확정 (abstain 사유 포함)
        t2.report_r1 = buildT2Report(symbol, "F", hhmm, verdict, f, date);
        notes.push(`${symbol} T2-F NEUTRAL (${blocked ?? verdict.abstain_reason ?? "θ 미달"})`);
      } else {
        notes.push(`${symbol} 대기 (${blocked})`);
      }
    } else if (
      t2.trigger_type && t2.verdict && t2.verdict.direction !== "NEUTRAL" &&
      !t2.reversal_watch.fired && hhmm <= W.t2End
    ) {
      // §5.5 반전 감시
      const f = await collectT2Features(symbol);
      const rev = reversalCheck(t2.verdict.direction, f);
      if (rev.fired) {
        t2.reversal_watch = { fired: true, time: hhmmss, action: "19:55 전 전량 청산(가상)" };
        t2.report_r1 = (t2.report_r1 ?? "") + "\n\n" + buildReversalReport(symbol, hhmm, rev.why!, t2);
        notes.push(`${symbol} 반전 감시 발동 — ${rev.why}`);
      }
    }
    row.t2 = t2;
    await upsertDay(row);
  }
  return notes;
}

// ── 라벨 채점 (§3 — D+1 오전) ──
async function runLabels(): Promise<string[]> {
  const notes: string[] = [];
  const today = kst().date;
  const unlabeled = await loadUnlabeled();
  for (const row of unlabeled) {
    if (row.date >= today) continue;           // 오늘 판정분은 내일 채점
    if (!row.t2?.trigger_type) continue;       // 판정 자체가 없던 날(주말 등)은 스킵
    const symbol = row.symbol;
    const daily = await fetchDaily(symbol, 15);
    const di = daily.findIndex((b) => b.date === row.date);
    const d1 = daily.find((b, i) => i > di && b.open > 0);
    if (di < 0 || !d1 || d1.date > today) continue; // D+1 시가 미확정
    const closeD = daily[di].close;
    const L1 = closeD > 0 ? ((d1.open - closeD) / closeD) * 100 : null;
    const entry = row.t2.entry_px_virtual;
    const L1p = entry && entry > 0 ? ((d1.open - entry) / entry) * 100 : null;
    // L2: NXT 프리 첫 체결 / L3: 시가+30분
    let L2: number | null = null, L3: number | null = null;
    try {
      const pre = await fetchNxtPremarket(symbol, d1.date.replace(/-/g, ""));
      if (pre?.length && entry) L2 = ((pre[0].close - entry) / entry) * 100;
      const mins = await fetchDayMinutes(symbol, d1.date.replace(/-/g, ""), "094500");
      const at930 = mins?.filter((m) => m.time <= "09:30").pop();
      if (at930 && d1.open > 0) L3 = ((at930.close - d1.open) / d1.open) * 100;
    } catch { /* 보조 라벨 결측 허용 */ }
    const r2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);
    row.labels = {
      L1p: r2(L1p), L1: r2(L1), L2: r2(L2), L3: r2(L3),
      capture_ratio: L1p != null && L1 != null && Math.abs(L1) > 0.05 ? Math.round((L1p / L1) * 100) / 100 : null,
    };
    const v = row.t2.verdict;
    const hit = v && v.direction !== "NEUTRAL" && L1p != null
      ? (v.direction === "UP" ? L1p >= G1A_CONFIG.label.flatBand : L1p <= -G1A_CONFIG.label.flatBand)
      : null;
    row.outcome = { hit, luck_flag: false, postmortem: "" };
    await upsertDay(row);
    notes.push(`${symbol} ${row.date} 라벨 (L1' ${row.labels.L1p ?? "—"}%)`);
  }
  return notes;
}

export async function runG1AService(): Promise<{ ok: boolean; window: string; notes: string[] }> {
  const { date, hhmm, hhmmss, weekday } = kst();
  if (!(await g1aTablesReady())) return { ok: false, window: "none", notes: ["마이그레이션 034 미적용 — g1a_days 없음"] };
  if (weekday === 0 || weekday === 6) return { ok: true, window: "weekend", notes: [] };

  if (hhmm >= W.labelStart && hhmm <= W.labelEnd) return { ok: true, window: "labels", notes: await runLabels() };
  if (hhmm >= W.t1Start && hhmm <= W.t1End) return { ok: true, window: "t1", notes: await runT1(date) };
  if (hhmm >= W.t2Start && hhmm <= W.t2End) return { ok: true, window: "t2", notes: await runT2(date, hhmm, hhmmss) };
  return { ok: true, window: "idle", notes: [] };
}
