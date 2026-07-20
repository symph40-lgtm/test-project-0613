// 애프터장 판정 서비스 (사용자 지정 2026-07-20) — NXT 애프터마켓 15:30~20:00, 하닉 본주 전용.
// 구조는 정규장 체크포인트 스트림의 축소판: 16:00 첫 판정 → 30분마다 → 19:30 확정,
// 사이 구간 모니터링(변경 시 문자), 세션 종료 후 라벨(±0.6% 스케일)로 채점.
// 판정자: 피셔 단독 (오프셋 = 0.15 × 당일 정규장 레인지 — 세션 스케일 근사, 미검증 초기값).
// 저장: predict_after_days (마이그레이션 027) — 정규장 채점과 완전 분리.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "./config";
import { fetchDailyPredict, kstNowPredict } from "./data";
import { fetchNxtAfterMarket } from "./kisMinute";
import { runFisher } from "./models/fisher";
import { avgRange } from "./indicators";
import type { MinuteBar, Verdict } from "./types";

const AH = PREDICT_CONFIG.after;
const V_KO: Record<Verdict, string> = { leverage: "상방(본주 매수)", inverse: "하방(관망·청산)", none: "추세없음" };
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type AfterRev = { at: string; checkpoint?: string; verdict: Verdict; strength: number };
type AfterRow = {
  date: string;
  final_verdict: Verdict;
  strength: number;
  stage: "open" | "final";
  revisions: AfterRev[] | null;
  label: Verdict | null;
};

async function loadAfterRow(date: string): Promise<AfterRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predict_after_days")
    .select("date, final_verdict, strength, stage, revisions, label")
    .eq("date", date)
    .maybeSingle();
  if (error) throw new Error(`predict_after_days 조회 실패(마이그레이션 027 확인): ${error.message}`);
  return (data as AfterRow | null) ?? null;
}

function labelAfter(bars: MinuteBar[]): { label: Verdict; rOC: number } {
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const rOC = ((close - open) / open) * 100;
  const pos = hi > lo ? (close - lo) / (hi - lo) : 0.5;
  const L = AH.label;
  let label: Verdict = "none";
  if (rOC >= L.trendMinPct && pos >= L.posUp) label = "leverage";
  else if (rOC <= -L.trendMinPct && pos <= L.posDown) label = "inverse";
  return { label, rOC: Number(rOC.toFixed(2)) };
}

