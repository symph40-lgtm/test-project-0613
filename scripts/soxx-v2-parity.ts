// SOXX 신모델 v2 parity — 라이브 모듈(lib/signal/us/soxxV2)을 SOXXM 245일에 돌려 백테스트 확정치와 대조:
//   npx tsx scripts/soxx-v2-parity.ts
// 기준치 (커밋 4d220ca·b195960·a24f012): 창1 선행 186일 수정안 +78.2%p · F 선행 59일 E1 1박 +36.2%p
//   → 통합 +114.4%p / 역진입판 +73.1 + 36.2 = +109.3%p. 최악일 -4.1%(수정안).
// 일치하면 라이브 산식 = 연구 산식 보증 (독립 재구현 대조 — 창1·F·수정안·1박 전 부품).

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import type { PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));

  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  let n = 0, nCw = 0, nF = 0, pCw = 0, pF = 0, pReCw = 0, pReF = 0, worst = 0, cuts = 0, ovnN = 0, pRebox = 0, pProt = 0, pMain = 0;
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue; // 백테스트와 동일 필터
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10);
    if (!c1 && !fJ) continue;
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const sc = scoreSoxxDay(raw, c1, fJ, reg[reg.length - 1].close, nextOpen);
    n++;
    if (sc.kind === "cw") { nCw++; pCw += sc.p; pReCw += sc.pRe; }
    if (sc.kind === "f") { nF++; pF += sc.p; pReF += sc.pRe; }
    if (sc.cut) cuts++;
    if (sc.ovn) ovnN++;
    worst = Math.min(worst, sc.p);
    const jR = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 }); // 라이브 주기준 (8/4 채택)
    pRebox += scoreSoxxDay(raw, jR.c1, jR.fJ, reg[reg.length - 1].close, nextOpen).p;
    pProt += scoreSoxxDay(raw, jR.c1, jR.fJ, reg[reg.length - 1].close, nextOpen, true).p; // rebox+인버 보호 (8/4)
    pMain += scoreSoxxDay(raw, jR.c1, jR.fJ, reg[reg.length - 1].close, nextOpen, true, true).p; // + 프리장 확인가 진입 (8/5 주기준)
  }
  console.log(`════ SOXX v2 parity (SOXXM ${n}일) ════`);
  console.log(`창1 선행 ${nCw}일: 수정안 ${s1(pCw)}%p (기준 +78.2/186일) · 역진입판 ${s1(pReCw)} (기준 +73.1)`);
  console.log(`F 선행  ${nF}일: E1 1박 ${s1(pF)}%p (기준 +36.2/59일)`);
  console.log(`통합: 수정안 ${s1(pCw + pF)}%p (기준 +114.4) · 역진입판 ${s1(pReCw + pReF)} (기준 +109.3)`);
  console.log(`rebox판: ${s1(pRebox)}%p (245일 기준 +117.8 — soxx-f-rebox-sweep. 캐시 증가 시 당일분만큼 이동)`);
  console.log(`rebox+인버보호: ${s1(pProt)}%p (246일 기준 +130.9 — soxx-open-protect-sweep C·T0.9)`);
  console.log(`rebox+보호+프리장 확인가 진입(라이브 주기준): ${s1(pMain)}%p (246일 기준 +141.6 — soxx-pre-entry-sweep)`);
  console.log(`컷 ${cuts}일 · 1박 ${ovnN}일 · 최악일 ${worst.toFixed(2)}% (기준 -4.1)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
