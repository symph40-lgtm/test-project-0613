// SOXX 병합 1분봉 캐시 생성 (사용자 지시 2026-08-03 밤 — "1분봉으로, 결측(프리장 등)은 잘 나오는 소스로 대체"):
//   npx tsx scripts/soxx-merge-1m.ts
// 기준 = Alpaca(SOXXA-*, IEX — 정규장 97~99%·프리장 희소) → 결측 분을 야후 1분(SIP 통합 — 프리장 조밀,
// 최근 ~30일 한도)으로 채움. KIS 해외 1m은 야후보다 얕아(26일<30일) 생략 — 야후가 '잘 나오는 곳'.
// 산출: .predict-cache/SOXXM-YYYY-MM-DD.json (병합본 — 야후 없는 과거일은 Alpaca 그대로 복사).
// 리포트: 일별 프리장(07:00~09:30)·정규장 커버 before/after.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CACHE = resolve(process.cwd(), ".predict-cache");
type Bar = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

async function main() {
  // 야후 1분 (프리·애프터 포함) — 7일 청크 4개
  const yByDay = new Map<string, Map<number, Bar>>();
  for (let c = 0; c < 4; c++) {
    const p2 = new Date(Date.now() - c * 7 * 86400e3);
    const p1 = new Date(p2.getTime() - 7 * 86400e3);
    try {
      const r = await yf.chart("SOXX", { period1: p1, period2: p2, interval: "1m", includePrePost: true });
      for (const q of r.quotes ?? []) {
        if (q.close == null || q.open == null || q.high == null || q.low == null) continue;
        const d = q.date instanceof Date ? q.date : new Date(q.date);
        const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
        const day = `${p.year}-${p.month}-${p.day}`;
        const etMin = parseInt(p.hour === "24" ? "0" : p.hour, 10) * 60 + parseInt(p.minute, 10);
        const m = yByDay.get(day) ?? new Map<number, Bar>();
        m.set(etMin, { etMin, time: fmtT(etMin), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 });
        yByDay.set(day, m);
      }
    } catch { /* 청크 실패 무시 */ }
    await sleep(400);
  }

  const files = readdirSync(CACHE).filter((f) => /^SOXXA-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  let mergedDays = 0, copiedDays = 0;
  const stats: string[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const a = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as Bar[];
    const y = yByDay.get(date);
    const byMin = new Map<number, Bar>(a.map((b) => [b.etMin, b]));
    if (y) {
      let filled = 0, preBefore = 0, preAfter = 0, regBefore = 0, regAfter = 0;
      for (const b of a) {
        if (b.etMin >= 420 && b.etMin < 570) preBefore++;
        if (b.etMin >= 570 && b.etMin < 960) regBefore++;
      }
      for (const [mMin, yb] of y) {
        if (!byMin.has(mMin)) { byMin.set(mMin, yb); filled++; }
      }
      for (const [mMin] of byMin) {
        if (mMin >= 420 && mMin < 570) preAfter++;
        if (mMin >= 570 && mMin < 960) regAfter++;
      }
      preAfter = [...byMin.keys()].filter((m2) => m2 >= 420 && m2 < 570).length;
      regAfter = [...byMin.keys()].filter((m2) => m2 >= 570 && m2 < 960).length;
      stats.push(`${date}: 프리장 ${preBefore}→${preAfter}/150분 · 정규장 ${regBefore}→${regAfter}/390분 (+${filled}봉 채움)`);
      mergedDays++;
    } else copiedDays++;
    const out = [...byMin.values()].sort((x, z) => x.etMin - z.etMin);
    writeFileSync(resolve(CACHE, `SOXXM-${date}.json`), JSON.stringify(out));
  }
  console.log(`병합 완료: 야후로 보강 ${mergedDays}일 · Alpaca 단독 복사 ${copiedDays}일 (과거일 — 야후 30일 한도 밖)`);
  for (const s of stats) console.log(`  ${s}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
