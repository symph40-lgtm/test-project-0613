// 애프터 확정 방향 → 다음날 갭·시초 방향 실측 (사용자 승인 2026-07-26 — "내일 갭 대비" 동봉 근거).
//   npx tsx scripts/after-gap-sweep.ts
//
// 질문: 애프터장 확정(19:30 컷) 방향이 다음날 시가 갭·시초 30분·시가→종가를 예측하는가?
// 데이터:
//   하닉 — .predict-cache/000660NXA-*.json (애프터 분봉 189일)에서 19:30 컷 판정 재계산
//          (after.ts와 동일: 오프셋 = 세션 시가 0.4%/avgRange10, earlyConfirmBy 17:00).
//   삼전 — predict_track_days(after/fisher) 224일 시딩 판정 (Supabase REST, 서비스 키).
//   다음날 갭·시초는 일봉(fetchDailyPredict) + 정규장 분봉 캐시(09:00~09:30).
// 채택 기준: 방향 그룹이 기준선(전체) 대비 두 종목 일관되게 갈릴 때만 문자 동봉.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (file: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};

type Row = { date: string; verdict: Verdict };

async function ssVerdicts(): Promise<Row[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return [];
  const r = await fetch(`${url}/rest/v1/predict_track_days?symbol=eq.005930&session=eq.after&model=eq.fisher&select=date,verdict&order=date.asc`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!r.ok) return [];
  return (await r.json()) as Row[];
}

async function hxVerdicts(): Promise<Row[]> {
  const daily = await fetchDailyPredict("000660", 400);
  const out: Row[] = [];
  for (let i = 30; i < daily.length; i++) {
    const d = daily[i].date;
    const bars = readCache(`000660NXA-${d}.json`);
    if (!bars || bars.length < 23) continue;
    const w = bars.filter((b) => b.time < "19:30");
    if (w.length < 20) continue;
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (r10 === null) continue;
    const offsetRatio = ((0.4 / 100) * bars[0].open) / r10;
    const o = runFisher(
      { date: d, dailyHistory: hist, openPx: bars[0].open, morning: w, prevDayMinutes: null },
      { offsetRangeRatio: offsetRatio, earlyConfirmBy: "17:00" },
    );
    out.push({ date: d, verdict: o.verdict });
  }
  return out;
}

function analyze(name: string, code: string, rows: Row[], daily: { date: string; open: number; close: number }[]): void {
  const byDate = new Map(daily.map((b, i) => [b.date, i]));
  type Nx = { gap: number; r30: number | null; rOC: number };
  const groups: Record<Verdict, Nx[]> = { leverage: [], inverse: [], none: [] };
  const all: Nx[] = [];
  for (const r of rows) {
    const i = byDate.get(r.date);
    if (i === undefined || i + 1 >= daily.length) continue;
    const nx = daily[i + 1];
    const gap = ((nx.open - daily[i].close) / daily[i].close) * 100;
    const rOC = ((nx.close - nx.open) / nx.open) * 100;
    const reg = readCache(`${code}-${nx.date}.json`);
    let r30: number | null = null;
    if (reg && reg.length > 35) {
      const b30 = reg.filter((b) => b.time <= "09:30");
      if (b30.length >= 25) r30 = ((b30[b30.length - 1].close - reg[0].open) / reg[0].open) * 100;
    }
    const x = { gap, r30, rOC };
    groups[r.verdict].push(x);
    all.push(x);
  }
  const stat = (a: Nx[], label: string) => {
    if (!a.length) { console.log(`  ${label}: 0건`); return; }
    const gaps = a.map((x) => x.gap).sort((p, q) => p - q);
    const med = gaps[Math.floor(gaps.length / 2)];
    const posG = a.filter((x) => x.gap > 0).length;
    const r30s = a.filter((x) => x.r30 !== null);
    const posR30 = r30s.filter((x) => x.r30! > 0).length;
    const posOC = a.filter((x) => x.rOC > 0).length;
    const meanG = a.reduce((s, x) => s + x.gap, 0) / a.length;
    console.log(`  ${label}: ${a.length}건 — 갭+ ${Math.round((100 * posG) / a.length)}%·평균 ${meanG >= 0 ? "+" : ""}${meanG.toFixed(2)}%·중앙 ${med >= 0 ? "+" : ""}${med.toFixed(2)}% | 시초30분+ ${r30s.length ? Math.round((100 * posR30) / r30s.length) + "%(" + r30s.length + ")" : "—"} | 익일 시→종+ ${Math.round((100 * posOC) / a.length)}%`);
  };
  console.log(`\n════ ${name} — 애프터 확정 방향별 다음날 (표본 ${all.length}일) ════`);
  stat(groups.leverage, "상방 확정");
  stat(groups.inverse, "하방 확정");
  stat(groups.none, "추세없음 ");
  stat(all, "전체 기준선");
}

async function main() {
  const [ssDailyFull, hxDailyFull] = await Promise.all([fetchDailyPredict("005930", 400), fetchDailyPredict("000660", 400)]);
  const ss = await ssVerdicts();
  const hx = await hxVerdicts();
  analyze("삼전 (트래킹 시딩 판정)", "005930", ss, ssDailyFull);
  analyze("하닉 (NXA 캐시 재계산)", "000660", hx, hxDailyFull);
}
main().catch((e) => { console.error(e); process.exit(1); });
