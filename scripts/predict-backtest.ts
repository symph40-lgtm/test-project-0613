// 대가 방법론 예측 모델 — 과거 90거래일 검증 러너. 기획: docs/predict-models-spec.md 3장.
//   npx tsx scripts/predict-backtest.ts            # 검증만
//   npx tsx scripts/predict-backtest.ts --days 90  # 기간 지정
//   npx tsx scripts/predict-backtest.ts --seed     # 결과를 predict_* 테이블에 초기 이력으로 적재
//
// 미래 정보 차단: 각 날짜에 일봉은 전일까지, 분봉은 10:30 직전 완성봉까지만 입력.
// 앙상블은 워크포워드 — 그날 이전 기록만으로 가중치 산출.
// KIS 분봉은 .predict-cache/에 캐시 — 재실행 시 무통신.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { labelDay } from "../lib/predict/label";
import { runAllModels } from "../lib/predict/runner";
import { runEnsemble } from "../lib/predict/ensemble";
import { fetchDayMinutes, clipToJudgeWindow } from "../lib/predict/kisMinute";
import { fetchDailyPredict } from "../lib/predict/data";
import { MODEL_IDS, MODEL_LABELS } from "../lib/predict/types";
import type { AccuracyStat, MinuteBar, ModelId, PredictDailyBar, Verdict } from "../lib/predict/types";

// ── .env.local 로드 (스크립트 전용 — Next 밖이라 수동)
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
const DAYS = (() => {
  const i = args.indexOf("--days");
  return i >= 0 ? parseInt(args[i + 1], 10) : 90;
})();
const SEED = args.includes("--seed");
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");

