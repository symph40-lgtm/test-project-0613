// 일봉 스윙 — 외인·기관 수급 예측가치 검증. 기획: docs/predict-daily-spec.md 6장.
//   npx tsx scripts/daily-swing-flow.ts [--pages 140]
//
// 소스: 네이버 종목별 외인·기관 일별 매매동향 (finance.naver.com/item/frgn) — 10년치 확정 일별.
// ⚠ 시점 주의: 외인 확정치는 장 마감 후 저녁 발표 → 15:05 마감 판정이 아는 건 "전일까지".
//   전일까지 버전(실운영 가능)과 당일 포함 버전(잠정치 연동 시 상한선) 둘 다 채점.
// 캐시: .predict-cache/frgn-<code>.json — 재실행 시 무통신.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { fetchDailyPredict } from "../lib/predict/data";
import type { PredictDailyBar } from "../lib/predict/types";
import { MODELS } from "./daily-swing-models";

const WARMUP = 260, BUY = 0.00015, SELL = 0.00215;
const args = process.argv.slice(2);
const PAGES = (() => { const i = args.indexOf("--pages"); return i >= 0 ? parseInt(args[i + 1], 10) : 140; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");

type FlowDay = { date: string; frgn: number; inst: number }; // 순매매량 (주)

async function fetchFrgn(code: string): Promise<FlowDay[]> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = resolve(CACHE_DIR, `frgn-${code}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as FlowDay[];
      if (cached.length > 1000) return cached;
    } catch { /* 재수집 */ }
  }
  const byDate = new Map<string, FlowDay>();
  for (let p = 1; p <= PAGES; p++) {
    const res = await fetch(`https://finance.naver.com/item/frgn.naver?code=${code}&page=${p}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
    });
    if (!res.ok) break;
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    // 행 파싱 (2026-07 실측 마크업): 날짜는 <td class="tc"><span>yyyy.mm.dd</span>,
    // 기관 순매매량은 width="66" 셀, 외인 순매매량은 width="80" 셀 — 부호(+/-) 항상 표기.
    const rowRe = /<tr onMouseOver[\s\S]*?<\/tr>/g;
    let m: RegExpExecArray | null;
    let found = 0;
    while ((m = rowRe.exec(html)) !== null) {
      const row = m[0];
      const d = row.match(/(\d{4})\.(\d{2})\.(\d{2})/);
      const instM = row.match(/width="66"[^>]*>[\s\S]*?([+\-][\d,]+)/);
      const frgnM = row.match(/width="80"[^>]*>[\s\S]*?([+\-][\d,]+)/);
      if (!d || !instM || !frgnM) continue;
      const date = `${d[1]}-${d[2]}-${d[3]}`;
      const inst = parseFloat(instM[1].replace(/,/g, ""));
      const frgn = parseFloat(frgnM[1].replace(/,/g, ""));
      if (!isFinite(inst) || !isFinite(frgn)) continue;
      if (!byDate.has(date)) byDate.set(date, { date, frgn, inst });
      found++;
    }
    if (found === 0) break; // 페이지 끝
    await new Promise((r) => setTimeout(r, 150));
  }
  const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length > 0) writeFileSync(file, JSON.stringify(rows));
  return rows;
}

