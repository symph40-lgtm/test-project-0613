// 사례 메모리 정량 특징 10.5년 백필 (docs/predict-daily-case-memory.md — 사용자 승인 2026-07-28).
//   npx tsx scripts/case-backfill.ts
// features: 삼전·하닉 갭%·등락% (KRX 일봉) + 간밤 SOX·전일 환율·10Y·DXY (야후 — env-axis-grading과
// 동일한 't일 15:05가 아는 값' 프레임). cause 텍스트는 백필 불가 — 가동일부터 축적.
// next_ss/next_hx 익일 수익도 함께 기입. 기존 live 행은 건드리지 않음 (backfill만 upsert).

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { createClient } from "@supabase/supabase-js";
import { fetchDailyPredict } from "../lib/predict/data";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
type Series = { date: string; close: number }[];
async function daySeries(symbol: string, days: number): Promise<Series> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((q) => q.close != null && isFinite(q.close as number))
    .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close as number }));
}
// t일 15:05가 아는 마지막 두 값 (kstDate 이전 종가 2개)
function lastTwoBefore(s: Series, kstDate: string): [number, number] | null {
  for (let i = s.length - 1; i >= 1; i--) if (s[i].date < kstDate) return [s[i].close, s[i - 1].close];
  return null;
}
const norm10y = (v: number) => (v > 20 ? v / 10 : v);

async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const probe = await admin.from("predict_case_days").select("date").limit(1);
  if (probe.error) { console.error("마이그레이션 032 미적용:", probe.error.message); process.exit(1); }

  const [ss, hx, sox, fx, tnx, dxy] = await Promise.all([
    fetchDailyPredict("005930", 2600), fetchDailyPredict("000660", 2600),
    daySeries("^SOX", 4300), daySeries("KRW=X", 4300), daySeries("^TNX", 4300), daySeries("DX-Y.NYB", 4300),
  ]);
  const okBar = (b: { open: number; close: number }) => b.open > 0 && b.close > 0;
  const hxByDate = new Map(hx.map((b, i) => [b.date, i]));
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  const { data: existing } = await admin.from("predict_case_days").select("date, source");
  const liveDates = new Set((existing ?? []).filter((r) => r.source === "live").map((r) => r.date as string));

  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < ss.length; i++) {
    const d = ss[i].date;
    if (d >= today || liveDates.has(d)) continue; // 오늘·live 행은 제외
    if (!okBar(ss[i]) || !okBar(ss[i - 1])) continue;
    const hi = hxByDate.get(d);
    const soxT = lastTwoBefore(sox, d), fxT = lastTwoBefore(fx, d), tnxT = lastTwoBefore(tnx, d), dxyT = lastTwoBefore(dxy, d);
    const hxOk = hi !== undefined && hi >= 1 && okBar(hx[hi]) && okBar(hx[hi - 1]);
    rows.push({
      date: d,
      features: {
        ssGap: ((ss[i].open - ss[i - 1].close) / ss[i - 1].close) * 100,
        ssChg: ((ss[i].close - ss[i - 1].close) / ss[i - 1].close) * 100,
        hxGap: hxOk ? ((hx[hi!].open - hx[hi! - 1].close) / hx[hi! - 1].close) * 100 : null,
        hxChg: hxOk ? ((hx[hi!].close - hx[hi! - 1].close) / hx[hi! - 1].close) * 100 : null,
        sox: soxT ? ((soxT[0] - soxT[1]) / soxT[1]) * 100 : null,
        fxChg: fxT ? ((fxT[0] - fxT[1]) / fxT[1]) * 100 : null,
        y10pp: tnxT ? norm10y(tnxT[0]) - norm10y(tnxT[1]) : null,
        dxyChg: dxyT ? ((dxyT[0] - dxyT[1]) / dxyT[1]) * 100 : null,
      },
      next_ss: i + 1 < ss.length && okBar(ss[i + 1]) ? ((ss[i + 1].close - ss[i].close) / ss[i].close) * 100 : null,
      next_hx: hxOk && hi! + 1 < hx.length && okBar(hx[hi! + 1]) ? ((hx[hi! + 1].close - hx[hi!].close) / hx[hi!].close) * 100 : null,
      source: "backfill",
      updated_at: new Date().toISOString(),
    });
  }

  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin.from("predict_case_days").upsert(chunk, { onConflict: "date" });
    if (error) { console.error("upsert 실패:", error.message); process.exit(1); }
    done += chunk.length;
  }
  console.log(`백필 완료: ${done}일 (${rows[0]?.date} ~ ${rows[rows.length - 1]?.date})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