// ── 분봉 캐시
async function dayMinutesCached(code: string, date: string): Promise<MinuteBar[] | null> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = resolve(CACHE_DIR, `${code}-${date}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as MinuteBar[] | null;
      if (cached && cached.length > 0) return cached;
    } catch { /* 캐시 손상 — 재수집 */ }
  }
  const ymd = date.replace(/-/g, "");
  const bars = await fetchDayMinutes(code, ymd, "153000");
  if (bars) writeFileSync(file, JSON.stringify(bars));
  return bars;
}

type DayResult = {
  date: string;
  label: Verdict;
  rOC: number;
  verdicts: Record<ModelId, Verdict>;
  confidences: Record<ModelId, number>;
  reasons: Record<ModelId, string>;
  finalVerdict: Verdict;
  strengthPct: number;
  weights: Record<ModelId, number>;
  ret1030ToClose: number | null; // 10:30→종가 % (경제적 가치)
};

async function main() {
  const code = PREDICT_CONFIG.symbol;
  console.log(`=== 대가 방법론 예측 모델 백테스트 — ${code} 최근 ${DAYS}거래일 ===\n`);

  const daily = await fetchDailyPredict(code, DAYS + 140);
  if (daily.length < DAYS + 40) throw new Error(`일봉 부족: ${daily.length}개`);

  // 오늘(미완결 가능)은 제외 — KST 기준
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const complete = daily.filter((b) => b.date < todayKst);
  const testDays = complete.slice(-DAYS);
  console.log(`검증 구간: ${testDays[0].date} ~ ${testDays[testDays.length - 1].date}`);

  // 분봉 수집 (검증 첫날의 전일부터 — 달튼 VA용)
  const needDates = complete.slice(-(DAYS + 1)).map((b) => b.date);
  const minutes = new Map<string, MinuteBar[]>();
  let fetched = 0;
  for (const d of needDates) {
    const bars = await dayMinutesCached(code, d);
    if (bars) minutes.set(d, bars);
    if (++fetched % 10 === 0) process.stdout.write(`\r분봉 수집 ${fetched}/${needDates.length}일`);
  }
  console.log(`\r분봉 수집 완료: ${minutes.size}/${needDates.length}일 확보\n`);

  // ── 워크포워드 실행
  const acc: Record<ModelId, AccuracyStat> = Object.fromEntries(MODEL_IDS.map((m) => [m, { correct: 0, total: 0 }])) as Record<ModelId, AccuracyStat>;
  const results: DayResult[] = [];
  const skipped: string[] = [];

  for (const bar of testDays) {
    const idx = complete.findIndex((b) => b.date === bar.date);
    const history = complete.slice(Math.max(0, idx - 120), idx);
    const dayMin = minutes.get(bar.date);
    if (!dayMin || dayMin.length < 60 || history.length < 30) {
      skipped.push(bar.date);
      continue;
    }
    const prevDate = complete[idx - 1]?.date;
    const morning = clipToJudgeWindow(dayMin, PREDICT_CONFIG.judgeHour);
    const input = {
      date: bar.date,
      dailyHistory: history,
      openPx: bar.open,
      morning,
      prevDayMinutes: prevDate ? minutes.get(prevDate) ?? null : null,
    };
    const outputs = runAllModels(input);
    const ens = runEnsemble(outputs, acc); // 이 시점까지의 누적 정확도만 사용 (워크포워드)
    const { label, rOC } = labelDay(bar);

    const px1030 = morning.length ? morning[morning.length - 1].close : null;
    const r: DayResult = {
      date: bar.date,
      label,
      rOC,
      verdicts: {} as Record<ModelId, Verdict>,
      confidences: {} as Record<ModelId, number>,
      reasons: {} as Record<ModelId, string>,
      finalVerdict: ens.finalVerdict,
      strengthPct: ens.strengthPct,
      weights: ens.weights,
      ret1030ToClose: px1030 ? Number((((bar.close - px1030) / px1030) * 100).toFixed(2)) : null,
    };
    for (const o of outputs) {
      r.verdicts[o.model] = o.verdict;
      r.confidences[o.model] = o.confidence;
      r.reasons[o.model] = o.reason;
      acc[o.model].total += 1;
      if (o.verdict === label) acc[o.model].correct += 1;
    }
    results.push(r);
  }

  if (skipped.length) console.log(`제외된 날(분봉/이력 부족): ${skipped.join(", ")}\n`);
  const n = results.length;

  // ── 라벨 분포
  const dist = { leverage: 0, inverse: 0, none: 0 } as Record<Verdict, number>;
  for (const r of results) dist[r.label]++;
  console.log(`라벨 분포 (${n}일): 레버리지 ${dist.leverage} · 인버스 ${dist.inverse} · 추세없음 ${dist.none}`);
  const majority = Math.max(dist.leverage, dist.inverse, dist.none) / n;
  console.log(`다수 클래스 기준선: ${(majority * 100).toFixed(1)}%\n`);

  // ── 모델별 성적
  const labelP: Record<Verdict, number> = {
    leverage: dist.leverage / n, inverse: dist.inverse / n, none: dist.none / n,
  };
  console.log("── 모델별 성적 ──────────────────────────────────────────────");
  console.log("모델                          | 정확도   | 우연기준 | 리프트  | 방향적중  | 방향판정수");
  for (const m of MODEL_IDS) {
    const total = acc[m].total;
    const accuracy = total ? acc[m].correct / total : 0;
    // 우연 기준선: 모델 판정 분포 × 라벨 분포 내적 (그라임스식 검증)
    const vd = { leverage: 0, inverse: 0, none: 0 } as Record<Verdict, number>;
    for (const r of results) vd[r.verdicts[m]]++;
    const chance = (["leverage", "inverse", "none"] as Verdict[]).reduce((s, v) => s + (vd[v] / n) * labelP[v], 0);
    // 방향 판정(none 제외) 시 방향 적중률 — "질렀을 때 맞았나"
    const called = results.filter((r) => r.verdicts[m] !== "none");
    const dirHit = called.filter((r) => r.verdicts[m] === r.label).length;
    console.log(
      `${MODEL_LABELS[m].padEnd(26)} | ${(accuracy * 100).toFixed(1).padStart(5)}%  | ${(chance * 100).toFixed(1).padStart(5)}%  | ${((accuracy - chance) * 100 >= 0 ? "+" : "") + ((accuracy - chance) * 100).toFixed(1).padStart(5)}%p | ${called.length ? ((dirHit / called.length) * 100).toFixed(1).padStart(6) + "%" : "   —   "} | ${called.length}회`,
    );
  }

  // ── 앙상블 (워크포워드)
  const ensCorrect = results.filter((r) => r.finalVerdict === r.label).length;
  const ensCalled = results.filter((r) => r.finalVerdict !== "none");
  const ensDirHit = ensCalled.filter((r) => r.finalVerdict === r.label).length;
  console.log("\n── 앙상블 (워크포워드 — 그날 이전 정확도만 가중치로 사용) ──");
  console.log(`3분류 정확도: ${((ensCorrect / n) * 100).toFixed(1)}% (${ensCorrect}/${n})`);
  console.log(`방향 판정 시 적중: ${ensCalled.length ? ((ensDirHit / ensCalled.length) * 100).toFixed(1) : "—"}% (${ensDirHit}/${ensCalled.length})`);

  // 경제적 가치 — 최종 판정별 10:30→종가 평균 수익률
  const avg = (rows: DayResult[]) => (rows.length ? rows.reduce((s, r) => s + (r.ret1030ToClose ?? 0), 0) / rows.length : null);
  const lev = results.filter((r) => r.finalVerdict === "leverage");
  const inv = results.filter((r) => r.finalVerdict === "inverse");
  const fmtAvg = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  console.log(`\n10:30→종가 평균 (본주 기준): 레버리지 판정일 ${fmtAvg(avg(lev))} (${lev.length}일) · 인버스 판정일 ${fmtAvg(avg(inv))} (${inv.length}일)`);
  const invAvg = avg(inv);
  const levAvg = avg(lev);
  const edge = (levAvg ?? 0) * lev.length - (invAvg ?? 0) * inv.length;
  console.log(`방향 매매 총 엣지(레버리지 롱 + 인버스 숏 합산): ${edge >= 0 ? "+" : ""}${edge.toFixed(2)}%p 누적`);

  // ── 최근 15일 상세
  console.log("\n── 최근 15일 상세 (판정 vs 실제) ──");
  console.log("날짜        | 크레이블 | 라쉬케  | 피셔    | 달튼    | 그라임스 | 최종(강도)      | 실제");
  const short = (v: Verdict) => (v === "leverage" ? "레버리지" : v === "inverse" ? "인버스 " : "없음  ");
  for (const r of results.slice(-15)) {
    const cells = MODEL_IDS.map((m) => {
      const hit = r.verdicts[m] === r.label ? "○" : "✕";
      return `${short(r.verdicts[m])}${hit}`;
    });
    console.log(`${r.date} | ${cells.join(" | ")} | ${short(r.finalVerdict)} ${String(r.strengthPct).padStart(4)}% ${r.finalVerdict === r.label ? "○" : "✕"} | ${short(r.label)} (${r.rOC >= 0 ? "+" : ""}${r.rOC}%)`);
  }

  // ── 최종 누적 정확도 (시딩될 가중치)
  console.log("\n── 누적 정확도 (가동 시 초기 가중치) ──");
  for (const m of MODEL_IDS) {
    console.log(`${MODEL_LABELS[m].padEnd(26)}: ${acc[m].correct}/${acc[m].total} = ${((acc[m].correct / Math.max(1, acc[m].total)) * 100).toFixed(1)}%`);
  }

  // ── DB 시딩
  if (SEED) {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE 환경변수 없음");
    const sb = createClient(url, key);
    const modelRows = results.flatMap((r) =>
      MODEL_IDS.map((m) => ({
        date: r.date,
        model: m,
        verdict: r.verdicts[m],
        confidence: r.confidences[m],
        reason: r.reasons[m],
        label: r.label,
        correct: r.verdicts[m] === r.label,
        source: "backtest",
      })),
    );
    const dayRows = results.map((r) => ({
      date: r.date,
      label: r.label,
      r_oc: r.rOC,
      final_verdict: r.finalVerdict,
      strength: r.strengthPct,
      weights: r.weights,
      model_verdicts: r.verdicts,
      labeled_at: new Date().toISOString(),
      source: "backtest",
    }));
    for (let i = 0; i < modelRows.length; i += 200) {
      const { error } = await sb.from("predict_model_days").upsert(modelRows.slice(i, i + 200), { onConflict: "date,model" });
      if (error) throw new Error(`predict_model_days 시딩 실패: ${error.message}`);
    }
    for (let i = 0; i < dayRows.length; i += 200) {
      const { error } = await sb.from("predict_days").upsert(dayRows.slice(i, i + 200), { onConflict: "date" });
      if (error) throw new Error(`predict_days 시딩 실패: ${error.message}`);
    }
    console.log(`\n✅ DB 시딩 완료: ${modelRows.length}건(모델) + ${dayRows.length}건(앙상블)`);
  }
}

main().catch((e) => {
  console.error("백테스트 실패:", e);
  process.exit(1);
});
