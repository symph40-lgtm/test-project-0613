// 섹터 페이퍼 트래킹 220일 시딩 — 방산·조선의 10:30 피셔 판정·라벨·손익을 소급 적재.
//   npx tsx scripts/sector-seed.ts   (마이그레이션 028 적용 후, .predict-cache 활용 — 무통신에 가까움)

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { fetchDailyPredict } from "../lib/predict/data";
import { labelDay } from "../lib/predict/label";
import { runFisher } from "../lib/predict/models/fisher";
import type { MinuteBar } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const cacheDir = resolve(process.cwd(), ".predict-cache");
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  for (const sec of PREDICT_CONFIG.sectors) {
    const daily = (await fetchDailyPredict(sec.symbol, 360)).filter((b) => b.date < today);
    const testDays = daily.slice(-220);
    const rows: Record<string, unknown>[] = [];
    for (const bar of testDays) {
      const idx = daily.findIndex((b) => b.date === bar.date);
      if (idx < 30) continue;
      const cut = `${PREDICT_CONFIG.sectorJudgeHour.slice(0, 2)}:${PREDICT_CONFIG.sectorJudgeHour.slice(2, 4)}`;
      const full = resolve(cacheDir, `${sec.symbol}-${bar.date}.json`);
      const part = resolve(cacheDir, `${sec.symbol}-M-${bar.date}.json`); // 오전 전용 캐시 (측정 스크립트 산출)
      const src = existsSync(full) ? full : existsSync(part) ? part : null;
      if (!src) continue;
      const krx = (JSON.parse(readFileSync(src, "utf8")) as MinuteBar[]).filter((b) => b.time < cut);
      if (krx.length < 50) continue;
      const out = runFisher({
        date: bar.date, dailyHistory: daily.slice(Math.max(0, idx - 120), idx),
        openPx: bar.open, morning: krx, prevDayMinutes: null,
      });
      const entry = krx[krx.length - 1].close;
      const { label, rOC } = labelDay(bar);
      const ret = out.verdict !== "none"
        ? Number((((bar.close - entry) / entry) * 100 * (out.verdict === "leverage" ? 1 : -1)).toFixed(2))
        : null;
      rows.push({
        date: bar.date, symbol: sec.symbol, verdict: out.verdict,
        strength: Number((out.confidence * 100).toFixed(0)), entry_px: entry,
        label, r_oc: rOC, ret_pct: ret, source: "backtest", labeled_at: new Date().toISOString(),
      });
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("predict_sector_days").upsert(rows.slice(i, i + 200), { onConflict: "date,symbol" });
      if (error) throw new Error(`${sec.name} 시딩 실패: ${error.message}`);
    }
    const dir = rows.filter((r) => r.verdict !== "none");
    const hit = dir.filter((r) => r.verdict === r.label).length;
    const cum = dir.reduce((s, r) => s + ((r.ret_pct as number) || 0), 0);
    console.log(`${sec.name}: ${rows.length}일 시딩 · 방향 ${hit}/${dir.length} · 누적 ${cum >= 0 ? "+" : ""}${cum.toFixed(1)}%p`);
  }
})();
