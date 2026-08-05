// SOXX 밤 구간(블루오션 ATS, EXCD=BAQ) 1분봉 수집기 (사용자 지시 2026-08-06 새벽 후속 — "장이 바뀌는
// 순간 재점검": 1박 밤 조기청산 규칙을 실측 검증하려면 밤 경로 데이터가 필요. KIS BAQ 소급 ~30일이라
// **주 1회 이상 실행해 롤링 축적** — 30~60일 모이면 밤 트레일/체크포인트 청산 스윕 실행):
//   npx tsx scripts/kis-baq-soxx-cache.ts
// 저장: .predict-cache/soxx-baq-1m.json (기존과 병합·d+t 중복 제거 — 실행할수록 이력 누적).
// 참고: BAQ 시간대는 KIS 원시(xymd/xhms) 그대로 저장 — 분석 시 ET 변환은 us-predict-backtest의
// kisToBars 정합 방식(야후 겹침 구간 대조)을 따를 것.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const KIS_BASE = "https://openapi.koreainvestment.com:9443";
const CACHE = resolve(process.cwd(), ".predict-cache", "soxx-baq-1m.json");
type Row = { d: string; t: string; o: number; h: number; l: number; c: number; v: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function kisToken(): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    });
    if (r.ok) { const j = (await r.json()) as { access_token?: string }; if (j.access_token) return j.access_token; }
    console.log(`KIS 토큰 재시도(${r.status}) — 65초 대기`);
    await sleep(65_000);
  }
  return null;
}

async function main() {
  const tk = await kisToken();
  if (!tk) { console.error("KIS 토큰 실패"); process.exit(1); }
  const out: Row[] = [];
  let keyb = "", next = "";
  for (let page = 0; page < 400; page++) {
    const url = new URL(`${KIS_BASE}/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice`);
    for (const [k, v] of Object.entries({ AUTH: "", EXCD: "BAQ", SYMB: "SOXX", NMIN: "1", PINC: "1", NEXT: next, NREC: "120", FILL: "", KEYB: keyb })) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { authorization: `Bearer ${tk}`, appkey: process.env.KIS_APP_KEY!, appsecret: process.env.KIS_APP_SECRET!, tr_id: "HHDFS76950200", custtype: "P" } });
    if (r.status === 500) { const t = await r.text(); if (t.includes("EGW00201")) { await sleep(1200); page--; continue; } console.log("KIS 500:", t.slice(0, 120)); break; }
    if (!r.ok) { console.log("KIS HTTP", r.status); break; }
    const j = (await r.json()) as { rt_cd?: string; output2?: { xymd?: string; xhms?: string; open?: string; high?: string; low?: string; last?: string; evol?: string }[] };
    if (j.rt_cd !== "0" || !j.output2?.length) break;
    for (const q of j.output2) {
      const o = parseFloat(q.open ?? ""), h = parseFloat(q.high ?? ""), l = parseFloat(q.low ?? ""), c = parseFloat(q.last ?? "");
      if (![o, h, l, c].every((v) => isFinite(v) && v > 0) || !q.xymd || !q.xhms) continue;
      out.push({ d: `${q.xymd.slice(0, 4)}-${q.xymd.slice(4, 6)}-${q.xymd.slice(6, 8)}`, t: q.xhms, o, h, l, c, v: parseFloat(q.evol ?? "0") || 0 });
    }
    const last = j.output2[j.output2.length - 1];
    const nk = `${last.xymd}${last.xhms}`;
    if (nk === keyb) break;
    keyb = nk; next = "1";
    await sleep(400);
  }
  mkdirSync(resolve(process.cwd(), ".predict-cache"), { recursive: true });
  const prev: Row[] = existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, "utf8")) as Row[]) : [];
  const byKey = new Map(prev.map((r) => [`${r.d}${r.t}`, r]));
  let added = 0;
  for (const r of out) if (!byKey.has(`${r.d}${r.t}`)) { byKey.set(`${r.d}${r.t}`, r); added++; }
  const merged = [...byKey.values()].sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));
  writeFileSync(CACHE, JSON.stringify(merged));
  const days = new Set(merged.map((r) => r.d)).size;
  console.log(`BAQ 수집: 신규 ${added}봉 병합 → 총 ${merged.length}봉·${days}일 (${merged[0]?.d} ~ ${merged[merged.length - 1]?.d})`);
  console.log(`다음: 주 1회 재실행으로 축적 — 30~60일 도달 시 밤 조기청산 규칙 스윕.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
