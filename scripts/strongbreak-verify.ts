// 강돌파 즉시확인 검증 (사용자 요청 2026-07-25) — 발생횟수·정확도·앞당김 실측.
//   npx tsx scripts/strongbreak-verify.ts [--days 224]   (.predict-cache 재사용, 삼전 NX는 첫 실행 시 수집)
//
// 대상 (라이브 적용처 그대로):
//   ① 조기창 피셔F — 0.05·4봉·강돌파 0.1, 08:00 연속창(NXT 프리장+정규장), 컷 10:30
//   ② 본판정 스트림 — 0.15·8봉·강돌파 0.1, 09:00 정규장창, 컷 14:00 (스트림 전용 — 확정 스냅샷은 원전)
// 방법: 같은 날 강돌파 on/off로 runFisher(운영 함수 그대로)를 두 번 돌려 결과가 달라진 날 = 발동일.
//   발동 유형: 시각 앞당김(방향 동일·확인 조기화) / 신규 방향(없음→방향) / 판정 변화(방향 상이).
//   정확도: 발동일에서 on/off 각각의 일봉 라벨(±1.2%) 방향적중 비교 + 전체 224일 on/off 비교.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import { labelDay } from "../lib/predict/label";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cached(code: string, date: string, kind: "KRX" | "NX"): Promise<MinuteBar[] | null> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = kind === "KRX" ? `${code}-${date}.json` : `${code}NX-${date}.json`;
  const path = resolve(CACHE_DIR, file);
  if (existsSync(path)) {
    try { const b = JSON.parse(readFileSync(path, "utf8")) as MinuteBar[]; if (b?.length) return b; } catch { /* 재수집 */ }
  }
  const marker = resolve(CACHE_DIR, `${file}.none`);
  if (existsSync(marker)) return null;
  const ymd = date.replace(/-/g, "");
  const bars = kind === "KRX" ? await fetchDayMinutes(code, ymd, "153000") : await fetchNxtPremarket(code, ymd);
  await sleep(150);
  if (bars && bars.length) writeFileSync(path, JSON.stringify(bars));
  else writeFileSync(marker, "1");
  return bars;
}

const confirmOf = (reason: string): string | null => reason.match(/^(\d{2}:\d{2}) A[상하] 확인/)?.[1] ?? null;
const hhmmToMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const V = (v: Verdict) => (v === "leverage" ? "레버" : v === "inverse" ? "인버" : "없음");

type TierResult = {
  n: number;
  fired: { date: string; kind: string; onV: Verdict; offV: Verdict; onAt: string | null; offAt: string | null; label: Verdict; savedMin: number | null }[];
  onDir: { c: number; t: number }; offDir: { c: number; t: number }; // 전체 방향적중
  on3: number; off3: number; // 전체 3분류 적중일수
};