// 애프터장 스트림 + 채점 — runPredictService에서 호출 (실패해도 정규장 흐름은 무관)
export async function runAfterService(): Promise<{ judged: boolean; scored: string[] }> {
  const code = PREDICT_CONFIG.symbol;
  const { date: today, minuteOfDay } = kstNowPredict();
  const admin = createAdminClient();
  const result = { judged: false, scored: [] as string[] };

  // ① 미채점 백필 (과거일 + 오늘 20:05 이후) — NX 과거 분봉으로 소급 가능
  const { data: unscored } = await admin
    .from("predict_after_days")
    .select("date")
    .is("label", null)
    .order("date", { ascending: true })
    .limit(10);
  for (const r of unscored ?? []) {
    const d = String(r.date);
    if (d === today && minuteOfDay < 20 * 60 + 5) continue; // 세션 종료 전
    const bars = await fetchNxtAfterMarket(code, d.replace(/-/g, ""), "200000");
    if (!bars || bars.length < 30) continue;
    const { label, rOC } = labelAfter(bars);
    await admin
      .from("predict_after_days")
      .update({ label, r_oc: rOC, labeled_at: new Date().toISOString() })
      .eq("date", d);
    result.scored.push(d);
  }

  // ② 라이브 스트림 (15:50~19:35 — 첫 15분 OR 형성 후)
  if (minuteOfDay < 15 * 60 + 50 || minuteOfDay > 19 * 60 + 35) return result;
  const prior = await loadAfterRow(today);
  if (prior && prior.stage === "final") return result;

  const daily = await fetchDailyPredict(code, 160);
  const todayBar = daily.find((b) => b.date === today);
  const history = daily.filter((b) => b.date < today).slice(-120);
  const range10 = avgRange(history, 10);
  if (!todayBar || range10 === null) return result;
  const bars = await fetchNxtAfterMarket(code, today.replace(/-/g, ""), "193000");
  if (!bars || bars.length < 20) return result;

  // 오프셋 = 세션 시가 × 0.4% (2026-07-21 개정 — 정규장 광폭 날 기회손실 해결, 189일 실측)
  // runFisher의 ratio(×avgRange10) 형태로 환산해 주입
  const offsetRatio = ((AH.offsetPct / 100) * bars[0].open) / range10;
  const judgeAt = (cutHHMM: string): { verdict: Verdict; strength: number } | null => {
    const w = bars.filter((b) => b.time < cutHHMM);
    if (w.length < 20) return null;
    const out = runFisher(
      { date: today, dailyHistory: history, openPx: bars[0].open, morning: w, prevDayMinutes: null },
      { offsetRangeRatio: offsetRatio, earlyConfirmBy: "17:00" },
    );
    return { verdict: out.verdict, strength: Number((out.confidence * 100).toFixed(0)) };
  };

  const sms = async (whenLabel: string, prev: Verdict | null, v: { verdict: Verdict; strength: number }, isFinal: boolean) => {
    if (!PREDICT_CONFIG.sms.enabled) return;
    const head = isFinal ? `애프터 확정(${AH.finalCp})` : `애프터 ${whenLabel}`;
    let text = prev === null
      ? `[예측·피셔] ${head} 첫 판정: ${V_KO[v.verdict]} (강도 ${v.strength}%)`
      : `[예측·피셔] ${head} 판정 변경: ${V_KO[prev]}→${V_KO[v.verdict]} (강도 ${v.strength}%)`;
    if (v.verdict !== "none") {
      text += `\n▶애프터장: 본주 전용(ETF 미운영) · 스탑 본주 -1.5% · 20:00 세션 종료 전 청산. 미검증 신호 — 소액만.`;
    }
    try {
      await dispatchToChannels("signal", today, {
        key: `predict_ah_${isFinal ? "final" : whenLabel.replace(":", "")}_${v.verdict}`,
        severity: "medium",
        text,
        smsSubject: "예측 애프터",
      });
    } catch { /* 발송 실패 무시 */ }
  };

  let revs: AfterRev[] = prior?.revisions ?? [];
  let changed = false;
  const done = new Set(revs.map((r) => r.checkpoint).filter(Boolean));

  for (const cp of AH.checkpoints) {
    if (hhmmToMin(cp) + 1 > minuteOfDay || done.has(cp)) continue;
    const fin = judgeAt(cp);
    if (!fin) continue;
    const prev = revs.length ? revs[revs.length - 1].verdict : null;
    revs = [...revs, { at: new Date().toISOString(), checkpoint: cp, verdict: fin.verdict, strength: fin.strength }];
    changed = true;
    const isFinal = cp === AH.finalCp;
    // 문자: 변경 시 + 확정은 방향일 때 항상 (사용자: "확정판결이 나오면 정규장처럼 보내줘")
    if (fin.verdict !== prev && !(prev === null && fin.verdict === "none")) await sms(cp, prev, fin, isFinal);
    else if (isFinal && fin.verdict !== "none") await sms(cp, null, fin, true);
  }

  // 모니터링 (체크포인트 사이 변경)
  if (revs.length > 0 && minuteOfDay <= hhmmToMin(AH.finalCp)) {
    const nowHHMM = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    const fin = judgeAt(nowHHMM < AH.finalCp ? nowHHMM : AH.finalCp);
    const last = revs[revs.length - 1];
    if (fin && fin.verdict !== last.verdict) {
      revs = [...revs, { at: new Date().toISOString(), verdict: fin.verdict, strength: fin.strength }];
      changed = true;
      await sms(nowHHMM, last.verdict, fin, false);
    }
  }

  if (!changed || revs.length === 0) return result;
  const isFinal = revs.some((r) => r.checkpoint === AH.finalCp);
  const latest = revs[revs.length - 1];
  await admin.from("predict_after_days").upsert(
    { date: today, final_verdict: latest.verdict, strength: latest.strength, stage: isFinal ? "final" : "open", revisions: revs },
    { onConflict: "date" },
  );
  result.judged = true;
  return result;
}

// 페이지용 로더 — 마이그레이션 027 미적용이면 null
export async function loadAfterDays(n: number): Promise<
  { date: string; final_verdict: string; strength: number; stage: string; label: string | null; r_oc: number | null; revisions: AfterRev[] | null }[] | null
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predict_after_days")
    .select("date, final_verdict, strength, stage, label, r_oc, revisions")
    .order("date", { ascending: false })
    .limit(n);
  if (error) return null;
  return (data ?? []) as never;
}
