// TIGER 반도체TOP10(396500) 분봉 캐시 수집 (사용자 지시 2026-07-28 밤 — 국내판 SOXX 검토).
//   npx tsx scripts/etf-minute-cache.ts [--code 396500] [--days 120]
// KIS 일별 분봉(120일 한도)을 .predict-cache/{code}-{date}.json으로 저장 (기존 캐시 규약 동일).
// NXT 프리장은 ETF 미거래(2026-07-28 실측)라 정규장만.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes } from "../lib/predict/kisMinute";

const args = process.argv.slice(2);
const CODE = (() => { const i = args.indexOf("--code"); return i >= 0 ? args[i + 1] : "396500"; })();
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 120; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(CODE, DAYS + 10)).filter((b) => b.date <= today);
  const dates = daily.map((b) => b.date).slice(-DAYS);
  let saved = 0, skipped = 0, failed = 0;
  for (const d of dates) {
    const file = resolve(CACHE_DIR, `${CODE}-${d}.json`);
    if (existsSync(file)) { skipped++; continue; }
    const bars = await fetchDayMinutes(CODE, d.replace(/-/g, ""), "153000");
    if (bars && bars.length >= 200) { writeFileSync(file, JSON.stringify(bars)); saved++; }
    else failed++;
    if ((saved + failed) % 20 === 0) console.log(`진행 ${saved + failed + skipped}/${dates.length} (저장 ${saved}·실패 ${failed})`);
  }
  console.log(`완료: 저장 ${saved} · 기존 ${skipped} · 실패 ${failed} (${dates[0]} ~ ${dates[dates.length - 1]})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