async function runSymbol(code: string, name: string): Promise<void> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
  const testDays = daily.slice(-DAYS);
  console.log(`\n════ ${name} (${code}) — ${testDays[0].date} ~ ${testDays[testDays.length - 1].date} ════`);

  const tiers: Record<string, TierResult> = {
    early: { n: 0, fired: [], onDir: { c: 0, t: 0 }, offDir: { c: 0, t: 0 }, on3: 0, off3: 0 },
    late: { n: 0, fired: [], onDir: { c: 0, t: 0 }, offDir: { c: 0, t: 0 }, on3: 0, off3: 0 },
  };

  for (const bar of testDays) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const hist = daily.slice(Math.max(0, idx - 120), idx);
    const krx = await cached(code, bar.date, "KRX");
    if (!krx || krx.length < 60) continue;
    const pre = await cached(code, bar.date, "NX");
    const { label } = labelDay(bar);

    const judge = (
      tier: "early" | "late",
      window: MinuteBar[], openPx: number,
      cfgBase: Parameters<typeof runFisher>[1], sbRatio: number,
    ) => {
      const t = tiers[tier];
      t.n++;
      const on = runFisher({ date: bar.date, dailyHistory: hist, openPx, morning: window, prevDayMinutes: null }, { ...cfgBase, strongBreakRatio: sbRatio });
      const off = runFisher({ date: bar.date, dailyHistory: hist, openPx, morning: window, prevDayMinutes: null }, { ...cfgBase, strongBreakRatio: 0 });
      for (const [out, agg, hit3] of [[on, t.onDir, "on3"], [off, t.offDir, "off3"]] as const) {
        if (out.verdict !== "none") { agg.t++; if (out.verdict === label) agg.c++; }
        if (out.verdict === label) t[hit3]++;
      }
      const onAt = confirmOf(on.reason), offAt = confirmOf(off.reason);
      if (on.verdict !== off.verdict || onAt !== offAt) {
        const kind = on.verdict === off.verdict ? "앞당김" : off.verdict === "none" ? "신규방향" : "판정변화";
        const savedMin = onAt && offAt ? hhmmToMin(offAt) - hhmmToMin(onAt) : null;
        t.fired.push({ date: bar.date, kind, onV: on.verdict, offV: off.verdict, onAt, offAt, label, savedMin });
      }
    };

    // ① 조기창 피셔F — 08:00 연속창, 컷 10:30
    const cont = [...(pre ?? []), ...krx].filter((b) => b.time < "10:30");
    if (cont.length >= 19) {
      judge("early", cont, pre?.[0]?.open ?? cont[0].open, {
        offsetRangeRatio: PREDICT_CONFIG.earlyOffsetRatio,
        confirmMinutes: PREDICT_CONFIG.earlyConfirmMinutes,
      }, PREDICT_CONFIG.earlyStrongBreakRatio);
    }
    // ② 본판정 스트림 — 09:00 정규장창, 컷 14:00
    const reg = krx.filter((b) => b.time < "14:00");
    if (reg.length >= 23) {
      judge("late", reg, reg[0].open, {}, PREDICT_CONFIG.lateStrongBreakRatio);
    }
  }

  for (const [tier, tName] of [["early", "조기창 피셔F (0.05·4봉·sb0.1, ~10:30)"], ["late", "본판정 스트림 (0.15·8봉·sb0.1, ~14:00)"]] as const) {
    const t = tiers[tier];
    const f = t.fired;
    const pct = (c: number, n: number) => (n ? `${Math.round((100 * c) / n)}%` : "—");
    console.log(`\n── ${tName} · 검증 ${t.n}일 ──`);
    console.log(`강돌파 발동: ${f.length}일 (${pct(f.length, t.n)})`);
    for (const kind of ["앞당김", "신규방향", "판정변화"]) {
      const ks = f.filter((x) => x.kind === kind);
      if (!ks.length) continue;
      const dirOn = ks.filter((x) => x.onV !== "none");
      const hitOn = dirOn.filter((x) => x.onV === x.label).length;
      const saved = ks.filter((x) => x.savedMin !== null).map((x) => x.savedMin!);
      const avgSaved = saved.length ? ` · 평균 앞당김 ${Math.round(saved.reduce((a, b) => a + b, 0) / saved.length)}분` : "";
      let extra = "";
      if (kind !== "앞당김") {
        const dirOff = ks.filter((x) => x.offV !== "none");
        const hitOff = dirOff.filter((x) => x.offV === x.label).length;
        extra = ` · 원전판정 적중 ${hitOff}/${dirOff.length}`;
      }
      console.log(`  ${kind}: ${ks.length}일 · 강돌파판정 방향적중 ${hitOn}/${dirOn.length} (${pct(hitOn, dirOn.length)})${avgSaved}${extra}`);
    }
    console.log(`전체 방향적중: 강돌파ON ${t.onDir.c}/${t.onDir.t} (${pct(t.onDir.c, t.onDir.t)}) vs OFF ${t.offDir.c}/${t.offDir.t} (${pct(t.offDir.c, t.offDir.t)})`);
    console.log(`전체 3분류:   강돌파ON ${pct(t.on3, t.n)} vs OFF ${pct(t.off3, t.n)}`);
    if (f.length) {
      console.log(`  발동일 상세 (최근 8건):`);
      for (const x of f.slice(-8)) {
        console.log(`    ${x.date} [${x.kind}] ON ${V(x.onV)}${x.onAt ? `(${x.onAt})` : ""} / OFF ${V(x.offV)}${x.offAt ? `(${x.offAt})` : ""} → 실제 ${V(x.label)}${x.savedMin !== null ? ` · ${x.savedMin}분↑` : ""}`);
      }
    }
  }
}

(async () => {
  await runSymbol("000660", "하닉");
  await runSymbol("005930", "삼전");
})();