// KOSPI200 선물 투자자별 일자별 순매수 (네이버 sise/investorDealTrendDay, sosok=03, 단위: 계약)
async function fetchFutFlow(): Promise<{ date: string; frgnFut: number }[]> {
  const file = resolve(CACHE_DIR, `futflow.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as { date: string; frgnFut: number }[];
      if (cached.length > 1000) return cached;
    } catch { /* 재수집 */ }
  }
  const byDate = new Map<string, number>();
  for (let p = 1; p <= 400; p++) {
    const res = await fetch(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=20991231&sosok=03&page=${p}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
    });
    if (!res.ok) break;
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    // 행: <td class="date2">26.07.21</td> 다음 셀 순서 [개인, 외국인, 기관계, ...]
    const rowRe = /<td class="date2">(\d{2})\.(\d{2})\.(\d{2})<\/td>([\s\S]*?)<\/tr>/g;
    let m: RegExpExecArray | null;
    let found = 0, oldest = "9999-99-99";
    while ((m = rowRe.exec(html)) !== null) {
      const date = `20${m[1]}-${m[2]}-${m[3]}`;
      const nums = [...m[4].matchAll(/<td class="rate_(?:up|down)3">([+\-]?[\d,]+)<\/td>/g)].map((x) => parseFloat(x[1].replace(/,/g, "")));
      if (nums.length < 2 || !isFinite(nums[1])) continue;
      if (!byDate.has(date)) byDate.set(date, nums[1]); // [0]=개인, [1]=외국인
      found++;
      if (date < oldest) oldest = date;
    }
    if (found === 0 || oldest < "2015-06-01") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const rows = [...byDate.entries()].map(([date, frgnFut]) => ({ date, frgnFut })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length > 0) writeFileSync(file, JSON.stringify(rows));
  return rows;
}

function simGate(bars: PredictDailyBar[], from: number, to: number, base: (i: number) => number, mult: (i: number) => number): { cum: number; mdd: number } {
  let V = 1, peakV = 1, mdd = 0, f = 0;
  for (let i = from; i < to; i++) {
    let target = base(i);
    if (target > 0) target *= mult(i);
    if (target !== f) { const d = target - f; V *= 1 - (d > 0 ? d * BUY : -d * SELL); f = target; }
    V *= 1 + f * (bars[i + 1].close / bars[i].close - 1);
    peakV = Math.max(peakV, V); mdd = Math.max(mdd, 1 - V / peakV);
  }
  return { cum: (V - 1) * 100, mdd: mdd * 100 };
}

async function main() {
  const futFlow = await fetchFutFlow();
  const futByDate = new Map(futFlow.map((f) => [f.date, f.frgnFut]));
  console.log(`선물 외인 이력 ${futFlow.length}일 (${futFlow[0]?.date}~${futFlow[futFlow.length - 1]?.date})`);

  for (const sym of ["005930", "000660"]) {
    const [bars, flow] = [await fetchDailyPredict(sym, 2600), await fetchFrgn(sym)];
    const n = bars.length;
    const flowByDate = new Map(flow.map((f) => [f.date, f]));
    const frgn: (number | null)[] = bars.map((b) => flowByDate.get(b.date)?.frgn ?? null);
    const min = MODELS.find((m) => m.id === "minervini")!.run(bars);
    const p1 = (i: number) => (min[i] === "long" ? 1 : 0);
    const covered = frgn.filter((v) => v !== null).length;
    console.log(`\n■ ${sym} — 수급 이력 ${flow.length}일 (${flow[0]?.date}~${flow[flow.length - 1]?.date}), 일봉 매칭 ${covered}/${n}`);

    // 누적 헬퍼: k일 합 (endIdx 포함), null 있으면 null
    const cum = (endIdx: number, k: number): number | null => {
      let s = 0;
      for (let j = endIdx - k + 1; j <= endIdx; j++) {
        if (j < 0 || frgn[j] === null) return null;
        s += frgn[j]!;
      }
      return s;
    };

    // A. 정보가치: 외인 수급 상태별 익일 방향 (전일까지 확정 = cum(i-1,k))
    for (const w of [{ name: "전체", from: WARMUP }, { name: "최근 3년", from: Math.max(WARMUP, n - 2 - 750) }]) {
      const last = n - 2;
      let baseUp = 0, baseN = 0;
      const st: Record<string, { up: number; n: number }> = { "전일외인 매수": { up: 0, n: 0 }, "전일외인 매도": { up: 0, n: 0 }, "3일누적 매수": { up: 0, n: 0 }, "3일누적 매도": { up: 0, n: 0 } };
      for (let i = w.from; i <= last; i++) {
        const r1 = bars[i + 1].close / bars[i].close - 1;
        if (r1 === 0) continue;
        baseN++; if (r1 > 0) baseUp++;
        const f1 = frgn[i - 1] ?? null; // 전일 확정
        const c3 = cum(i - 1, 3);
        if (f1 !== null) { const k = f1 > 0 ? "전일외인 매수" : "전일외인 매도"; st[k].n++; if (r1 > 0) st[k].up++; }
        if (c3 !== null) { const k = c3 > 0 ? "3일누적 매수" : "3일누적 매도"; st[k].n++; if (r1 > 0) st[k].up++; }
      }
      console.log(`  [${w.name}] 기준 익일 상승률 ${((100 * baseUp) / baseN).toFixed(1)}%`);
      for (const [k, v] of Object.entries(st)) if (v.n > 0) console.log(`    ${k.padEnd(10)} n=${String(v.n).padStart(4)}  익일 상승 ${((100 * v.up) / v.n).toFixed(1)}%`);
    }

    // B. P1 위 수급 게이트 (전일까지 버전 = 실운영 가능 / 당일 포함 = 잠정치 연동 상한)
    const fut: (number | null)[] = bars.map((b) => futByDate.get(b.date) ?? null);
    const futCum = (endIdx: number, k: number): number | null => {
      let s = 0;
      for (let j = endIdx - k + 1; j <= endIdx; j++) {
        if (j < 0 || fut[j] === null) return null;
        s += fut[j]!;
      }
      return s;
    };
    const rules: { name: string; mult: (i: number) => number }[] = [
      { name: "기준 P1 (수급 없음)", mult: () => 1 },
      { name: "전일까지 3일누적 매도 → 절반", mult: (i) => { const c = cum(i - 1, 3); return c !== null && c < 0 ? 0.5 : 1; } },
      { name: "전일까지 3일연속 매도 → 현금", mult: (i) => (frgn[i - 1] !== null && frgn[i - 2] !== null && frgn[i - 3] !== null && frgn[i - 1]! < 0 && frgn[i - 2]! < 0 && frgn[i - 3]! < 0 ? 0 : 1) },
      { name: "전일까지 5일누적 매도 → 절반", mult: (i) => { const c = cum(i - 1, 5); return c !== null && c < 0 ? 0.5 : 1; } },
      { name: "당일포함 3일누적 매도 → 절반", mult: (i) => { const c = cum(i, 3); return c !== null && c < 0 ? 0.5 : 1; } },
      { name: "당일포함 당일 매도 → 절반", mult: (i) => (frgn[i] !== null && frgn[i]! < 0 ? 0.5 : 1) },
      { name: "선물: 전일까지 3일누적 매도 → 절반", mult: (i) => { const c = futCum(i - 1, 3); return c !== null && c < 0 ? 0.5 : 1; } },
      { name: "선물: 당일 매도(장중 잠정) → 절반", mult: (i) => (fut[i] !== null && fut[i]! < 0 ? 0.5 : 1) },
      { name: "선물: 당일포함 3일누적 매도 → 절반", mult: (i) => { const c = futCum(i, 3); return c !== null && c < 0 ? 0.5 : 1; } },
      { name: "현물+선물 동반 당일 매도 → 절반", mult: (i) => (fut[i] !== null && frgn[i] !== null && fut[i]! < 0 && frgn[i]! < 0 ? 0.5 : 1) },
    ];
    for (const w of [{ name: "전체", from: WARMUP }, { name: "최근 3년", from: Math.max(WARMUP, n - 1 - 750) }]) {
      console.log(`  [${w.name}] P1 수급 게이트:`);
      for (const r of rules) {
        const s = simGate(bars, w.from, n - 1, p1, r.mult);
        console.log(`    ${r.name.padEnd(24)} 누적 ${s.cum >= 0 ? "+" : ""}${s.cum.toFixed(0)}%  MDD ${s.mdd.toFixed(0)}%`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
