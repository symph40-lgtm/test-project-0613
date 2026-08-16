// MT T1 데이터 조달 판정 — 재현 스크립트 (g1br/src/audit_probe.py의 MT판).
//   npx tsx scripts/mt-audit-probe.ts
// 판정 원칙: "실제로 받아본 것만 조달 성공". 값이 아니라 조달 가능 여부·이력 길이·결측을 본다.
// 결과는 docs/mt-audit-t1.md 표의 원천이다 — 표를 고치기 전에 이 스크립트를 먼저 돌린다.

import { readFileSync } from "fs";
import { resolve } from "path";
try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* .env 없이도 시세 소스 항목은 돈다 */ }

const NAVER = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://m.stock.naver.com/" };

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

async function fchart(symbol: string, count: number): Promise<Bar[]> {
  const res = await fetch(`https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`, {
    headers: NAVER, cache: "no-store",
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const bars: Bar[] = [];
  for (const m of xml.matchAll(/<item data="([^"]+)"/g)) {
    const [d, o, h, l, c, v] = m[1].split("|");
    if (!/^\d{8}$/.test(d)) continue;
    const bar = { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, open: +o, high: +h, low: +l, close: +c, volume: +v };
    if ([bar.open, bar.high, bar.low, bar.close].every(isFinite)) bars.push(bar);
  }
  return bars;
}

async function main() {
  const out: string[] = [];
  const say = (s: string) => { console.log(s); out.push(s); };

  say("── 1. 국면 판별·패널 원천 (일봉 OHLCV) ──");
  for (const sym of ["005930", "000660", "KPI200"]) {
    const b = await fchart(sym, 2000);
    const volBad = b.filter((x) => !isFinite(x.volume) || x.volume <= 0).length;
    const gapNaN = b.filter((x) => !(x.high >= x.low)).length;
    say(`fchart ${sym}: n=${b.length} ${b[0]?.date}~${b[b.length - 1]?.date} · 거래량 결측 ${volBad} · OHLC 이상 ${gapNaN}`);
  }

  say("── 2. C1 재료 판별 원천 ──");
  const yfMod = await import("yahoo-finance2");
  const yf = new yfMod.default({ suppressNotices: ["yahooSurvey"] });
  for (const s of ["^SOX", "^IXIC"]) {
    try {
      const r = await yf.chart(s, { period1: new Date("2023-01-01"), interval: "1d" });
      const q = (r.quotes ?? []).filter((x) => x.close != null);
      const d = (x: { date: Date | number }) => (x.date instanceof Date ? x.date : new Date(x.date)).toISOString().slice(0, 10);
      say(`yahoo ${s}: n=${q.length} ${d(q[0])}~${d(q[q.length - 1])}`);
    } catch (e) { say(`yahoo ${s}: 실패 ${(e as Error).message.slice(0, 80)}`); }
  }
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data } = await createAdminClient().from("predict_case_days").select("date")
      .not("cause_text", "is", null).order("date", { ascending: true });
    const rows = (data ?? []) as { date: string }[];
    say(`predict_case_days.cause_text: n=${rows.length} ${rows[0]?.date ?? "-"}~${rows[rows.length - 1]?.date ?? "-"} (백필 불가 — 가동일부터 축적)`);
  } catch (e) { say(`predict_case_days: 조회 실패 ${(e as Error).message.slice(0, 80)}`); }

  say("── 3. 보조 부품 원천 ──");
  try {
    const res = await fetch("https://finance.naver.com/sise/sise_index.naver?code=KOSPI", { headers: { "User-Agent": NAVER["User-Agent"] }, cache: "no-store" });
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    const grab = (label: string) => html.match(new RegExp(`${label}[\\s\\S]{0,120}?<span>([\\d,]+)`))?.[1] ?? null;
    say(`등락종목수(C4): 상승 ${grab("상승종목수")} · 하락 ${grab("하락종목수")} — 실시간 단면만, 이력 API 없음`);
  } catch { say("등락종목수(C4): 실패"); }
  for (const code of ["VKOSPI", "VKOSPI200"]) {
    const res = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/index/${code}`, { headers: NAVER, cache: "no-store" });
    const j = (await res.json()) as { datas?: unknown[] };
    say(`VKOSPI(${code}): datas ${j.datas?.length ?? 0}건 — ${j.datas?.length ? "조달" : "미조달"}`);
  }
  try {
    const { fetchRecentFlow } = await import("@/lib/predict-daily/flow");
    const f = await fetchRecentFlow("005930");
    say(`외인 수급(C5·F08): n=${f.length} ${f[0]?.date}~${f[f.length - 1]?.date} — 네이버 frgn 1페이지 한도`);
  } catch (e) { say(`외인 수급: 실패 ${(e as Error).message.slice(0, 80)}`); }

  say("── 4. 정본 대사 (fchart vs pykrx 파케이) ──");
  say("g1br/data/raw/*.parquet 대사 결과는 docs/mt-audit-t1.md §2 참조 (795일 겹침·종가 불일치 0).");
}

main();
