// Alpaca 무료 계좌로 SOXX 1분봉 장기 수집 (사용자 확정 2026-08-03 — 검증 데이터 1년+):
//   npx tsx scripts/alpaca-soxx-1m-cache.ts [--symbol SOXX] [--days 400]
// 필요 환경변수 (.env.local): ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (Paper 계좌 키로 충분 — 미입금 무관)
// 무료 티어 = IEX 피드 (전체 체결의 일부만 집계 — 유동성 높은 SOXX는 사용 가능하나 OHLC가 SIP보다
// 소폭 좁을 수 있음). 수집 후 최근 30일을 야후 1분봉과 교차검증(quality 리포트)해 사용 여부 판단.
// 저장: .predict-cache/SOXXA-YYYY-MM-DD.json (ET 날짜별 · UsBar 형태 {etMin,time,open,high,low,close,volume})
// 기존 파일은 건너뜀 — 재수집은 파일 삭제 후.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const args = process.argv.slice(2);
const argOf = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const SYMB = argOf("--symbol") ?? "SOXX";
const DAYS = parseInt(argOf("--days") ?? "400", 10);
const KEY = process.env.ALPACA_API_KEY_ID;
const SEC = process.env.ALPACA_API_SECRET_KEY;
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

type Bar = { etMin: number; time: string; open: number; high: number; low: number; close: number; volume: number };

async function main() {
  if (!KEY || !SEC) {
    console.log("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY가 .env.local에 없습니다.");
    console.log("가입: https://alpaca.markets → Sign up(무료) → 대시보드 좌측 'API Keys'(Paper) → Generate → 두 값을 .env.local에 추가.");
    process.exit(1);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const start = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const end = new Date(Date.now() - 20 * 60e3).toISOString(); // 최근 15분 제한 여유
  const byDay = new Map<string, Bar[]>();
  let pageToken = "", pages = 0, rows = 0;
  for (;;) {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${SYMB}/bars`);
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("limit", "10000");
    url.searchParams.set("adjustment", "split");
    url.searchParams.set("feed", "iex");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const r = await fetch(url, { headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC } });
    if (r.status === 429) { console.log("  레이트리밋 — 20초 대기"); await sleep(20_000); continue; }
    if (!r.ok) { console.log(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
    const j = (await r.json()) as { bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[]; next_page_token?: string | null };
    for (const b of j.bars ?? []) {
      const d = new Date(b.t);
      const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
      const day = `${p.year}-${p.month}-${p.day}`;
      const etMin = (parseInt(p.hour === "24" ? "0" : p.hour, 10)) * 60 + parseInt(p.minute, 10);
      const arr = byDay.get(day) ?? [];
      arr.push({ etMin, time: `${String(Math.floor(etMin / 60)).padStart(2, "0")}:${String(etMin % 60).padStart(2, "0")}`, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      byDay.set(day, arr);
      rows++;
    }
    pages++;
    if (pages % 10 === 0) console.log(`  수집 page ${pages} — ${rows.toLocaleString()}봉`);
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
    await sleep(350);
  }
  let saved = 0, skipped = 0;
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    const f = resolve(CACHE_DIR, `${SYMB}A-${day}.json`);
    if (existsSync(f)) { skipped++; continue; }
    const bars = byDay.get(day)!.sort((a, b) => a.etMin - b.etMin);
    writeFileSync(f, JSON.stringify(bars));
    saved++;
  }
  console.log(`완료: ${rows.toLocaleString()}봉 · ${days.length}일 (${days[0]} ~ ${days[days.length - 1]}) — 저장 ${saved}·기존 ${skipped}`);
  // 세션 커버 요약 (첫·마지막 봉 시각 분포)
  const firsts = days.map((d) => byDay.get(d)![0]?.etMin ?? 0);
  const lasts = days.map((d) => { const a = byDay.get(d)!; return a[a.length - 1]?.etMin ?? 0; });
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  console.log(`세션 커버 중앙값: ${fmt(med(firsts))} ~ ${fmt(med(lasts))} ET · 일평균 ${Math.round(rows / days.length)}봉`);
  console.log(`다음 단계: 야후 1분봉(최근 30일)과 교차검증 후 1년 검증 스윕 실행.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
