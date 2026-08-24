// SOXX 프리장 정체값 소급 정정 (발주자 지적 2026-08-24 20:06) — 1회성 실행 스크립트 (증거 보존용 커밋)
//   npx tsx scripts/g1-soxx-pre-correct-0824.ts
//
// 결함: dayChange가 프리마켓 중 regularMarketChangePercent(직전 정규장 마감 등락률)를 반환 —
//   8/24 밤 봉(19:50~)에 금요일 마감 −0.44%가 당일 값처럼 기록됨. 실제 프리장 라이브는 −2.1%대.
// 정정: 야후 1분봉(includePrePost)에서 해당 시각 실제 프리장 체결가 → 전일 종가 대비 %로 교체.
//   원칙: corrected=true + 원기록(soxx_orig) 보존. 과거 밤들(8/20~8/22)의 프리장 정체값은 이 결함의
//   동일 사례지만 화면 병기 전용·판정 무접촉이라 발주자 판정 전 소급 범위 확대 없음 (8/24 밤만).
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const SESSION_NIGHT = "2026-08-24";
const STALE = -0.44; // 금요일 정규장 마감 등락률 (정체값 식별용)

async function main() {
  const YahooFinance = (await import("yahoo-finance2")).default;
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - 2 * 86400e3), interval: "1m", includePrePost: true }) as {
    meta?: { chartPreviousClose?: number }; quotes?: { date: Date; close?: number | null }[];
  };
  const prevClose = r.meta?.chartPreviousClose;
  if (typeof prevClose !== "number") throw new Error("chartPreviousClose 없음");
  const quotes = (r.quotes ?? []).filter((q) => q.close != null) as { date: Date; close: number }[];
  const pctAtKst = (hhmm: string): number | null => {
    // KST hhmm (당일) → UTC = KST − 9h
    const tgt = new Date(`${SESSION_NIGHT}T${hhmm}:00+09:00`).getTime();
    let best: { d: number; pct: number } | null = null;
    for (const q of quotes) {
      const dt = tgt - q.date.getTime();
      if (dt < 0 || dt > 15 * 60e3) continue; // 해당 시각 직전 15분 내 마지막 체결
      const cand = { d: dt, pct: Math.round((q.close / prevClose - 1) * 10000) / 100 };
      if (!best || cand.d < best.d) best = cand;
    }
    return best?.pct ?? null;
  };

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  for (const symbol of ["005930", "000660"]) {
    const row = await admin.from("g1a_days").select("t2").eq("date", SESSION_NIGHT).eq("symbol", symbol).maybeSingle();
    const t2 = row.data?.t2 as Record<string, unknown> | null;
    const nf = t2?.nf as { bars?: Record<string, unknown>[] } | undefined;
    if (!t2 || !nf?.bars) { console.log(symbol, "행/봉 없음 — 건너뜀"); continue; }
    let n = 0;
    for (const b of nf.bars) {
      if (b.soxx !== STALE || b.soxx_corrected) continue;
      const live = pctAtKst(String(b.t));
      b.soxx_orig = STALE; b.soxx_corrected = true;
      if (live != null) b.soxx = live; else delete b.soxx; // 라이브 체결 없으면 null 처리 (정체값 제거)
      n++;
      console.log(symbol, b.t, "정정:", STALE, "→", live ?? "null(제거)");
    }
    if (n > 0) {
      const up = await admin.from("g1a_days").update({ t2 }).eq("date", SESSION_NIGHT).eq("symbol", symbol);
      if (up.error) throw new Error(`${symbol} 저장 실패: ${up.error.message}`);
    }
    console.log(symbol, `정정 ${n}건 저장`);
  }
}
main().catch((e) => { console.error("실패:", e); process.exit(1); });
